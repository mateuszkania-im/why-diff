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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
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
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
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
