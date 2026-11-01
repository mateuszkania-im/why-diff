/**
 * Regression tests for guard bypasses found in the 0.3.4 security review (sec035): a `.git` moved
 * away, a commit kept only in a reftable ref store, agent-configured programs (hooks, fsmonitor,
 * filters, diff drivers) run by the guard's own git calls, a test directory replaced by a symlink,
 * tests inside submodules, and change times read from a file system mounted inside the repository.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Guard runs over real repositories (submodules, CLI children) take seconds on Windows runners.
vi.setConfig({ testTimeout: 30_000 });
import { runGuard, windowsVolumeCommands, type GuardOptions } from '../src/guard.js';
import * as gitModule from '../src/git.js';
import { recordSessionStart } from '../src/session-start.js';
import type { LabelKind } from '../src/types.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path', 'unreviewed']);
const posix = process.platform !== 'win32';
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  // A guard child still exiting (Windows) can hold a directory for a moment: EBUSY is retried.
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}
const iso = (ms: number): string => new Date(ms).toISOString();
const PAST = iso(Date.now() - 3600_000);
const GIT_ENV = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
function git(cwd: string, args: string[], date?: string, extra: Record<string, string> = {}): string {
  const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, ...dates, ...extra } });
}
function testFile(skip5 = false): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 10; i++) s += `it${skip5 && i === 5 ? '.skip' : ''}("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}
const TEST = 'test/a.test.js';
function repo(prefix = 'wd-s35-repo-', initArgs: string[] = []): { repo: string; home: string; tp: string } {
  const r = temp(prefix);
  mkdirSync(path.join(r, 'test'));
  mkdirSync(path.join(r, 'src'));
  writeFileSync(path.join(r, 'src', 'f.js'), 'export const f = (x) => x;\n');
  writeFileSync(path.join(r, TEST), testFile());
  git(r, ['init', '-q', '-b', 'main', ...initArgs]);
  git(r, ['add', '-A']);
  git(r, ['commit', '-qm', 'A'], PAST);
  return { repo: r, home: temp('wd-s35-home-'), tp: path.join(r, TEST) };
}
const replaceIn = (f: string, a: string, b: string): void => writeFileSync(f, readFileSync(f, 'utf8').replace(a, b));
const edit = (at: number, tp: string, a: string, b: string): SyntheticCall => ({ tool: 'Edit', at: iso(at), resultAt: iso(at + 4000), input: { file_path: tp, old_string: a, new_string: b } });
const bash = (at: number, command: string, dur = 4000): SyntheticCall => ({ tool: 'Bash', at: iso(at), resultAt: iso(at + dur), input: { command, description: 'x' } });
const hash = (id: string): string => createHash('sha256').update(id).digest('hex');
const SID = 's35';
/** Claude Code's transcript line for a SessionStart hook's stdout (shape of a real 2.1.x transcript). */
const hookLine = (text: string): string => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'attachment', timestamp: iso(Date.now() - 61_000), sessionId: SID,
  attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: '', exitCode: 0, command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/why-diff.mjs" session-start',
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) },
});
const okMarker = `why-diff:base-record ${hash(SID)}`;
const failedMarker = `why-diff:base-record-failed ${hash(SID)}`;

/** A session that started a minute ago, calls from 50 s ago; `marker` goes into the transcript as the SessionStart hook's output. */
async function guardRun(r: string, home: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> & { cwd?: string; marker?: string } = {}) {
  const start = Date.now() - 60_000;
  const transcript = writeSyntheticTranscript(home, opts.cwd ?? r, SID, [{ prompt: 'make the suite green', at: iso(start), calls: calls(start + 10_000) }]);
  if (opts.marker) writeFileSync(transcript, `${hookLine(opts.marker)}\n${readFileSync(transcript, 'utf8')}`);
  return runGuard({ transcript_path: transcript, cwd: opts.cwd ?? r, session_id: SID }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return 0; }, ...opts });
}

