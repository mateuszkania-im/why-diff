/**
 * Regression tests for guard bypasses found in the 0.3.2 security review (sec033): a session base
 * forged through the reflog or a reset, a test file untracked by a command that does not name it,
 * a weakening kept only in a commit or the index, and the hook timeout with many untracked files.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
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
/** Session start (a minute ago); everything committed before it is dated an hour ago. */
const PAST = iso(Date.now() - 3600_000);
const GIT_ENV = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
function git(cwd: string, args: string[], date?: string, input?: string): string {
  const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, ...dates } });
}
function testFile(skip5 = false, extra = ''): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 10; i++) s += `it${skip5 && i === 5 ? '.skip' : ''}("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s + extra;
}
const TEST = 'test/a.test.js';

function repo(): { repo: string; home: string; tp: string } {
  const r = temp('wd-s33-repo-');
  mkdirSync(path.join(r, 'test'));
  mkdirSync(path.join(r, 'src'));
  writeFileSync(path.join(r, 'src', 'f.js'), 'export const f = (x) => x;\n');
  git(r, ['init', '-q', '-b', 'main']);
  return { repo: r, home: temp('wd-s33-home-'), tp: path.join(r, TEST) };
}
/** Commit everything, dated before the session (reflog entry included). Returns the commit id. */
function commit(r: string, msg: string): string {
  git(r, ['add', '-A']);
  git(r, ['commit', '-qm', msg], PAST);
  return git(r, ['rev-parse', 'HEAD']).trim();
}
const replaceIn = (f: string, a: string, b: string): void => writeFileSync(f, readFileSync(f, 'utf8').replace(a, b));
const edit = (at: number, tp: string, a: string, b: string): SyntheticCall => ({ tool: 'Edit', at: iso(at), resultAt: iso(at + 4000), input: { file_path: tp, old_string: a, new_string: b } });
const bash = (at: number, command: string, dur = 4000): SyntheticCall => ({ tool: 'Bash', at: iso(at), resultAt: iso(at + dur), input: { command, description: 'x' } });

/**
 * Object write times by commit: each listed commit's loose object reads as written at the given
 * (pre-session) time, everything else as written long ago. A missing file still throws.
 */
function objectTimes(r: string, times: Record<string, number>): (p: string) => Promise<number> {
  const bySuffix = new Map(Object.entries(times).map(([sha, t]) => [path.join(sha.slice(0, 2), sha.slice(2)), t]));
  return async (p) => {
    await lstat(p);
    for (const [suffix, t] of bySuffix) if (p.endsWith(suffix)) return t;
    return 0;
  };
}

/**
 * Objects whose files changed before `mark()` read as written long before the session; later ones
 * (written by the test's "agent" commands) by their real ctime, which lies after the session start.
 */
function objectsAfter(mark: () => number): (p: string) => Promise<number> {
  return async (p) => {
    const st = await lstat(p);
    return st.ctimeMs >= mark() ? st.ctimeMs : 0;
  };
}
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A session that started a minute ago; its calls start 50 s ago (outside any window for files changed now). */
async function guardRun(r: string, home: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> = {}): Promise<{ block: boolean; message?: string; hits: string[] }> {
  const start = Date.now() - 60_000;
  const transcript = writeSyntheticTranscript(home, r, 's33', [{ prompt: 'make the suite green', at: iso(start), calls: calls(start + 10_000) }]);
  return runGuard({ transcript_path: transcript, cwd: r, session_id: 's33' }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return 0; }, ...opts });
}

/** A file under `.git` (index, refs, reflog) reads as changed during the call at `callAt()`; anything else by its real ctime. */
function gitMetaInWindow(r: string, callAt: () => number): (p: string) => Promise<number> {
  const gitDir = path.join(r, '.git') + path.sep;
  return async (p) => {
    const st = await lstat(p);
    return path.resolve(p).startsWith(gitDir) ? callAt() + 1000 : st.ctimeMs;
  };
}

/** Like {@link gitMetaInWindow}, but `.git` files read as changed between the session start and its first call (outside every window). */
function gitMetaBeforeCalls(r: string, callAt: () => number): (p: string) => Promise<number> {
  const gitDir = path.join(r, '.git') + path.sep;
  return async (p) => {
    const st = await lstat(p);
    return path.resolve(p).startsWith(gitDir) ? callAt() - 5000 : st.ctimeMs;
  };
}

/** History: A (t5 skipped), then B (t5 un-skipped, one more assertion). Both before the session. */
function twoCommits(): { repo: string; home: string; tp: string; a: string; b: string } {
  const x = repo();
  writeFileSync(x.tp, testFile(true));
  const a = commit(x.repo, 'A: t5 skipped');
  writeFileSync(x.tp, testFile(false).replace('expect(f(3)).toBe(3);', 'expect(f(3)).toBe(3);\n  expect(f(3)).not.toBe(4);'));
  const b = commit(x.repo, 'B: unskip t5, add assertion');
  return { ...x, a, b };
}

describe('sec033 #1: the session base is the trusted commit written last, not the newest reflog date', () => {
  it('a backdated checkout round-trip (forged reflog pointing at an older commit) still diffs from HEAD', async () => {
    const { repo: r, home, tp, a, b } = twoCommits();
    git(r, ['checkout', '-q', 'HEAD~1'], PAST);
    git(r, ['checkout', '-q', 'main']);
    replaceIn(tp, 'it("t5"', 'it.skip("t5"');
    const res = await guardRun(r, home, (t) => [
      bash(t, `GIT_COMMITTER_DATE='${PAST}' git checkout -q HEAD~1 && git checkout -q main`),
      edit(t + 5000, tp, 'it("t5"', 'it.skip("t5"'),
    ], { objectTime: objectTimes(r, { [a]: 1000, [b]: 2000 }) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a reflog truncated to its first entry does not hide a deleted test file', async () => {
    const x = repo();
    writeFileSync(path.join(x.repo, 'README.md'), 'x\n');
    const a = commit(x.repo, 'A');
    writeFileSync(x.tp, testFile());
    const b = commit(x.repo, 'B: add tests');
    writeFileSync(path.join(x.repo, 'README.md'), 'y\n');
    const c = commit(x.repo, 'C');
    const log = path.join(x.repo, '.git', 'logs', 'HEAD');
    writeFileSync(log, readFileSync(log, 'utf8').split('\n')[0] + '\n');
    rmSync(x.tp);
    const res = await guardRun(x.repo, x.home, (t) => [
      bash(t, 'head -1 .git/logs/HEAD > .git/x && mv .git/x .git/logs/HEAD'),
      bash(t + 5000, `rm ${TEST}`),
    ], { objectTime: objectTimes(x.repo, { [a]: 1000, [b]: 2000, [c]: 3000 }) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('tests-disabled');
  });

  it('two commits from one pack (same write time): the descendant wins', async () => {
    const { repo: r, home, tp } = twoCommits();
    git(r, ['checkout', '-q', 'HEAD~1'], PAST);
    git(r, ['checkout', '-q', 'main']);
    replaceIn(tp, 'it("t5"', 'it.skip("t5"');
    // Every object reads as written at the same instant.
    const res = await guardRun(r, home, (t) => [edit(t, tp, 'it("t5"', 'it.skip("t5"')], { objectTime: async (p) => { await lstat(p); return 5000; } });
    expect(res.block).toBe(true);
  });
});

describe('sec033 #2: a base that is no longer an ancestor of HEAD is diffed as is, not via merge-base', () => {
  it('reset --hard HEAD~1 dropping a pre-session commit (re-skipping t5) blocks', async () => {
    const { repo: r, home, tp, a, b } = twoCommits();
    git(r, ['reset', '-q', '--hard', 'HEAD~1']);
    let callAt = 0;
    const res = await guardRun(r, home, (t) => {
      callAt = t;
      return [bash(t, 'git reset --hard HEAD~1')];
    }, {
      objectTime: objectTimes(r, { [a]: 1000, [b]: 2000 }),
      statTime: async (p) => (path.resolve(p) === path.resolve(tp) ? callAt + 1000 : (await lstat(p)).ctimeMs),
    });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('reset --soft HEAD~1 then an Edit re-adding the skip blocks', async () => {
    const { repo: r, home, tp, a, b } = twoCommits();
    git(r, ['reset', '-q', '--soft', 'HEAD~1']);
    replaceIn(tp, 'it("t5"', 'it.skip("t5"');
    const res = await guardRun(r, home, (t) => [bash(t, 'git reset --soft HEAD~1'), edit(t + 5000, tp, 'it("t5"', 'it.skip("t5"')], { objectTime: objectTimes(r, { [a]: 1000, [b]: 2000 }) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });
});

describe.skipIf(!posix)('sec033 #3: a test file untracked by a command that does not name it', () => {
  function setup(): { repo: string; home: string; tp: string } {
    const x = repo();
    writeFileSync(x.tp, testFile());
    writeFileSync(path.join(x.repo, 'test', 'b.test.js'), testFile());
    commit(x.repo, 'A');
    writeFileSync(path.join(x.repo, '.git', 'untrack.sh'), 'git ls-files -z | grep -z a.test | xargs -0 git rm -q --cached\necho "$(git ls-files -o | grep a.test)" >> .git/info/exclude\n');
    execFileSync('sh', ['.git/untrack.sh'], { cwd: x.repo, env: { ...process.env, ...GIT_ENV } });
    return x;
  }

  it('index only (file still on disk, excluded) blocks when the index changed during a call', async () => {
    const x = setup();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'sh .git/untrack.sh')];
    }, { statTime: gitMetaInWindow(x.repo, () => callAt) });
    expect(res.block).toBe(true);
    expect(res.message).toContain(TEST);
  });

  it('untracked and committed (gone from HEAD, still on disk) blocks', async () => {
    const x = setup();
    pause(20);
    const mark = Date.now();
    git(x.repo, ['commit', '-qm', 'wip']);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'sh .git/untrack.sh'), bash(t + 5000, 'git commit -qm wip')];
    }, { statTime: gitMetaInWindow(x.repo, () => callAt), objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
    expect(res.message).toContain(TEST);
  });

  it('is not credited when the index and refs last changed outside every call', async () => {
    const x = setup();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'echo hi')];
    }, { statTime: gitMetaBeforeCalls(x.repo, () => callAt) });
    expect(res.block).toBe(false);
  });
});

describe('sec033 #4: a weakening kept only in a commit or the index', () => {
  it('an Edit committed, then reverted in the working tree only, blocks', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    pause(20);
    const mark = Date.now();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    git(x.repo, ['commit', '-qam', 'fix flaky test']);
    replaceIn(x.tp, 'it.skip("t5"', 'it("t5"');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'git commit -qam "fix flaky test"'), edit(t + 10_000, x.tp, 'it.skip("t5"', 'it("t5"')];
    }, { statTime: gitMetaInWindow(x.repo, () => callAt), objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  const cacheinfo = (r: string, doCommit: boolean): void => {
    const blob = git(r, ['hash-object', '-w', '--stdin'], undefined, testFile().replace('it("t5"', 'it.skip("t5"')).trim();
    git(r, ['update-index', '--cacheinfo', `100644,${blob},${TEST}`]);
    if (doCommit) git(r, ['commit', '-qm', 'fix flaky test']);
  };
  for (const doCommit of [true, false]) {
    it(`a skipped test written with update-index --cacheinfo${doCommit ? ' and committed' : ', staged only'}, working tree untouched, blocks`, async () => {
      const x = repo();
      writeFileSync(x.tp, testFile());
      commit(x.repo, 'A');
      pause(20);
      const mark = Date.now();
      cacheinfo(x.repo, doCommit);
      let callAt = 0;
      const res = await guardRun(x.repo, x.home, (t) => {
        callAt = t;
        return [bash(t, 'B=$(sed s/x/y/ f | git hash-object -w --stdin) && git update-index --cacheinfo 100644,$B,f')];
      }, { statTime: gitMetaInWindow(x.repo, () => callAt), objectTime: objectsAfter(() => mark) });
      expect(res.block).toBe(true);
      expect(res.message).toContain('test-skip-added');
      // One finding, not one per layer (HEAD and index carry the same hunk).
      expect(res.hits.filter((h) => h.includes('test-skip-added'))).toHaveLength(1);
    });
  }

  it('a human commit outside every call is not credited', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    pause(20);
    const mark = Date.now();
    cacheinfo(x.repo, true);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'echo hi')];
    }, { objectTime: objectsAfter(() => mark), statTime: gitMetaBeforeCalls(x.repo, () => callAt) });
    expect(res.block).toBe(false);
  });
});

describe('sec033 #5: bounded work with many untracked files', () => {
  it('time-credited untracked files beyond 2000 are reported unreviewed without being read', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const gen = path.join(x.repo, 'gen');
    mkdirSync(gen);
    for (let i = 0; i < 2100; i++) writeFileSync(path.join(gen, `f${i}.js`), 'export const x = 1;\n');
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'node gen.js')];
    }, { statTime: async (p) => { await lstat(p); return callAt + 1000; } });
    expect(res.block).toBe(true);
    expect(res.message).toContain('unreviewed');
    expect(res.message).toContain('2000');
  }, 60_000);

  it('an expired internal deadline blocks with a clear message', async () => {
    process.env.WHY_DIFF_GUARD_DEADLINE_MS = '1';
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'a', 'b')]);
    expect(res.block).toBe(true);
    expect(res.message).toMatch(/did not finish within 0\.001 s|time limit/);
  });

  it('the deadline does not fire on a normal run', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    replaceIn(x.tp, 'expect(f(1)).toBe(1);', 'expect(f(1)).toBe(1);\n  expect(f(1)).toBeDefined();');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'expect(f(1)).toBe(1);', 'expect(f(1)).toBe(1);\n  expect(f(1)).toBeDefined();')]);
    expect(res.block).toBe(false);
  });
});

describe('sec033 #7: a flooded reflog cannot push the real base out of the candidates', () => {
  /** A1..A3 then B (HEAD), all before the session; HEAD's and main's reflogs rewritten to name only A1..A3. */
  function flooded(): { repo: string; home: string; tp: string; times: Record<string, number> } {
    const x = repo();
    const times: Record<string, number> = {};
    for (let i = 1; i <= 3; i++) {
      writeFileSync(x.tp, testFile(true, `// A${i}\n`));
      times[commit(x.repo, `A${i}`)] = i * 1000;
    }
    writeFileSync(x.tp, testFile(false, '// A3\n'));
    const b = commit(x.repo, 'B: unskip t5');
    times[b] = 9000;
    for (const log of [path.join(x.repo, '.git', 'logs', 'HEAD'), path.join(x.repo, '.git', 'logs', 'refs', 'heads', 'main')]) {
      writeFileSync(log, readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.includes(b)).join('\n') + '\n');
    }
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    return { ...x, times };
  }

  it('the first-parent candidate never takes a slot under the cap', async () => {
    process.env.WHY_DIFF_MAX_BASE_CANDIDATES = '3';
    const x = flooded();
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"')], { objectTime: objectTimes(x.repo, x.times) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('more qualifying reflog entries than the cap fails closed', async () => {
    process.env.WHY_DIFF_MAX_BASE_CANDIDATES = '2';
    const x = flooded();
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"')], { objectTime: objectTimes(x.repo, x.times) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('why-diff could not check this session');
    expect(res.message).toContain('reflog');
  });
});

