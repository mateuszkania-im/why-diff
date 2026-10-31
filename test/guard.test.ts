import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard } from '../src/guard.js';
import type { LabelKind } from '../src/types.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const BLOCKING = new Set<LabelKind>(['test-skip-added', 'assertion-removed', 'secret-like', 'ci-changed']);
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}

function sh(cwd: string, args: string[], date?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}

const SESSION_AT = new Date(Date.now() - 10 * 60_000).toISOString();
const CALL_AT = new Date(Date.now() - 9 * 60_000).toISOString();
const LONG_AGO = new Date(Date.now() - 3600_000).toISOString();

function testFile(): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 30; i++) s += `it("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}

function makeRepo(): { repo: string; home: string; stateDir: string } {
  const repo = temp('why-diff-guard-repo-');
  mkdirSync(path.join(repo, 'test'));
  writeFileSync(path.join(repo, 'test', 'f.test.js'), testFile());
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-qm', 'init'], LONG_AGO);
  return { repo, home: temp('why-diff-guard-home-'), stateDir: temp('why-diff-guard-state-') };
}

function editCall(repo: string, oldS: string, newS: string, at = CALL_AT): SyntheticCall {
  return { tool: 'Edit', at, input: { file_path: path.join(repo, 'test', 'f.test.js'), old_string: oldS, new_string: newS } };
}

function applyEdit(repo: string, oldS: string, newS: string): void {
  const f = path.join(repo, 'test', 'f.test.js');
  const cur = readFileSync(f, 'utf8');
  if (!cur.includes(oldS)) throw new Error('edit target missing');
  writeFileSync(f, cur.replace(oldS, newS));
}

const SKIP_OLD = 'it("t5",()=>{\n';
const SKIP_NEW = 'it.skip("t5",()=>{\n';
const ASSERT_OLD = '  expect(f(2)).toBe(2);\n';
const ASSERT_NEW = '  expect(f(2)).toBe(2);\n  expect(f(2)).not.toBe(3);\n';

describe('runGuard', () => {
  it("does not block on a human's uncommitted it.skip in a file the agent also edited", async () => {
    const { repo, home, stateDir } = makeRepo();
    applyEdit(repo, 'it("t25",()=>{\n', 'it.skip("t25",()=>{\n'); // human, not in transcript
    const transcript = writeSyntheticTranscript(home, repo, 's-human', [{ prompt: 'add an assertion to t2', at: SESSION_AT, calls: [editCall(repo, ASSERT_OLD, ASSERT_NEW)] }]);
    applyEdit(repo, ASSERT_OLD, ASSERT_NEW);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-human' }, { blocking: BLOCKING, home, stateDir });
    expect(r.block).toBe(false);
    expect(r.hits).toEqual([]);
  });

  it("blocks when the agent's own edit adds it.skip", async () => {
    const { repo, home, stateDir } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-own', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-own' }, { blocking: BLOCKING, home, stateDir });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
    expect(r.message).toContain('test-skip-added');
  });

  it('blocks on an agent edit that was committed during the session', async () => {
    const { repo, home, stateDir } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-commit', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    sh(repo, ['commit', '-qam', 'agent commit'], new Date().toISOString());
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-commit' }, { blocking: BLOCKING, home, stateDir });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('does not block twice for the same hits; a new risky edit blocks again', async () => {
    const { repo, home, stateDir } = makeRepo();
    const t1 = writeSyntheticTranscript(home, repo, 's-twice', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const payload = { transcript_path: t1, cwd: repo, session_id: 's-twice' };
    expect((await runGuard(payload, { blocking: BLOCKING, home, stateDir })).block).toBe(true);
    expect((await runGuard(payload, { blocking: BLOCKING, home, stateDir })).block).toBe(false);

    const t2 = writeSyntheticTranscript(home, repo, 's-twice', [{
      prompt: 'fix t5 and t9',
      at: SESSION_AT,
      calls: [editCall(repo, SKIP_OLD, SKIP_NEW), editCall(repo, 'it("t9",()=>{\n', 'it.skip("t9",()=>{\n')],
    }]);
    applyEdit(repo, 'it("t9",()=>{\n', 'it.skip("t9",()=>{\n');
    const r = await runGuard({ ...payload, transcript_path: t2 }, { blocking: BLOCKING, home, stateDir });
    expect(r.block).toBe(true);
  });

  it('creates the state dir with a * .gitignore', async () => {
    const { repo, home } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-ign', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-ign' }, { blocking: BLOCKING, home });
    expect(readFileSync(path.join(repo, '.why-diff', '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(path.join(repo, '.why-diff', 'guard-state.json'))).toBe(true);
  });

  it('returns quietly when stop_hook_active or without transcript_path', async () => {
    const { repo, home, stateDir } = makeRepo();
    expect((await runGuard({ cwd: repo }, { blocking: BLOCKING, home, stateDir })).block).toBe(false);
    const transcript = writeSyntheticTranscript(home, repo, 's-act', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    expect((await runGuard({ transcript_path: transcript, cwd: repo, stop_hook_active: true }, { blocking: BLOCKING, home, stateDir })).block).toBe(false);
  });

  it('never throws outside a git repo', async () => {
    const r = await runGuard({ transcript_path: '/nonexistent.jsonl', cwd: temp('why-diff-guard-nogit-') }, { blocking: BLOCKING });
    expect(r.block).toBe(false);
  });

  it('skips huge untracked files outside the transcript paths', async () => {
    const { repo, home, stateDir } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-big', [{ prompt: 'add an assertion to t2', at: SESSION_AT, calls: [editCall(repo, ASSERT_OLD, ASSERT_NEW)] }]);
    applyEdit(repo, ASSERT_OLD, ASSERT_NEW);
    const big = path.join(repo, 'dump.log');
    writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 'a'));
    try {
      const t0 = Date.now();
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-big' }, { blocking: BLOCKING, home, stateDir });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(r.block).toBe(false);
    } finally {
      rmSync(big, { force: true });
    }
  });
});