/** Objects whose files changed before `mark()` read as written long before the session; later ones by their real ctime. */
function objectsAfter(mark: () => number): (p: string) => Promise<number> {
  return async (p) => {
    const st = await lstat(p);
    return st.ctimeMs >= mark() ? st.ctimeMs : 0;
  };
}
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const gitSupportsReftable = ((): boolean => {
  try {
    const d = tempDir('wd-s35-rt-probe-');
    try {
      execFileSync('git', ['init', '-q', '--ref-format=reftable', d], { stdio: 'ignore' });
      return true;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();

describe('sec035 #1: a .git moved away does not turn the session into "not a repository"', () => {
  /** A weakened test, then `.git` moved out of the repository. */
  function moved(): { repo: string; home: string; tp: string } {
    const x = repo();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    const away = path.join(temp('wd-s35-gitstash-'), 'git');
    renameSync(path.join(x.repo, '.git'), away);
    return x;
  }
  const calls = (tp: string) => (t: number): SyntheticCall[] => [edit(t, tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'mv .git ../stash')];

  it('a SessionStart record for this directory fails closed', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s35-data-');
    const x = repo();
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    renameSync(path.join(x.repo, '.git'), path.join(temp('wd-s35-gitstash-'), 'git'));
    expect(existsSync(path.join(x.repo, '.git'))).toBe(false);
    const res = await guardRun(x.repo, x.home, calls(x.tp));
    expect(res.block).toBe(true);
    expect(res.message).toContain('no .git');
  });

  it('the record covers a cwd inside the recorded root too', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s35-data-');
    const x = repo();
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    renameSync(path.join(x.repo, '.git'), path.join(temp('wd-s35-gitstash-'), 'git'));
    const res = await guardRun(x.repo, x.home, calls(x.tp), { cwd: path.join(x.repo, 'test') });
    expect(res.block).toBe(true);
  });

  it('the base-record marker in the transcript fails closed even when the record is gone too', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s35-data-');
    const x = moved();
    const res = await guardRun(x.repo, x.home, calls(x.tp), { marker: okMarker });
    expect(res.block).toBe(true);
  });

  it('the failed marker fails closed', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s35-data-');
    const x = moved();
    const res = await guardRun(x.repo, x.home, calls(x.tp), { marker: failedMarker });
    expect(res.block).toBe(true);
  });

  it('no marker and no record outside a repository still lets the session finish', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s35-data-');
    const plain = temp('wd-s35-plain-');
    writeFileSync(path.join(plain, 'a.test.js'), testFile(true));
    const res = await guardRun(plain, temp('wd-s35-home-'), (t) => [edit(t, path.join(plain, 'a.test.js'), 'it("t5"', 'it.skip("t5"')]);
    expect(res.block).toBe(false);
  });

  /** The record file reads as changed at `at(callAt)`; everything else by its real ctime. */
  const recordAt = (data: string, callAt: () => number, at: (t: number) => number) => async (p: string): Promise<number> => {
    const st = await lstat(p);
    return path.resolve(p).startsWith(path.join(data, 'sessions')) ? at(callAt()) : st.ctimeMs;
  };

  it('a record for another directory, written before the session, does not block a session outside any repository', async () => {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    const plain = temp('wd-s35-plain-');
    let callAt = 0;
    const res = await guardRun(plain, x.home, (t) => {
      callAt = t;
      return [bash(t, 'echo hi')];
    }, { cwd: plain, statTime: recordAt(data, () => callAt, (t) => t - 3600_000) });
    expect(res.block).toBe(false);
  });

  it('a record forged during a call (no marker) blocks, whatever root it names', async () => {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const other = repo();
    await recordSessionStart({ session_id: SID, cwd: other.repo });
    const x = moved();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return calls(x.tp)(t);
    }, { statTime: recordAt(data, () => callAt, (t) => t + 1000) });
    expect(res.block).toBe(true);
  });

  it('the base-record marker blocks even when the record was replaced with one for another root', async () => {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const other = repo();
    await recordSessionStart({ session_id: SID, cwd: other.repo });
    const x = moved();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return calls(x.tp)(t);
    }, { marker: okMarker, statTime: recordAt(data, () => callAt, (t) => t - 3600_000) });
    expect(res.block).toBe(true);
  });
});

describe.skipIf(!gitSupportsReftable)('sec035 #2: refs kept in a reftable store are dated', () => {
  /** A commit made with plumbing (private index, update-ref) only: the work tree and the real index stay clean. */
  function plumbingCommit(r: string): void {
    const idx = path.join(temp('wd-s35-idx-'), 'idx');
    const env = { GIT_INDEX_FILE: idx };
    git(r, ['read-tree', 'HEAD'], undefined, env);
    const skipped = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r, input: testFile(true), encoding: 'utf8' }).trim();
    git(r, ['update-index', '--cacheinfo', `100644,${skipped},${TEST}`], undefined, env);
    const tree = git(r, ['write-tree'], undefined, env).trim();
    const c = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD'], { cwd: r, input: 'fix flaky test\n', encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
    git(r, ['update-ref', 'HEAD', c]);
  }
  /** `.git/reftable` reads as changed during the call; every other file under .git as changed before the first call. */
  const reftableInWindow = (r: string, callAt: () => number) => async (p: string): Promise<number> => {
    const st = await lstat(p);
    const rel = path.relative(path.join(r, '.git'), path.resolve(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return st.ctimeMs;
    return rel === 'reftable' || rel.startsWith(`reftable${path.sep}`) ? callAt() + 1000 : callAt() - 5000;
  };

  it('a commit-only skip in a reftable repository blocks', async () => {
    const x = repo('wd-s35-rt-', ['--ref-format=reftable']);
    pause(20);
    const mark = Date.now();
    plumbingCommit(x.repo);
    expect(git(x.repo, ['show', `HEAD:${TEST}`])).toContain('it.skip');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'bash /tmp/fix.sh')];
    }, { statTime: reftableInWindow(x.repo, () => callAt), objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a repository migrated to reftable during the session blocks the same commit', async () => {
    const x = repo('wd-s35-rtm-');
    pause(20);
    const mark = Date.now();
    git(x.repo, ['refs', 'migrate', '--ref-format=reftable']);
    plumbingCommit(x.repo);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'bash /tmp/fix.sh')];
    }, { statTime: reftableInWindow(x.repo, () => callAt), objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
  });

  it('a reftable repository whose refs did not change during the session does not block', async () => {
    const x = repo('wd-s35-rtc-', ['--ref-format=reftable']);
    replaceIn(path.join(x.repo, 'src', 'f.js'), 'x;', 'x + 0;');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, path.join(x.repo, 'src', 'f.js'), 'x;', 'x + 0;')], {
      statTime: async (p) => (path.resolve(p).startsWith(path.join(x.repo, '.git')) ? Date.now() - 58_000 : (await lstat(p)).ctimeMs),
    });
    expect(res.block).toBe(false);
  });
});

