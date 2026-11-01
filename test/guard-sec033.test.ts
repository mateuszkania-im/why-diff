/**
 * Regression tests for guard bypasses found in the 0.3.2 security review (sec033): a session base
 * forged through the reflog or a reset, a test file untracked by a command that does not name it,
 * a weakening kept only in a commit or the index, and the hook timeout with many untracked files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
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
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')]);
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
    const res = await guardRun(x.repo, x.home, (t) => [bash(t, 'echo hi')], { objectTime: objectsAfter(() => mark) });
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
