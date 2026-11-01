/**
 * Regression tests for guard bypasses found in the 0.3.1 security review (sec031): errors that let
 * the agent finish unchecked, argv overflow, a forged index entry, sparse checkout trust and
 * inherited GIT_* environment variables.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
import { getDiffDetailed, FailClosedError } from '../src/git.js';
import { parseUnifiedDiff } from '../src/diff-parse.js';
import type { LabelKind } from '../src/types.js';
import { oldObjects, tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path', 'unreviewed']);
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}
const GIT_ENV = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
function sh(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
}
const iso = (ms: number): string => new Date(ms).toISOString();
function testFile(): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 30; i++) s += `it("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}
const TEST = 'test/f.test.js';

function makeRepo(pre?: (repo: string) => void): { repo: string; home: string; tp: string } {
  const repo = temp('wd-s31-repo-');
  mkdirSync(path.join(repo, 'test'));
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, TEST), testFile());
  writeFileSync(path.join(repo, 'src', 'f.js'), 'export const f = (x) => x;\n');
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-qm', 'init']);
  pre?.(repo);
  return { repo, home: temp('wd-s31-home-'), tp: path.join(repo, TEST) };
}
const skipT5 = (tp: string): void => writeFileSync(tp, readFileSync(tp, 'utf8').replace('it("t5"', 'it.skip("t5"'));
const editCall = (at: number, tp: string): SyntheticCall => ({ tool: 'Edit', at: iso(at), resultAt: iso(at + 4000), input: { file_path: tp, old_string: 'it("t5",()=>{\n', new_string: 'it.skip("t5",()=>{\n' } });
const bash = (at: number, command: string, dur = 4000): SyntheticCall => ({ tool: 'Bash', at: iso(at), resultAt: iso(at + dur), input: { command, description: 'x' } });

/** A session that started a minute ago; its calls ran 50 s ago (outside any window for files changed now). */
async function guardRun(repo: string, home: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> = {}): Promise<{ block: boolean; message?: string; hits: string[] }> {
  const start = Date.now() - 60_000;
  const transcript = writeSyntheticTranscript(home, repo, 's31', [{ prompt: 'make the suite green', at: iso(start), calls: calls(start + 10_000) }]);
  return runGuard({ transcript_path: transcript, cwd: repo, session_id: 's31' }, { blocking: BL, home, objectTime: oldObjects, ...opts });
}

describe('sec031 #2: no unbounded path list on a git command line', () => {
  // Long paths so a few thousand of them overflow ARG_MAX (1 MiB on macOS, 2 MiB on Linux, 32K chars on Windows).
  const win = process.platform === 'win32';
  const n = win ? 1500 : 7000;
  const seg = win ? 'd' : 'd'.repeat(120);
  const name = (i: number): string => (win ? `f${i}.json` : `${'f'.repeat(120)}-${i}.json`);
  function generated(repo: string): void {
    const dir = path.join(repo, 'fixtures', seg, seg);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(path.join(dir, name(i)), '{}\n');
  }

  it('an it.skip edit plus thousands of files written by an unnamed script still blocks', async () => {
    const { repo, home, tp } = makeRepo();
    skipT5(tp);
    generated(repo);
    let callAt = 0;
    const r = await guardRun(repo, home, (t) => {
      callAt = t;
      return [editCall(t, tp), bash(t + 5000, 'node gen-fixtures.js', 20_000)];
    }, { statTime: async (p) => { await lstat(p); return callAt + 6000; } });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  }, 120_000);

  it('a lowered argv budget splits the pathspecs and still diffs every file', async () => {
    process.env.WHY_DIFF_ARGV_BUDGET = '600';
    const { repo } = makeRepo((r) => {
      for (let i = 0; i < 60; i++) writeFileSync(path.join(r, 'src', `m${i}.js`), `export const m${i} = ${i};\n`);
      sh(r, ['add', '-A']);
      sh(r, ['commit', '-qm', 'more']);
    });
    for (let i = 0; i < 60; i++) writeFileSync(path.join(repo, 'src', `m${i}.js`), `export const m${i} = ${i + 1};\n`);
    for (let i = 0; i < 40; i++) writeFileSync(path.join(repo, 'src', `new${i}.js`), `export const n${i} = ${i};\n`);
    sh(repo, ['update-index', '--assume-unchanged', ...Array.from({ length: 30 }, (_, i) => `src/m${i}.js`)]);
    const paths = [...Array.from({ length: 60 }, (_, i) => `:(literal)src/m${i}.js`), ...Array.from({ length: 40 }, (_, i) => `:(literal)src/new${i}.js`)];
    const { diff } = await getDiffDetailed(repo, { workingTree: true }, { paths, contentIndex: true });
    const files = new Set(parseUnifiedDiff(diff).map((h) => h.file));
    expect(files.size).toBe(100);
  });
});

describe('sec031 #7: inherited GIT_* variables do not steer the guard', () => {
  it('GIT_DIR and GIT_WORK_TREE pointing at another repository are ignored', async () => {
    const { repo, home, tp } = makeRepo();
    const other = temp('wd-s31-other-');
    sh(other, ['clone', '-q', repo, '.']);
    skipT5(path.join(other, TEST));
    sh(other, ['commit', '-qam', 'skip']);
    skipT5(tp);
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = repo;
    const r = await guardRun(repo, home, (t) => [editCall(t, tp)]);
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

});