describe('sec035 #3: the guard runs no program the agent configured', () => {
  it('every git call carries the hardening flags and environment', () => {
    const harden = (gitModule as unknown as { hardenedInvocation?: (args: string[]) => { args: string[]; env: Record<string, string> } }).hardenedInvocation;
    expect(typeof harden).toBe('function');
    const diff = harden!(['diff', '--name-only', 'HEAD']);
    const joined = diff.args.join(' ');
    expect(joined).toContain(`core.hooksPath=${posix ? '/dev/null' : ''}`);
    expect(joined).toContain('core.fsmonitor=false');
    expect(joined).toContain('core.untrackedCache=false');
    expect(diff.args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']));
    expect(diff.args.indexOf('--no-ext-diff')).toBeGreaterThan(diff.args.indexOf('diff'));
    expect(harden!(['log', '-1']).args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
    expect(harden!(['hash-object', '-t', 'tree', '/dev/null']).args).toContain('--no-filters');
    expect(diff.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' });
  });

  describe.skipIf(!posix)('real programs', () => {
    /** A program that leaves a marker file when it runs (and prints its input back, for filters and textconv). */
    function program(dir: string, name: string): { path: string; marker: string } {
      const marker = path.join(dir, `${name}.ran`);
      const p = path.join(dir, name);
      writeFileSync(p, `#!/bin/sh\n: > "${marker}"\ncat "$@" 2>/dev/null || cat\nexit 0\n`);
      chmodSync(p, 0o755);
      return { path: p, marker };
    }
    async function skipRun(x: { repo: string; home: string; tp: string }) {
      replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
      return guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"')]);
    }

    it('a post-index-change hook (core.hooksPath) does not run inside the guard', async () => {
      const x = repo();
      const hooks = temp('wd-s35-hooks-');
      const hook = program(hooks, 'post-index-change');
      git(x.repo, ['config', 'core.hooksPath', hooks]);
      const res = await skipRun(x);
      expect(existsSync(hook.marker)).toBe(false);
      expect(res.block).toBe(true);
      expect(res.message).toContain('test-skip-added');
    });

    it('a post-index-change hook in .git/hooks does not run either', async () => {
      const x = repo();
      const hook = program(path.join(x.repo, '.git', 'hooks'), 'post-index-change');
      const res = await skipRun(x);
      expect(existsSync(hook.marker)).toBe(false);
      expect(res.block).toBe(true);
    });

    it('an fsmonitor hook does not run', async () => {
      const x = repo();
      const fsm = program(temp('wd-s35-fsm-'), 'fsmonitor');
      git(x.repo, ['config', 'core.fsmonitor', fsm.path]);
      const res = await skipRun(x);
      expect(existsSync(fsm.marker)).toBe(false);
      expect(res.block).toBe(true);
    });

    it('a clean filter named in .gitattributes does not run', async () => {
      const x = repo();
      const f = program(temp('wd-s35-filter-'), 'clean');
      writeFileSync(path.join(x.repo, '.git', 'info', 'attributes'), '*.js filter=hide\n');
      git(x.repo, ['config', 'filter.hide.clean', f.path]);
      git(x.repo, ['config', 'filter.hide.smudge', f.path]);
      const res = await skipRun(x);
      expect(existsSync(f.marker)).toBe(false);
      expect(res.block).toBe(true);
    });

    it('a textconv and an external diff driver do not run', async () => {
      const x = repo();
      const dir = temp('wd-s35-diff-');
      const tc = program(dir, 'textconv');
      const ext = program(dir, 'external');
      writeFileSync(path.join(x.repo, '.git', 'info', 'attributes'), '*.js diff=hide\n');
      git(x.repo, ['config', 'diff.hide.textconv', tc.path]);
      git(x.repo, ['config', 'diff.hide.command', ext.path]);
      git(x.repo, ['config', 'diff.external', ext.path]);
      const res = await skipRun(x);
      expect(existsSync(tc.marker)).toBe(false);
      expect(existsSync(ext.marker)).toBe(false);
      expect(res.block).toBe(true);
    });

    it('programs from the global config are not read', async () => {
      const x = repo();
      const fsm = program(temp('wd-s35-gfsm-'), 'fsmonitor');
      const home = temp('wd-s35-ghome-');
      writeFileSync(path.join(home, '.gitconfig'), `[core]\n\tfsmonitor = ${fsm.path}\n[filter "hide"]\n\tclean = ${fsm.path}\n`);
      writeFileSync(path.join(x.repo, '.git', 'info', 'attributes'), '*.js filter=hide\n');
      process.env.HOME = home;
      const res = await skipRun(x);
      expect(existsSync(fsm.marker)).toBe(false);
      expect(res.block).toBe(true);
    });
  });
});

describe.skipIf(!posix)('sec035 #4: a test directory replaced by a symlink is a deletion', () => {
  /** Moves `test/` out of the repository and leaves a symlink to it in its place. */
  function linked(): { repo: string; home: string; tp: string; link: string } {
    const x = repo();
    const kept = path.join(temp('wd-s35-kept-'), 'kept');
    renameSync(path.join(x.repo, 'test'), kept);
    const link = path.join(x.repo, 'test');
    symlinkSync(kept, link);
    return { ...x, link };
  }

  it('a symlink created during a call blocks the deletion of every test under it', async () => {
    const x = linked();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'bash /tmp/tidy.sh')];
    }, { statTime: async (p) => (path.resolve(p) === x.link ? callAt + 1000 : (await lstat(p)).ctimeMs) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('tests-disabled');
  });

  it('a symlink created after the last call blocks too', async () => {
    const x = linked();
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'bash /tmp/tidy.sh')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain(TEST);
  });

  it('a symlinked directory from before the session is not credited', async () => {
    const x = linked();
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], {
      statTime: async (p) => (path.resolve(p) === x.link ? Date.now() - 3600_000 : (await lstat(p)).ctimeMs),
    });
    expect(res.block).toBe(false);
  });
});