describe('sec033 #8: index and ref dating is not hidden by a later git operation', () => {
  it('a staged weakening still blocks when the index was rewritten after the last call (an IDE git status)', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    pause(20);
    const mark = Date.now();
    const blob = git(x.repo, ['hash-object', '-w', '--stdin'], undefined, testFile().replace('it("t5"', 'it.skip("t5"')).trim();
    git(x.repo, ['update-index', '--cacheinfo', `100644,${blob},${TEST}`]);
    // Real ctimes: the index changed "now", after every call window (which ended 45 s ago).
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'B=$(sed s/x/y/ f | git hash-object -w --stdin) && git update-index --cacheinfo 100644,$B,f')], { objectTime: objectsAfter(() => mark) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a commit made in a call still blocks when only the index is later (one file inside a window is enough)', async () => {
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    pause(20);
    const mark = Date.now();
    const blob = git(x.repo, ['hash-object', '-w', '--stdin'], undefined, testFile().replace('it("t5"', 'it.skip("t5"')).trim();
    git(x.repo, ['update-index', '--cacheinfo', `100644,${blob},${TEST}`]);
    git(x.repo, ['commit', '-qm', 'fix flaky test']);
    let callAt = 0;
    const index = path.join(x.repo, '.git', 'index');
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'sh .git/c.sh'), bash(t + 20_000, 'echo hi')];
    }, {
      objectTime: objectsAfter(() => mark),
      // Refs inside the first call; the index (the latest) between the two calls: outside every window, not after the last.
      statTime: async (p) => (path.resolve(p) === index ? callAt + 12_000 : gitMetaInWindow(x.repo, () => callAt)(p)),
    });
    expect(res.block).toBe(true);
  });
});

