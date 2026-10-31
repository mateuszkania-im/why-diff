import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileGlobs, loadConfig, matchGlobs, samePath } from '../src/config.js';
import { renderMarkdown } from '../src/report/index.js';
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
    ['migrations', 'migrations/001.sql', true],
    ['migrations', 'db/migrations/001.sql', true],
    ['migrations', 'src/migrationsX/a.sql', false],
    ['./migrations', 'migrations/001.sql', true],
    ['./migrations', 'db/migrations/001.sql', false],
    ['*a', '*ba', true],
    ['*a', '*bc', false],
    ['a*b', 'a*xb', true],
    ['**', 'a/b/c', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
  ])('%s vs %s', (glob, file, want) => {
    expect(matchGlobs([glob], file) !== undefined).toBe(want);
  });
  it('pathological ** patterns finish fast (no regex backtracking)', () => {
    for (const n of [8, 12, 40]) {
      const t0 = performance.now();
      const hit = matchGlobs(['**/'.repeat(n) + 'x'], 'a/'.repeat(40) + 'y');
      expect(hit).toBeUndefined();
      expect(performance.now() - t0).toBeLessThan(50);
    }
    const t1 = performance.now();
    compileGlobs(['*a*a*a*a*a*a*a*a*b'])('a'.repeat(200));
    expect(performance.now() - t1).toBeLessThan(50);
  });
  it('is case-insensitive on darwin and win32 only', () => {
    const insensitive = process.platform === 'darwin' || process.platform === 'win32';
    expect(matchGlobs(['Migrations/**'], 'migrations/a.sql') !== undefined).toBe(insensitive);
  });
  it('samePath follows the platform case rules', () => {
    const insensitive = process.platform === 'darwin' || process.platform === 'win32';
    expect(samePath('Package.json', 'package.json')).toBe(insensitive);
    expect(samePath('package.json', 'package.json')).toBe(true);
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
  it.each(['{a,b}/**', 'src/[ab].ts', '!vendor/**'])('rejects unsupported glob syntax %s', async (g) => {
    await expect(loadConfig(makeRepo({ protected: [g] }))).rejects.toThrow(/\.why-diff\.json.*unsupported/);
  });
  it('rejects patterns over the length cap', async () => {
    await expect(loadConfig(makeRepo({ ignore: ['a'.repeat(513)] }))).rejects.toThrow(/\.why-diff\.json.*too long/);
  });
  it('reads the config from a base revision, not the working tree', async () => {
    const repo = makeRepo({ protected: ['migrations/**'] });
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'] }));
    expect(await loadConfig(repo, 'HEAD')).toEqual({ protected: ['migrations/**'] });
    expect(await loadConfig(repo)).toEqual({ ignore: ['**'] });
  });
  it('reads whyDiff from package.json at the base revision', async () => {
    const repo = makeRepo();
    put(repo, 'package.json', JSON.stringify({ whyDiff: { protected: ['p/**'] } }));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'pkg');
    put(repo, 'package.json', JSON.stringify({ whyDiff: { ignore: ['**'] } }));
    expect(await loadConfig(repo, 'HEAD')).toEqual({ protected: ['p/**'] });
  });
  it('falls back to the working tree when the base has no config at all', async () => {
    const repo = makeRepo();
    put(repo, '.why-diff.json', JSON.stringify({ protected: ['x/**'] }));
    expect(await loadConfig(repo, 'HEAD')).toEqual({ protected: ['x/**'] });
  });
  it('a working-tree config over a base without one never contributes ignore', async () => {
    const repo = makeRepo();
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'], protected: ['infra/**'], blockOn: ['lockfile'] }));
    expect(await loadConfig(repo, 'HEAD')).toEqual({ protected: ['infra/**'], blockOn: ['lockfile'] });
  });
  it('an unresolvable base revision is treated as no base config', async () => {
    const repo = makeRepo();
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'], protected: ['infra/**'] }));
    expect(await loadConfig(repo, 'no-such-rev')).toEqual({ protected: ['infra/**'] });
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

  it('a change to .why-diff.json is protected-path regardless of config and ignore cannot hide it', async () => {
    const repo = makeRepo({ ignore: ['**'] });
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'], blockOn: [] }));
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    const cfg = r.hunks.find((h) => h.hunk.file === '.why-diff.json')!;
    expect(cfg.labels.find((l) => l.kind === 'protected-path')?.severity).toBe('risk');
  });

  it('a change to the whyDiff key in package.json is protected-path', async () => {
    const repo = makeRepo();
    put(repo, 'package.json', JSON.stringify({ name: 'x', whyDiff: { ignore: [] } }, null, 2) + '\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'pkg');
    put(repo, 'package.json', JSON.stringify({ name: 'x', whyDiff: { ignore: ['**'] } }, null, 2) + '\n');
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    expect(r.hunks.find((h) => h.hunk.file === 'package.json')!.labels.map((l) => l.kind)).toContain('protected-path');
    expect(r.hunks.find((h) => h.hunk.file === 'src/a.ts')!.labels.map((l) => l.kind)).not.toContain('protected-path');
  });

  it('a PR that adds ignore: ["**"] does not hide its own hunks (config read from the base)', async () => {
    const repo = makeRepo({ protected: ['migrations/**'] });
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'] }));
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    expect(r.hunks.map((h) => h.hunk.file)).toContain('src/a.ts');
    expect(r.summary.ignoredHunks).toBeUndefined();
  });

  it('ignore never drops a hunk whose old path is not ignored, or one that matches protected', async () => {
    const repo = makeRepo({ ignore: ['generated/**', 'migrations/**'], protected: ['migrations/**'] });
    put(repo, 'migrations/001.sql', 'drop table a;\n');
    sh(repo, 'mv', 'generated/api.ts', 'src/api.ts');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    const files = r.hunks.map((h) => h.hunk.file);
    expect(files).toContain('migrations/001.sql');
    expect(files).toContain('src/api.ts');
  });

  it('a PR introducing the first config cannot ignore anything but its protected path is labelled', async () => {
    const repo = makeRepo();
    put(repo, '.why-diff.json', JSON.stringify({ ignore: ['**'], protected: ['infra/**'] }));
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    put(repo, 'infra/main.tf', 'resource "x" "y" {}\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    const files = r.hunks.map((h) => h.hunk.file);
    expect(files).toEqual(expect.arrayContaining(['src/a.ts', 'infra/main.tf', '.why-diff.json']));
    expect(r.summary.ignoredHunks).toBeUndefined();
    expect(r.hunks.find((h) => h.hunk.file === 'infra/main.tf')!.labels.map((l) => l.kind)).toContain('protected-path');
  });

  it('a file-only agent match in a protected dir is labelled', async () => {
    const repo = makeRepo({ protected: ['infra/**'] });
    const home = temp('why-diff-config-home-');
    const t = writeSyntheticTranscript(home, repo, 'sf', [{ prompt: 'add infra', at: SESSION_AT, calls: [{ tool: 'Write', at: CALL_AT, input: { file_path: path.join(repo, 'infra/a.json'), content: '{}\n' } }] }]);
    put(repo, 'infra/a.json', '{}\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home, sessionFiles: [t], harnesses: ['claude-code'] });
    const h = r.hunks.find((x) => x.hunk.file === 'infra/a.json')!;
    expect(h.match).toBe('file-only');
    expect(h.labels.map((l) => l.kind)).toContain('protected-path');
  });

  it('rename from a protected dir to an unprotected one is labelled', async () => {
    const repo = makeRepo({ protected: ['migrations/**'] });
    sh(repo, 'mv', 'migrations/001.sql', 'src/001.sql');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    const h = r.hunks.find((x) => x.hunk.file === 'src/001.sql')!;
    expect(h.labels.map((l) => l.kind)).toContain('protected-path');
  });

  it('counts ignored hunks in the summary and shows them in markdown', async () => {
    const repo = makeRepo({ ignore: ['generated/**'] });
    put(repo, 'generated/api.ts', 'export const v = 2;\n');
    put(repo, 'src/a.ts', 'export const a = 2;\n');
    const r = await buildReport({ cwd: repo, workingTree: true, home: temp('why-diff-config-home-') });
    expect(r.summary.ignoredHunks).toBe(1);
    expect(renderMarkdown(r)).toMatch(/1 hunk ignored by config/);
  });
});

const LOCK = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/a': { version: '1.0.0' } } }, null, 2) + '\n';

describe('guard with config', () => {
  async function scenario(config: unknown, opts: { extra?: (repo: string) => void } = {}) {
    const repo = makeRepo(config);
    const home = temp('why-diff-config-home-');
    const stateDir = temp('why-diff-config-state-');
    const transcript = writeSyntheticTranscript(home, repo, 'sg', [{ prompt: 'change migration', at: SESSION_AT, calls: [{ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'migrations/001.sql'), old_string: 'id int', new_string: 'id bigint' } }] }]);
    put(repo, 'migrations/001.sql', 'create table a (id bigint);\n');
    opts.extra?.(repo);
    return { repo, payload: { transcript_path: transcript, cwd: repo, session_id: 'sg' }, home, stateDir };
  }

  it('protected-path blocks by default', async () => {
    const s = await scenario({ protected: ['migrations/**'] });
    const r = await runGuard(s.payload, { home: s.home, stateDir: s.stateDir });
    expect(r.block).toBe(true);
    expect(r.message).toContain('protected-path');
  });

  it('config blockOn only adds to the defaults, never removes', async () => {
    for (const blockOn of [[], ['ci-changed']]) {
      const s = await scenario({ protected: ['migrations/**'], blockOn });
      expect((await runGuard(s.payload, { home: s.home, stateDir: s.stateDir })).block).toBe(true);
    }
  });

  it('config blockOn adds a kind that is not blocking by default', async () => {
    const s = await scenario({ blockOn: ['lockfile'] }, {});
    const home = s.home;
    const t = writeSyntheticTranscript(home, s.repo, 'sl', [{ prompt: 'lock', at: SESSION_AT, calls: [{ tool: 'Write', at: CALL_AT, input: { file_path: path.join(s.repo, 'package-lock.json'), content: LOCK } }] }]);
    put(s.repo, 'package-lock.json', LOCK);
    const r = await runGuard({ transcript_path: t, cwd: s.repo, session_id: 'sl' }, { home, stateDir: s.stateDir });
    expect(r.block).toBe(true);
    expect(r.message).toContain('lockfile');
  });

  it('explicit blocking replaces the defaults', async () => {
    const s = await scenario({ protected: ['migrations/**'] });
    const r = await runGuard(s.payload, { home: s.home, stateDir: s.stateDir, blocking: new Set(['ci-changed']) });
    expect(r.block).toBe(false);
  });

  it('an invalid config falls back to defaults: an agent it.skip still blocks', async () => {
    const repo = makeRepo('{ nope');
    put(repo, 'test/f.test.js', 'it("a",()=>{\n  expect(1).toBe(1);\n});\n');
    sh(repo, 'add', '-A');
    execFileSync('git', ['commit', '-qm', 't'], { cwd: repo, stdio: 'pipe', env: { ...ENV, GIT_AUTHOR_DATE: LONG_AGO, GIT_COMMITTER_DATE: LONG_AGO } });
    const home = temp('why-diff-config-home-');
    const t = writeSyntheticTranscript(home, repo, 'si', [{ prompt: 'skip', at: SESSION_AT, calls: [{ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'test/f.test.js'), old_string: 'it("a"', new_string: 'it.skip("a"' } }] }]);
    put(repo, 'test/f.test.js', 'it.skip("a",()=>{\n  expect(1).toBe(1);\n});\n');
    const r = await runGuard({ transcript_path: t, cwd: repo, session_id: 'si' }, { home, stateDir: temp('why-diff-config-state-') });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('an agent adding ignore: ["**"] in the same session does not unblock its own it.skip, and the config edit is labelled', async () => {
    const repo = makeRepo({ protected: ['migrations/**'] });
    put(repo, 'test/f.test.js', 'it("a",()=>{\n  expect(1).toBe(1);\n});\n');
    sh(repo, 'add', '-A');
    execFileSync('git', ['commit', '-qm', 't'], { cwd: repo, stdio: 'pipe', env: { ...ENV, GIT_AUTHOR_DATE: LONG_AGO, GIT_COMMITTER_DATE: LONG_AGO } });
    const home = temp('why-diff-config-home-');
    const t = writeSyntheticTranscript(home, repo, 'sx', [{ prompt: 'skip a test', at: SESSION_AT, calls: [
      { tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'test/f.test.js'), old_string: 'it("a"', new_string: 'it.skip("a"' } },
      { tool: 'Write', at: CALL_AT, input: { file_path: path.join(repo, '.why-diff.json'), content: '{"ignore":["**"]}' } },
    ] }]);
    put(repo, 'test/f.test.js', 'it.skip("a",()=>{\n  expect(1).toBe(1);\n});\n');
    put(repo, '.why-diff.json', '{"ignore":["**"]}');
    const r = await runGuard({ transcript_path: t, cwd: repo, session_id: 'sx' }, { home, stateDir: temp('why-diff-config-state-') });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
    expect(r.message).toContain('.why-diff.json');
    expect(r.message).toContain('protected-path');
  });
});

describe('CLI', () => {
  it('exits 2 and names the file for an invalid config', () => {
    const repo = makeRepo('{ nope');
    const root = path.resolve(__dirname, '..');
    const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
    const r = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'src', 'cli.ts'), '-f', 'json', '-q'], {
      cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, ...ENV, HOME: temp('why-diff-config-home-'), WHY_DIFF_CLAUDE_BIN: '/nonexistent' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('.why-diff.json');
  });
});