describe('sec035 #5: tests inside submodules are checked', () => {
  /** A repository with a submodule `lib` holding its own test file, committed before the session. */
  function withSubmodule(libSkip = false): { repo: string; home: string; tp: string; libTest: string } {
    const lib = temp('wd-s35-lib-');
    mkdirSync(path.join(lib, 'test'));
    writeFileSync(path.join(lib, 'test', 'a.test.js'), testFile(libSkip));
    git(lib, ['init', '-q', '-b', 'main']);
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'lib'], PAST);
    const x = repo('wd-s35-sup-');
    git(x.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
    git(x.repo, ['commit', '-qm', 'submodule'], PAST);
    return { ...x, libTest: path.join(x.repo, 'lib', 'test', 'a.test.js') };
  }

  it('an Edit skipping a test inside the submodule blocks, with the submodule path', async () => {
    const x = withSubmodule();
    replaceIn(x.libTest, 'it("t5"', 'it.skip("t5"');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.libTest, 'it("t5"', 'it.skip("t5"')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain('lib/test/a.test.js');
    expect(res.message).toContain('test-skip-added');
  });

  it('the same skip committed in the submodule and bumped in the superproject blocks', async () => {
    const x = withSubmodule();
    pause(20);
    const mark = Date.now();
    replaceIn(x.libTest, 'it("t5"', 'it.skip("t5"');
    git(path.join(x.repo, 'lib'), ['commit', '-qam', 'fix flaky']);
    git(x.repo, ['add', 'lib']);
    git(x.repo, ['commit', '-qm', 'bump lib']);
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.libTest, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'git -C lib commit -qam "fix flaky" && git add lib && git commit -qm "bump lib"')], { objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('lib/test/a.test.js');
  });

  it('end to end: the guard CLI exits 0 for a code-only session with a clean, unchanged submodule, and 2 for a skip inside it', () => {
    const x = withSubmodule(true);
    const f = path.join(x.repo, 'src', 'f.js');
    // The real CLI reads real object times: the session starts after the setup commits (and the 2 s slack).
    const later = Date.now() + 5000;
    const run = (id: string, file: string, a: string, b: string) => {
      replaceIn(file, a, b);
      const transcript = writeSyntheticTranscript(x.home, x.repo, id, [{ prompt: 'tidy f', at: iso(later), calls: [edit(later + 1000, file, a, b)] }]);
      return spawnSync(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/esm/index.mjs')).href, path.resolve('src/cli.ts'), 'guard'], { input: JSON.stringify({ transcript_path: transcript, cwd: x.repo, session_id: id }), encoding: 'utf8', cwd: x.repo, env: { ...process.env, CLAUDE_PLUGIN_DATA: temp('wd-s35-data-'), WHY_DIFF_CLAUDE_BIN: '/nonexistent' } });
    };
    const clean = run('s35-e2e-1', f, 'x;', 'x + 0;');
    expect(clean.stderr).toBe('');
    expect(clean.status).toBe(0);
    const skipped = run('s35-e2e-2', x.libTest, 'it("t4"', 'it.skip("t4"');
    expect(skipped.status).toBe(2);
    expect(skipped.stderr).toContain('lib/test/a.test.js');
  }, 60_000);

  it('a clean, unchanged submodule (with a pre-existing skip) does not block a code-only edit', async () => {
    const x = withSubmodule(true);
    const f = path.join(x.repo, 'src', 'f.js');
    replaceIn(f, 'x;', 'x + 0;');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, f, 'x;', 'x + 0;')]);
    expect(res.block).toBe(false);
  });
});