describe('sec033 #9: an out-of-band base record from SessionStart', () => {
  /** A (t5 skipped) then B, both pre-session; the "agent" truncates both reflogs to A and resets to A. */
  async function setup(): Promise<{ repo: string; home: string; tp: string; a: string; b: string; data: string }> {
    const data = temp('wd-s33-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = twoCommits();
    await recordSessionStart({ session_id: 's33', cwd: x.repo });
    for (const log of [path.join(x.repo, '.git', 'logs', 'HEAD'), path.join(x.repo, '.git', 'logs', 'refs', 'heads', 'main')]) {
      writeFileSync(log, readFileSync(log, 'utf8').split('\n')[0] + '\n');
    }
    git(x.repo, ['reset', '-q', '--hard', x.a]);
    return { ...x, data };
  }
  const recordFile = (data: string): string => path.join(data, 'sessions', `${createHash('sha256').update('s33').digest('hex')}.json`);
  /** The record reads as written at session start; the test file as rewritten during the call. */
  const times = (x: { tp: string; data: string }, callAt: () => number, recordAt: (t: number) => number) => async (p: string): Promise<number> => {
    const st = await lstat(p);
    if (path.resolve(p) === path.resolve(recordFile(x.data))) return recordAt(callAt());
    if (path.resolve(p) === path.resolve(x.tp)) return callAt() + 1000;
    return st.ctimeMs;
  };

  it('session-start writes the record (0600) once, prints nothing, and never fails', async () => {
    const data = temp('wd-s33-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    writeFileSync(x.tp, testFile());
    const head = commit(x.repo, 'A');
    await recordSessionStart({ session_id: 's33', cwd: x.repo });
    const rec = JSON.parse(readFileSync(recordFile(data), 'utf8')) as { session_id: string; root: string; head: string; at: string };
    expect(rec).toMatchObject({ session_id: 's33', root: x.repo, head });
    if (posix) expect(statSync(recordFile(data)).mode & 0o777).toBe(0o600);
    // A second SessionStart for the same session (resume, compact) keeps the first record.
    writeFileSync(x.tp, testFile(true));
    commit(x.repo, 'B');
    await recordSessionStart({ session_id: 's33', cwd: x.repo });
    expect(JSON.parse(readFileSync(recordFile(data), 'utf8')).head).toBe(head);
    // Not a repository, no session id, garbage: no throw.
    await expect(recordSessionStart({ session_id: 'x', cwd: temp('wd-s33-plain-') })).resolves.toBeUndefined();
    await expect(recordSessionStart({})).resolves.toBeUndefined();
  });

  it('truncated reflogs plus reset --hard to an older commit block when the record names the real base', async () => {
    const x = await setup();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'head -1 .git/logs/HEAD > .git/x && mv .git/x .git/logs/HEAD && git reset --hard A')];
    }, { objectTime: objectTimes(x.repo, { [x.a]: 1000, [x.b]: 2000 }), statTime: times(x, () => callAt, (t) => t - 5000) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a record changed at or after the first call fails closed', async () => {
    const x = await setup();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'git reset --hard A')];
    }, { objectTime: objectTimes(x.repo, { [x.a]: 1000, [x.b]: 2000 }), statTime: times(x, () => callAt, (t) => t + 1000) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record modified during session');
  });

  it('a recorded head whose object was written during the session fails closed', async () => {
    const x = await setup();
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'git reset --hard A')];
    }, { objectTime: async (p) => (p.endsWith(path.join(x.b.slice(0, 2), x.b.slice(2))) ? Date.now() : objectTimes(x.repo, { [x.a]: 1000 })(p)), statTime: times(x, () => callAt, (t) => t - 5000) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('why-diff could not check this session');
  });

  it('a record for another repository is ignored (reflog fallback)', async () => {
    const data = temp('wd-s33-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const other = repo();
    writeFileSync(other.tp, testFile());
    commit(other.repo, 'other');
    await recordSessionStart({ session_id: 's33', cwd: other.repo });
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const res = await guardRun(x.repo, x.home, (t) => [edit(t, x.tp, 'expect(f(1)).toBe(1);', 'expect(f(1)).toBe(1);')], { statTime: async (p) => { await lstat(p); return Date.now() - 59_000; } });
    expect(res.block).toBe(false);
  });
});

