import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globToRegExp, loadConfig, matchGlobs } from '../src/config.js';
import { runGuard } from '../src/guard.js';
import { buildReport } from '../src/pipeline.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const temp = (p: string): string => { const d = realpathSync(tempDir(p)); dirs.push(d); return d; };
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
const sh = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe', env: ENV }); };
const put = (repo: string, rel: string, text: string): void => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };

const LONG_AGO = new Date(Date.now() - 3600_000).toISOString();
const SESSION_AT = new Date(Date.now() - 10 * 60_000).toISOString();
const CALL_AT = new Date(Date.now() - 9 * 60_000).toISOString();

function makeRepo(config?: unknown): string {
  const repo = temp('why-diff-config-repo-');
  put(repo, 'migrations/001.sql', 'create table a (id int);\n');
  put(repo, 'generated/api.ts', 'export const v = 1;\n');
  put(repo, 'src/a.ts', 'export const a = 1;\n');
  if (config !== undefined) put(repo, '.why-diff.json', typeof config === 'string' ? config : JSON.stringify(config));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, stdio: 'pipe', env: { ...ENV, GIT_AUTHOR_DATE: LONG_AGO, GIT_COMMITTER_DATE: LONG_AGO } });
  return repo;
}

describe('glob matching', () => {
  it.each([
    ['migrations/**', 'migrations/001.sql', true],
    ['migrations/**', 'db/migrations/001.sql', false],
    ['**/migrations/**', 'db/migrations/001.sql', true],
    ['migrations/', 'migrations/a/b.sql', true],
    ['*.lock', 'sub/dir/yarn.lock', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['.github/**', '.github/workflows/ci.yml', true],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
  ])('%s vs %s', (glob, file, want) => {
    expect(globToRegExp(glob).test(file)).toBe(want);
  });
  it('matchGlobs returns the matching pattern', () => {
    expect(matchGlobs(['x/**', 'migrations/**'], 'migrations/1.sql')).toBe('migrations/**');
    expect(matchGlobs(undefined, 'a')).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('returns {} without a config', async () => {
    expect(await loadConfig(makeRepo())).toEqual({});
  });
  it('reads .why-diff.json', async () => {
    expect(await loadConfig(makeRepo({ protected: ['a/**'], ignore: ['b/**'], blockOn: ['ci-changed'] }))).toEqual({ protected: ['a/**'], ignore: ['b/**'], blockOn: ['ci-changed'] });
  });
  it('falls back to the whyDiff key in package.json', async () => {
    const repo = makeRepo();
    put(repo, 'package.json', JSON.stringify({ name: 'x', whyDiff: { protected: ['p/**'] } }));
    expect(await loadConfig(repo)).toEqual({ protected: ['p/**'] });
  });
  it('invalid JSON names the file', async () => {
    await expect(loadConfig(makeRepo('{ nope'))).rejects.toThrow(/\.why-diff\.json: invalid JSON/);
  });
  it('unknown blockOn kind names the file and value', async () => {
    await expect(loadConfig(makeRepo({ blockOn: ['bogus'] }))).rejects.toThrow(/\.why-diff\.json.*"bogus"/);
  });
  it('wrong types are rejected', async () => {
    await expect(loadConfig(makeRepo({ protected: 'migrations/**' }))).rejects.toThrow(/"protected" must be an array/);
  });
});

describe('protected and ignore in buildReport', () => {
  const edit = (repo: string, rel: string, from: string, to: string): SyntheticCall => ({ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, rel), old_string: from, new_string: to } });

  it('an agent edit under a protected path gets protected-path; a human edit does not', async () => {
    const repo = makeRepo({ protected: ['migrations/**', '.github/**'] });
    const home = temp('why-diff-config-home-');
    writeSyntheticTranscript(home, repo, 's1', [{ prompt: 'add a column', at: SESSION_AT, calls: [edit(repo, 'migrations/001.sql', 'id int', 'id int, n int')] }]);
    put(repo, 'migrations/001.sql', 'create table a (id int, n int);\n');
    put(repo, 'src/a.ts', 'export const a = 2;\n'); // human
    const r = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    expect(r.mode).toBe('provenance');
    const mig = r.hunks.find((h) => h.hunk.file === 'migrations/001.sql')!;
    expect(mig.labels.find((l) => l.kind === 'protected-path')?.severity).toBe('risk');
    expect(r.summary.labels['protected-path']).toBe(1);

    // Human edit of a protected path: no label.
    put(repo, 'migrations/002.sql', 'select 1;\n');
    const r2 = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    const h2 = r2.hunks.find((h) => h.hunk.file === 'migrations/002.sql')!;
    expect(h2.labels.map((l) => l.kind)).not.toContain('protected-path');
  });

  it('risk-scan mode (no transcripts) flags a protected path on every hunk', async () => {
    const repo = makeRepo({ protected: ['migrations/**'] });
    put(repo, 'migrations/001.sql', 'drop table a;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    expect(r.mode).toBe('risk-scan');
    expect(r.hunks.flatMap((h) => h.labels).map((l) => l.kind)).toContain('protected-path');
  });

  it('ignore removes hunks before everything else', async () => {
    const repo = makeRepo({ ignore: ['generated/**'] });
    put(repo, 'generated/api.ts', 'export const v = 2;\n');
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    expect(r.hunks.map((h) => h.hunk.file)).toEqual(['src/a.ts']);
    expect(r.summary.files).toBe(1);
  });

  it('invalid config makes buildReport throw naming the file', async () => {
    const repo = makeRepo('{ nope');
    await expect(buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') })).rejects.toThrow(/\.why-diff\.json/);
  });
});

describe('guard with config', () => {
  async function scenario(config: unknown) {
    const repo = makeRepo(config);
    const home = temp('why-diff-config-home-');
    const stateDir = temp('why-diff-config-state-');
    const transcript = writeSyntheticTranscript(home, repo, 'sg', [{ prompt: 'change migration', at: SESSION_AT, calls: [{ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'migrations/001.sql'), old_string: 'id int', new_string: 'id bigint' } }] }]);
    put(repo, 'migrations/001.sql', 'create table a (id bigint);\n');
    return { payload: { transcript_path: transcript, cwd: repo, session_id: 'sg' }, home, stateDir };
  }

  it('protected-path blocks by default', async () => {
    const s = await scenario({ protected: ['migrations/**'] });
    const r = await runGuard(s.payload, { home: s.home, stateDir: s.stateDir });
    expect(r.block).toBe(true);
    expect(r.message).toContain('protected-path');
  });

  it('config blockOn replaces the default list', async () => {
    const s = await scenario({ protected: ['migrations/**'], blockOn: ['ci-changed'] });
    expect((await runGuard(s.payload, { home: s.home, stateDir: s.stateDir })).block).toBe(false);
  });

  it('explicit blocking wins over config blockOn', async () => {
    const s = await scenario({ protected: ['migrations/**'], blockOn: ['ci-changed'] });
    const r = await runGuard(s.payload, { home: s.home, stateDir: s.stateDir, blocking: new Set(['protected-path']) });
    expect(r.block).toBe(true);
  });

  it('an invalid config falls back to defaults without crashing', async () => {
    const s = await scenario('{ nope');
    const r = await runGuard(s.payload, { home: s.home, stateDir: s.stateDir });
    expect(r.block).toBe(false);
  });
});