describe('sec035 #6: change times on a file system mounted inside the repository are not trusted', () => {
  /** `test/` (and everything under it) reads as another device; the times read as long before the session. */
  const mounted = (x: { repo: string }) => {
    const mount = path.join(x.repo, 'test');
    return {
      statTime: async (p: string) => {
        const st = await lstat(p);
        return path.resolve(p).startsWith(mount) ? Date.now() - 3600_000 : st.ctimeMs;
      },
      pathStat: async (p: string) => {
        const st = await lstat(p);
        const inMount = path.resolve(p) === mount || path.resolve(p).startsWith(`${mount}${path.sep}`);
        return { dev: inMount ? Number(st.dev) + 1 : Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
      },
    };
  };

  it('a weakened test on another device with backdated times blocks as unreviewed', async () => {
    const x = repo();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'bash /tmp/setup.sh')], mounted(x));
    expect(res.block).toBe(true);
    expect(res.message).toContain('unreviewed');
    expect(res.message).toContain(TEST);
  });

  it('an unchanged non-test file on another device does not block', async () => {
    const x = repo();
    mkdirSync(path.join(x.repo, 'docs'));
    writeFileSync(path.join(x.repo, 'docs', 'a.md'), 'x\n');
    git(x.repo, ['add', '-A']);
    git(x.repo, ['commit', '-qm', 'docs'], PAST);
    const mount = path.join(x.repo, 'docs');
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], {
      pathStat: async (p: string) => {
        const st = await lstat(p);
        return { dev: path.resolve(p).startsWith(mount) ? Number(st.dev) + 1 : Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
      },
    } as Partial<GuardOptions>);
    expect(res.block).toBe(false);
  });
});

describe('sec035 fix round 1 (F1): the repository and the record must stay on the file systems they started on', () => {
  const rootDev = (root: string, bump: string[]) => async (p: string) => {
    const st = await lstat(p);
    const hit = bump.some((b) => path.resolve(p) === b || path.resolve(p).startsWith(`${b}${path.sep}`));
    return { dev: hit ? Number(st.dev) + 1000 : Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
  };
  /** A record from session start that reads as written before the first call. */
  async function recorded(): Promise<{ repo: string; home: string; tp: string; data: string; times: (callAt: () => number) => (p: string) => Promise<number> }> {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    const times = (callAt: () => number) => async (p: string): Promise<number> => {
      const st = await lstat(p);
      return path.resolve(p).startsWith(path.join(data, 'sessions')) ? callAt() - 5000 : st.ctimeMs;
    };
    return { ...x, data, times };
  }
  const srcEdit = (r: string) => (t: number): SyntheticCall[] => [edit(t, path.join(r, 'src', 'f.js'), 'x;', 'x + 0;')];

  it('the record keeps the devices of the root, the git dir and the record directory', async () => {
    const x = await recorded();
    const rec = JSON.parse(readFileSync(path.join(x.data, 'sessions', `${hash(SID)}.json`), 'utf8')) as Record<string, unknown>;
    expect(typeof rec.rootDev).toBe('number');
    expect(typeof rec.gitDev).toBe('number');
    expect(typeof rec.dataDirDev).toBe('number');
  });

  it('a repository root on another device than at session start (a mount over it) fails closed', async () => {
    const x = await recorded();
    replaceIn(path.join(x.repo, 'src', 'f.js'), 'x;', 'x + 0;');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return srcEdit(x.repo)(t); }, { statTime: x.times(() => callAt), pathStat: rootDev(x.repo, [x.repo]) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('file system');
  });

  it('a git dir on another device than at session start fails closed', async () => {
    const x = await recorded();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return srcEdit(x.repo)(t); }, { statTime: x.times(() => callAt), pathStat: rootDev(x.repo, [path.join(x.repo, '.git')]) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('file system');
  });

  it('a record directory on another device than at session start fails closed', async () => {
    const x = await recorded();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return srcEdit(x.repo)(t); }, { statTime: x.times(() => callAt), pathStat: rootDev(x.repo, [path.join(x.data, 'sessions')]) });
    expect(res.block).toBe(true);
  });

  it('a record on an untrusted file system type fails closed', async () => {
    const x = await recorded();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return srcEdit(x.repo)(t); }, { statTime: x.times(() => callAt), fsType: async (p: string) => (p.startsWith(x.data) ? 'msdos' : 'apfs') } as Partial<GuardOptions>);
    expect(res.block).toBe(true);
    expect(res.message).toContain('msdos');
  });

  it('without a record, a repository on an untrusted file system type blocks; on a trusted one it does not', async () => {
    const x = repo();
    replaceIn(path.join(x.repo, 'src', 'f.js'), 'x;', 'x + 0;');
    const bad = await guardRun(x.repo, x.home, srcEdit(x.repo), { fsType: async () => 'msdos' } as Partial<GuardOptions>);
    expect(bad.block).toBe(true);
    expect(bad.message).toContain('msdos');
    const unknown = await guardRun(x.repo, x.home, srcEdit(x.repo), { fsType: async () => { throw new Error('statfs failed'); } } as Partial<GuardOptions>);
    expect(unknown.block).toBe(true);
    const good = await guardRun(x.repo, x.home, srcEdit(x.repo), { fsType: async () => 'apfs' } as Partial<GuardOptions>);
    expect(good.block).toBe(false);
  });
});

