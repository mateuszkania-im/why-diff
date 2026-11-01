/**
 * Regression tests for the independent review of the sec033 fixes (items 11-14): a hard deadline
 * enforced from outside the check, a base record that an earlier session disabled, a working tree
 * redirected by `core.worktree` or a gitfile, and staged changes from before the session.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
import { recordSessionStart } from '../src/session-start.js';
import type { LabelKind } from '../src/types.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path', 'unreviewed']);
const posix = process.platform !== 'win32';
const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  while (dirs.length) {
    const d = dirs.pop()!;
    try { chmodSync(d, 0o700); } catch { /* gone */ }
    rmSync(d, { recursive: true, force: true });
  }
});
function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}
const iso = (ms: number): string => new Date(ms).toISOString();
const PAST = iso(Date.now() - 3600_000);
const GIT_ENV = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
function git(cwd: string, args: string[], date?: string): string {
  const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, ...dates } });
}
function testFile(skip5 = false): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 10; i++) s += `it${skip5 && i === 5 ? '.skip' : ''}("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}
const TEST = 'test/a.test.js';
function repo(): { repo: string; home: string; tp: string } {
  const r = temp('wd-s33r-repo-');
  mkdirSync(path.join(r, 'test'));
  mkdirSync(path.join(r, 'src'));
  writeFileSync(path.join(r, 'src', 'f.js'), 'export const f = (x) => x;\n');
  writeFileSync(path.join(r, TEST), testFile());
  git(r, ['init', '-q', '-b', 'main']);
  git(r, ['add', '-A']);
  git(r, ['commit', '-qm', 'A'], PAST);
  return { repo: r, home: temp('wd-s33r-home-'), tp: path.join(r, TEST) };
}
const replaceIn = (f: string, a: string, b: string): void => writeFileSync(f, readFileSync(f, 'utf8').replace(a, b));
const edit = (at: number, tp: string, a: string, b: string): SyntheticCall => ({ tool: 'Edit', at: iso(at), resultAt: iso(at + 4000), input: { file_path: tp, old_string: a, new_string: b } });
const bash = (at: number, command: string, dur = 4000): SyntheticCall => ({ tool: 'Bash', at: iso(at), resultAt: iso(at + dur), input: { command, description: 'x' } });
const hash = (id: string): string => createHash('sha256').update(id).digest('hex');
/** Claude Code's transcript line for a SessionStart hook's stdout (shape of a real 2.1.x transcript). */
const hookLine = (stdout: string): string => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'attachment', timestamp: iso(Date.now() - 61_000), sessionId: 's33r',
  attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: '', exitCode: 0, command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/why-diff.mjs" session-start', stdout },
});

/** A session that started a minute ago, calls from 50 s ago; `hookStdout` goes into the transcript as the SessionStart hook's output. */
async function guardRun(r: string, home: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> & { cwd?: string; hookStdout?: string } = {}) {
  const start = Date.now() - 60_000;
  const transcript = writeSyntheticTranscript(home, opts.cwd ?? r, 's33r', [{ prompt: 'make the suite green', at: iso(start), calls: calls(start + 10_000) }]);
  if (opts.hookStdout) writeFileSync(transcript, `${hookLine(opts.hookStdout)}\n${readFileSync(transcript, 'utf8')}`);
  return runGuard({ transcript_path: transcript, cwd: opts.cwd ?? r, session_id: 's33r' }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return 0; }, ...opts });
}
/** The record file reads as written before the first call; everything else by its real ctime (after every call). */
const recordBeforeCalls = (data: string, callAt: () => number) => async (p: string): Promise<number> => {
  const st = await lstat(p);
  return path.resolve(p).startsWith(path.join(data, 'sessions')) ? callAt() - 5000 : st.ctimeMs;
};

describe('sec033 #11: the hard deadline is enforced from outside the check', () => {
  function cli(cwd: string, input: string, env: Record<string, string>): { status: number | null; ms: number; stderr: string } {
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), 'guard'], { cwd, input, encoding: 'utf8', env: { ...process.env, ...env, WHY_DIFF_CLAUDE_BIN: '/nonexistent' }, timeout: 120_000 });
    return { status: r.status, ms: Date.now() - t, stderr: r.stderr };
  }

  it.skipIf(!posix)('synchronous labelling past the deadline is cut off: exit 2 near the deadline, temporary files removed', () => {
    const x = repo();
    // Real clocks here (no injected times): the session starts once the repository's objects are old enough.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
    const start = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    mkdirSync(path.join(x.repo, 'gen'));
    const unit = '  expect(compute(a, b, c)).toBe(compute(a, b, c));\n';
    const body = unit.repeat(Math.floor(200 * 1024 / unit.length));
    for (let i = 0; i < 400; i++) writeFileSync(path.join(x.repo, 'gen', `f${i}.test.js`), body);
    // One call still open (no result yet): its window lasts until the guard runs, so every file above is credited by time.
    const transcript = writeSyntheticTranscript(x.home, x.repo, 's33r', [{ prompt: 'go', at: iso(start), calls: [{ tool: 'Bash', at: iso(start + 50), input: { command: 'node gen.js', description: 'x' }, noResult: true }] }]);
    const tmp = temp('wd-s33r-tmp-');
    const r = cli(x.repo, JSON.stringify({ transcript_path: transcript, cwd: x.repo, session_id: 's33r' }), { HOME: x.home, TMPDIR: tmp, WHY_DIFF_GUARD_DEADLINE_MS: '1500' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('did not finish within 1.5 s');
    expect(r.ms).toBeLessThan(1500 + 3000);
    expect(readdirSync(tmp).filter((f) => f.startsWith('why-diff'))).toEqual([]);
  }, 120_000);

  it('time-credited untracked files past the byte cap are reported unreviewed without being read', async () => {
    process.env.WHY_DIFF_MAX_TIMED_BYTES = '2500';
    const x = repo();
    mkdirSync(path.join(x.repo, 'gen'));
    for (let i = 0; i < 5; i++) writeFileSync(path.join(x.repo, 'gen', `f${i}.js`), `${'x'.repeat(999)}\n`);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'node gen.js')];
    }, { statTime: async (p) => { await lstat(p); return callAt + 1000; } });
    expect(res.block).toBe(true);
    expect(res.message).toContain('unreviewed');
    expect(res.message).toMatch(/3 more untracked files .*bytes/);
  });
});

describe('sec033 #12: a base record an earlier session disabled', () => {
  it.skipIf(!posix)('session-start in a repo prints the failed marker when the record cannot be written; nothing outside a repo', async () => {
    const x = repo();
    const data = temp('wd-s33r-data-');
    mkdirSync(path.join(data, 'sessions'));
    chmodSync(path.join(data, 'sessions'), 0o500);
    process.env.CLAUDE_PLUGIN_DATA = data;
    const out = await recordSessionStart({ session_id: 's33r', cwd: x.repo, source: 'startup' });
    expect(JSON.parse(out ?? '{}').hookSpecificOutput?.additionalContext).toContain(`why-diff:base-record-failed ${hash('s33r')}`);
    expect(await recordSessionStart({ session_id: 's33r', cwd: temp('wd-s33r-plain-'), source: 'startup' })).toBeUndefined();
  });

  it('the failed marker in the transcript fails closed', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s33r-data-');
    const x = repo();
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `why-diff:base-record-failed ${hash('s33r')}` } });
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], { hookStdout: stdout });
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record could not be written');
  });
});

describe('sec033 #12b: an unwritable record directory without any marker', () => {
  it.skipIf(!posix || process.getuid?.() === 0)('fails closed when there is no record and the record directory cannot be written', async () => {
    const data = temp('wd-s33r-data-');
    mkdirSync(path.join(data, 'sessions'));
    chmodSync(path.join(data, 'sessions'), 0o500);
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record directory');
  });
});

describe('sec033 #13: the working tree git reports must be the one the .git entry is in', () => {
  it.skipIf(!posix)('core.worktree pointed at a clean copy (with a gitfile back) fails closed', async () => {
    const x = repo();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    const clean = temp('wd-s33r-clean-');
    git(x.repo, ['--work-tree', clean, 'checkout', '-q', 'HEAD', '--', '.']);
    git(x.repo, ['config', 'core.worktree', clean]);
    writeFileSync(path.join(clean, '.git'), `gitdir: ${path.join(x.repo, '.git')}\n`);
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'sh fix.sh')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain('why-diff could not check this session');
    expect(res.message).toContain('work tree');
  });

  it('a record for an enclosing repository blocks when the session now works in a repository nested in it', async () => {
    const data = temp('wd-s33r-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    await recordSessionStart({ session_id: 's33r', cwd: x.repo, source: 'startup' });
    const nested = path.join(x.repo, 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'a.test.js'), testFile());
    git(nested, ['init', '-q', '-b', 'main']);
    git(nested, ['add', '-A']);
    git(nested, ['commit', '-qm', 'n'], PAST);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'git init nested')];
    }, { cwd: nested, statTime: recordBeforeCalls(data, () => callAt) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record');
  });
});

describe('sec033 #14: staged changes from before the session', () => {
  function staged(): { repo: string; home: string; tp: string; ci: string } {
    const x = repo();
    mkdirSync(path.join(x.repo, '.github', 'workflows'), { recursive: true });
    const ci = path.join(x.repo, '.github', 'workflows', 'ci.yml');
    writeFileSync(ci, 'on: push\njobs: {}\n');
    git(x.repo, ['add', '-A']);
    git(x.repo, ['commit', '-qm', 'ci'], PAST);
    writeFileSync(ci, 'on: [push, pull_request]\njobs: {}\n');
    git(x.repo, ['add', ci]); // the human, before the session
    return { ...x, ci };
  }

  it('a CI change the human staged before the session does not block after an IDE refresh of the index', async () => {
    const data = temp('wd-s33r-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = staged();
    await recordSessionStart({ session_id: 's33r', cwd: x.repo, source: 'startup' });
    const src = path.join(x.repo, 'src', 'f.js');
    replaceIn(src, '(x) => x', '(x) => x * 1');
    git(x.repo, ['status', '--porcelain']); // IDE refresh: the index changes after the last call
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [edit(t, src, '(x) => x', '(x) => x * 1')];
    }, { statTime: recordBeforeCalls(data, () => callAt) });
    expect(res.block).toBe(false);
  });

  it('a skip the agent stages during the session still blocks with the index tree recorded', async () => {
    const data = temp('wd-s33r-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = staged();
    await recordSessionStart({ session_id: 's33r', cwd: x.repo, source: 'startup' });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: x.repo, input: testFile().replace('it("t5"', 'it.skip("t5"'), encoding: 'utf8' }).trim();
    git(x.repo, ['update-index', '--cacheinfo', `100644,${blob},${TEST}`]);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'B=$(sed s/x/y/ f | git hash-object -w --stdin) && git update-index --cacheinfo 100644,$B,f')];
    }, { statTime: recordBeforeCalls(data, () => callAt) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
    expect(res.message).not.toContain('ci-changed');
  });
});