describe('sec033 #9: the session-start command and its hook', () => {
  const root = path.resolve(__dirname, '..');
  const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
  const run = (cwd: string, input: string, data: string) =>
    spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), 'session-start'], { cwd, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data } });

  it('writes the record, prints only the SessionStart marker JSON and exits 0; garbage input and a plain directory exit 0 silently', () => {
    const data = temp('wd-s33-data-');
    const x = repo();
    writeFileSync(x.tp, testFile());
    const head = commit(x.repo, 'A');
    const ok = run(x.repo, JSON.stringify({ session_id: 'cli-1', cwd: x.repo, source: 'startup' }), data);
    expect(ok.status).toBe(0);
    const out = JSON.parse(ok.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain(`why-diff:base-record ${createHash('sha256').update('cli-1').digest('hex')}`);
    const file = path.join(data, 'sessions', `${createHash('sha256').update('cli-1').digest('hex')}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8')).head).toBe(head);
    for (const input of ['not json', '', JSON.stringify({ session_id: 'cli-2', cwd: temp('wd-s33-plain-') })]) {
      const r = run(x.repo, input, data);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('the plugin registers it as a SessionStart hook next to the Stop hook', () => {
    const hooks = JSON.parse(readFileSync(path.join(root, 'plugin', 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toContain('why-diff.mjs" guard');
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]?.command).toContain('why-diff.mjs" session-start');
  });
});

describe('sec033 #10: the base record cannot be deleted or sidestepped', () => {
  const hash = (id: string): string => createHash('sha256').update(id).digest('hex');
  /** Claude Code's transcript line for a SessionStart hook's output (shape taken from a real 2.1.x transcript). */
  const markerLine = (id: string, sessionId = 's33'): string => JSON.stringify({
    parentUuid: null, isSidechain: false, type: 'attachment', timestamp: iso(Date.now() - 61_000), sessionId,
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: '', exitCode: 0, command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/why-diff.mjs" session-start',
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `why-diff:base-record ${hash(id)}` } }) },
  });
  /** guardRun with the SessionStart attachment line put first in the transcript. */
  async function guardWithMarker(r: string, home: string, id: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> = {}) {
    const start = Date.now() - 60_000;
    const transcript = writeSyntheticTranscript(home, r, 's33', [{ prompt: 'make the suite green', at: iso(start), calls: calls(start + 10_000) }]);
    writeFileSync(transcript, `${markerLine(id)}\n${readFileSync(transcript, 'utf8')}`);
    return runGuard({ transcript_path: transcript, cwd: r, session_id: 's33' }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return 0; }, ...opts });
  }

  it('a deleted record blocks when the transcript shows the SessionStart marker', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s33-data-');
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const res = await guardWithMarker(x.repo, x.home, 's33', (t) => [bash(t, 'rm -rf ~/.cache/why-diff')]);
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record missing');
  });

  it('a record that no longer parses blocks as missing', async () => {
    const data = temp('wd-s33-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    await recordSessionStart({ session_id: 's33', cwd: x.repo });
    const file = path.join(data, 'sessions', `${hash('s33')}.json`);
    writeFileSync(file, '{not json');
    let callAt = 0;
    const res = await guardWithMarker(x.repo, x.home, 's33', (t) => {
      callAt = t;
      return [bash(t, 'echo hi')];
    }, { statTime: async (p) => (path.resolve(p) === path.resolve(file) ? callAt - 5000 : (await lstat(p)).ctimeMs) });
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record missing');
  });

  it("another session's marker does not count", async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s33-data-');
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const res = await guardWithMarker(x.repo, x.home, 'other-session', (t) => [bash(t, 'echo hi')], { statTime: async (p) => { await lstat(p); return Date.now() - 59_000; } });
    expect(res.block).toBe(false);
  });

  it.skipIf(!posix)('the record root is compared by realpath (a symlinked spelling still names this repository)', async () => {
    const data = temp('wd-s33-data-');
    process.env.CLAUDE_PLUGIN_DATA = data;
    const x = twoCommits();
    const link = path.join(temp('wd-s33-link-'), 'repo');
    symlinkSync(x.repo, link);
    const file = path.join(data, 'sessions', `${hash('s33')}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ session_id: 's33', root: link, head: x.b, at: iso(Date.now() - 60_000) }));
    for (const log of [path.join(x.repo, '.git', 'logs', 'HEAD'), path.join(x.repo, '.git', 'logs', 'refs', 'heads', 'main')]) {
      writeFileSync(log, readFileSync(log, 'utf8').split('\n')[0] + '\n');
    }
    git(x.repo, ['reset', '-q', '--hard', x.a]);
    let callAt = 0;
    const res = await guardRun(x.repo, x.home, (t) => {
      callAt = t;
      return [bash(t, 'git reset --hard A')];
    }, {
      objectTime: objectTimes(x.repo, { [x.a]: 1000, [x.b]: 2000 }),
      statTime: async (p) => {
        const st = await lstat(p);
        if (path.resolve(p) === path.resolve(file)) return callAt - 5000;
        if (path.resolve(p) === path.resolve(x.tp)) return callAt + 1000;
        return st.ctimeMs;
      },
    });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a record for a different repository falls back to the reflogs and says so in the debug notes', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s33-data-');
    const other = repo();
    writeFileSync(other.tp, testFile());
    commit(other.repo, 'other');
    await recordSessionStart({ session_id: 's33', cwd: other.repo });
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], { statTime: async (p) => { await lstat(p); return Date.now() - 59_000; } });
    expect(res.block).toBe(false);
    expect((res as { notes?: string[] }).notes?.join('\n')).toContain('another repository');
  });

  it('a record with no datable tool call fails closed', async () => {
    process.env.CLAUDE_PLUGIN_DATA = temp('wd-s33-data-');
    const x = repo();
    writeFileSync(x.tp, testFile());
    commit(x.repo, 'A');
    await recordSessionStart({ session_id: 's33', cwd: x.repo });
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    // A call whose timestamp cannot be read: an edit, but no window to date the record against.
    const res = await guardRun(x.repo, x.home, () => [{ ...edit(0, x.tp, 'it("t5"', 'it.skip("t5"'), at: 'not a date', resultAt: 'not a date' }]);
    expect(res.block).toBe(true);
    expect(res.message).toContain('base record cannot be dated');
  });
});