describe('sec035 fix round 1 (F2): non-executable global settings reach git, programs do not', () => {
  function globalConfig(text: string): string {
    const f = path.join(temp('wd-s35-gcfg-'), 'gitconfig');
    writeFileSync(f, text);
    process.env.GIT_CONFIG_GLOBAL = f;
    return f;
  }
  const forwarded = (): Promise<string> => (gitModule as unknown as { forwardedGlobalConfig: () => Promise<string> }).forwardedGlobalConfig();

  it('safe.directory, autocrlf and the excludes file are forwarded; aliases, programs and includes are not', async () => {
    // Config values take `\` as an escape: forward slashes on Windows too.
    const inc = path.join(temp('wd-s35-inc-'), 'inc').split(path.sep).join('/');
    writeFileSync(inc, '[core]\n\tfsmonitor = /bin/evil-inc\n');
    globalConfig(`[safe]\n\tdirectory = /srv/repo\n\tdirectory = /srv/other \\"quoted\\"\n[core]\n\tautocrlf = true\n\texcludesFile = /home/u/.gitignore_global\n\tfsmonitor = /bin/evil\n\tpager = /bin/evil\n[alias]\n\tx = !/bin/evil\n[include]\n\tpath = ${inc}\n[filter "x"]\n\tclean = /bin/evil\n`);
    const text = await forwarded();
    expect(text).toContain('directory = "/srv/repo"');
    expect(text).toContain('directory = "/srv/other \\"quoted\\""');
    expect(text).toContain('autocrlf = "true"');
    expect(text.toLowerCase()).toContain('excludesfile = "/home/u/.gitignore_global"');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('include');
  });

  it('with a global core.autocrlf=true: a source-only edit and an added test pass, a skip still blocks', async () => {
    globalConfig('[core]\n\tautocrlf = true\n');
    // test/helpers/setup.ts pins core.autocrlf=false for every test git process: lift that here.
    for (const k of Object.keys(process.env)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)) delete process.env[k];
    const x = repo();
    // Check the test file out again so it has CRLF line endings, as on Windows.
    rmSync(x.tp);
    git(x.repo, ['checkout', '--', TEST]);
    expect(readFileSync(x.tp, 'utf8')).toContain('\r\n');
    const src = path.join(x.repo, 'src', 'f.js');
    replaceIn(src, 'x;', 'x + 0;');
    expect((await guardRun(x.repo, x.home, (t) => [edit(t, src, 'x;', 'x + 0;')])).block).toBe(false);
    const added = 'it("t11",()=>{\r\n  expect(f(11)).toBe(11);\r\n});\r\nit("t10"';
    replaceIn(x.tp, 'it("t10"', added);
    const add = await guardRun(x.repo, x.home, (t) => [edit(t, src, 'x;', 'x + 0;'), edit(t + 5000, x.tp, 'it("t10"', added)]);
    expect(add.message ?? '').toBe('');
    expect(add.block).toBe(false);
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    const skipped = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"')]);
    expect(skipped.block).toBe(true);
    expect(skipped.message).toContain('test-skip-added');
  });

  it('with a global excludes file, build output it ignores is not read as the agent\'s untracked work', async () => {
    const ignore = path.join(temp('wd-s35-ign-'), 'ignore');
    writeFileSync(ignore, 'build/\n');
    globalConfig(`[core]\n\texcludesFile = ${ignore.split(path.sep).join('/')}\n`);
    process.env.WHY_DIFF_MAX_TIMED_BYTES = '10';
    const x = repo();
    mkdirSync(path.join(x.repo, 'build'));
    for (let i = 0; i < 5; i++) writeFileSync(path.join(x.repo, 'build', `m${i}.js`), 'export const x = 1;\n'.repeat(5));
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return [bash(t, 'npm run build')]; }, {
      statTime: async (p) => (path.resolve(p).startsWith(path.join(x.repo, 'build')) ? callAt + 1000 : (await lstat(p)).ctimeMs),
    });
    expect(res.block).toBe(false);
  });
});

describe('sec035 fix round 1 (F3, F5): submodules are based on their own session-start commit, and clean ones cost little', () => {
  function staleSubmodule(fetched: boolean): { repo: string; home: string; lib: string } {
    const upstream = temp('wd-s35-up-');
    mkdirSync(path.join(upstream, 'test'));
    writeFileSync(path.join(upstream, 'test', 'a.test.js'), testFile());
    git(upstream, ['init', '-q', '-b', 'main']);
    git(upstream, ['add', '-A']);
    git(upstream, ['commit', '-qm', 'C1'], PAST);
    const x = repo('wd-s35-stale-');
    git(x.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'lib']);
    git(x.repo, ['commit', '-qm', 'lib at C1'], PAST);
    writeFileSync(path.join(upstream, 'test', 'b.test.js'), testFile());
    git(upstream, ['add', '-A']);
    git(upstream, ['commit', '-qm', 'C2'], PAST);
    const c2 = git(upstream, ['rev-parse', 'HEAD']).trim();
    const lib = path.join(x.repo, 'lib');
    if (fetched) git(lib, ['-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin'], PAST);
    git(x.repo, ['update-index', '--cacheinfo', `160000,${c2},lib`]);
    git(x.repo, ['commit', '-qm', 'bump lib'], PAST);
    return { ...x, lib };
  }

  it('a submodule behind its gitlink whose new commit was never fetched does not block a source-only edit', async () => {
    const x = staleSubmodule(false);
    const src = path.join(x.repo, 'src', 'f.js');
    replaceIn(src, 'x;', 'x + 0;');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, src, 'x;', 'x + 0;')]);
    expect(res.message ?? '').toBe('');
    expect(res.block).toBe(false);
  });

  it('a fetched but not checked-out gitlink commit is not credited when the agent refreshes the submodule index', async () => {
    const x = staleSubmodule(true);
    const src = path.join(x.repo, 'src', 'f.js');
    replaceIn(src, 'x;', 'x + 0;');
    const subGit = path.join(x.repo, '.git', 'modules', 'lib');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return [edit(t, src, 'x;', 'x + 0;'), bash(t + 5000, 'git status')]; }, {
      statTime: async (p) => (path.resolve(p).startsWith(subGit) ? callAt + 6000 : (await lstat(p)).ctimeMs),
    });
    expect(res.message ?? '').toBe('');
    expect(res.block).toBe(false);
  });

  it('session-start records each checked-out submodule head', async () => {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = staleSubmodule(true);
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    const rec = JSON.parse(readFileSync(path.join(data, 'sessions', `${hash(SID)}.json`), 'utf8')) as { submodules?: Record<string, { head: string; rootDev?: number; gitDev?: number }> };
    expect(rec.submodules?.lib?.head).toBe(git(x.lib, ['rev-parse', 'HEAD']).trim());
    expect(typeof rec.submodules?.lib?.rootDev).toBe('number');
    expect(typeof rec.submodules?.lib?.gitDev).toBe('number');
  });

  it('a clean submodule of 5000 files adds little to a source-only session', async () => {
    const lib = temp('wd-s35-big-');
    for (let d = 0; d < 50; d++) {
      mkdirSync(path.join(lib, `d${d}`));
      for (let i = 0; i < 100; i++) writeFileSync(path.join(lib, `d${d}`, `f${i}.test.js`), `it("x${i}",()=>{});\n`);
    }
    git(lib, ['init', '-q', '-b', 'main']);
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'big'], PAST);
    const x = repo('wd-s35-bigsup-');
    git(x.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
    git(x.repo, ['commit', '-qm', 'big lib'], PAST);
    const src = path.join(x.repo, 'src', 'f.js');
    replaceIn(src, 'x;', 'x + 0;');
    let walked = 0;
    const t0 = Date.now();
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, src, 'x;', 'x + 0;')], {
      // Its index and refs were written before the session (as they would be): not after the last call.
      statTime: async (p) => (path.resolve(p).startsWith(path.join(x.repo, '.git')) ? Date.now() - 3600_000 : (await lstat(p)).ctimeMs),
      pathStat: async (p) => {
        if (p.includes(`${path.sep}lib${path.sep}d`)) walked++;
        const st = await lstat(p);
        return { dev: Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
      },
    });
    expect(res.block).toBe(false);
    expect(walked).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});

describe('sec035 fix round 1 (F4): a linked worktree on another device than its repository', () => {
  it('times of the common git dir are compared with the common dir, not with the worktree root', async () => {
    const x = repo();
    const wt = path.join(temp('wd-s35-wt-'), 'wt');
    git(x.repo, ['worktree', 'add', '-q', '-b', 'feature', wt]);
    const src = path.join(wt, 'src', 'f.js');
    replaceIn(src, 'x;', 'x + 0;');
    const res = await guardRun(wt, x.home, (t) => [edit(t, src, 'x;', 'x + 0;')], {
      // The main repository (and its common git dir: objects, refs) sits on another device than the worktree.
      pathStat: async (p) => {
        const st = await lstat(p);
        const onMain = path.resolve(p) === x.repo || path.resolve(p).startsWith(`${x.repo}${path.sep}`);
        return { dev: onMain ? Number(st.dev) + 1000 : Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
      },
    });
    expect(res.message ?? '').toBe('');
    expect(res.block).toBe(false);
  });
});

describe('sec035 fix round 1 (F6): git status never recurses into submodules', () => {
  it('status gets --ignore-submodules=dirty', () => {
    const args = gitModule.hardenedInvocation(['status', '--porcelain']).args;
    expect(args).toContain('--ignore-submodules=dirty');
  });
});

describe('sec035 fix round 1 (A, B, D): submodule file systems and index flags', () => {
  function withSub(): { repo: string; home: string; tp: string; libTest: string; subGit: string } {
    const lib = temp('wd-s35-ad-lib-');
    mkdirSync(path.join(lib, 'test'));
    writeFileSync(path.join(lib, 'test', 'a.test.js'), testFile());
    git(lib, ['init', '-q', '-b', 'main']);
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'lib'], PAST);
    const x = repo('wd-s35-ad-');
    git(x.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
    git(x.repo, ['commit', '-qm', 'submodule'], PAST);
    return { ...x, libTest: path.join(x.repo, 'lib', 'test', 'a.test.js'), subGit: path.join(x.repo, '.git', 'modules', 'lib') };
  }
  /** Everything under .git reads as written before the session; the submodule's test file as rewritten during the call. */
  const quietGit = (x: { repo: string; libTest: string }, callAt: () => number) => async (p: string): Promise<number> => {
    const r = path.resolve(p);
    if (r === x.libTest) return callAt() + 1000;
    return r.startsWith(path.join(x.repo, '.git')) ? Date.now() - 3600_000 : (await lstat(p)).ctimeMs;
  };

  it('B: matching recorded devices do not excuse an untrusted file system type', async () => {
    const data = temp('wd-s35-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    await recordSessionStart({ session_id: SID, cwd: x.repo });
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return [bash(t, 'echo hi')]; }, {
      statTime: async (p) => (path.resolve(p).startsWith(path.join(data, 'sessions')) ? callAt - 5000 : (await lstat(p)).ctimeMs),
      fsType: async (p: string) => (p.startsWith(data) ? 'apfs' : 'msdos'),
    } as Partial<GuardOptions>);
    expect(res.block).toBe(true);
    expect(res.message).toContain('msdos');
  });

  it('A: a submodule git dir on an untrusted file system type blocks', async () => {
    const x = withSub();
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], { fsType: async (p: string) => (path.resolve(p).startsWith(x.subGit) ? 'msdos' : 'apfs') } as Partial<GuardOptions>);
    expect(res.block).toBe(true);
    expect(res.message).toContain('lib');
  });

  it('A: a submodule git dir on another device, with no recorded device, blocks when the submodule changed; not when it is clean', async () => {
    const x = withSub();
    const pathStat = async (p: string) => {
      const st = await lstat(p);
      const hit = path.resolve(p) === x.subGit || path.resolve(p).startsWith(`${x.subGit}${path.sep}`);
      return { dev: hit ? Number(st.dev) + 1000 : Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
    };
    const clean = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], { pathStat });
    expect(clean.message ?? '').toBe('');
    replaceIn(x.libTest, 'it("t5"', 'it.skip("t5"');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return [bash(t, 'bash /tmp/x.sh')]; }, { pathStat, statTime: quietGit(x, () => callAt) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('lib');
  });

  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    it(`D: a ${flag} test file in a submodule, skipped by an unnamed command, blocks`, async () => {
      const x = withSub();
      git(path.join(x.repo, 'lib'), ['update-index', flag, 'test/a.test.js']);
      replaceIn(x.libTest, 'it("t5"', 'it.skip("t5"');
      let callAt = 0;
      const res = await guardRun(x.repo, x.home, (t) => { callAt = t; return [bash(t, 'bash /tmp/x.sh')]; }, { statTime: quietGit(x, () => callAt) });
      expect(res.block).toBe(true);
      expect(res.message).toContain('lib/test/a.test.js');
    });
  }
});

describe('sec035 fix round 1 (E, F): the Windows file system type', () => {
  it('runs PowerShell and fsutil by absolute path, in the temporary directory, without a shell', () => {
    const cmds = windowsVolumeCommands("C:\\work\\it's\\repo", 'C:\\');
    expect(cmds.map((c) => path.basename(c.file).toLowerCase())).toEqual(['powershell.exe', 'fsutil.exe']);
    for (const c of cmds) {
      expect(path.isAbsolute(c.file) || /^[A-Za-z]:\\/.test(c.file)).toBe(true);
      expect(c.file.toLowerCase()).toContain('system32');
      expect(c.options.cwd).toBe(os.tmpdir());
      expect(c.options.shell).toBe(false);
      expect(c.options.windowsHide).toBe(true);
    }
    // The path is one single-quoted PowerShell string (quotes doubled).
    expect(cmds[0]!.args.join(' ')).toContain("-FilePath 'C:\\work\\it''s\\repo'");
  });

  it.skipIf(posix)('a test directory replaced by a junction is a deletion (junctions are never followed)', async () => {
    const x = repo();
    const kept = path.join(temp('wd-s35-junc-'), 'kept');
    renameSync(path.join(x.repo, 'test'), kept);
    symlinkSync(kept, path.join(x.repo, 'test'), 'junction');
    expect((await lstat(path.join(x.repo, 'test'))).isSymbolicLink()).toBe(true);
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'tidy.cmd')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain(TEST);
  });
});
