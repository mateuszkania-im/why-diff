/**
 * Regression tests for guard bypasses found in the 0.3.1 security review (sec031): errors that let
 * the agent finish unchecked, argv overflow, a forged index entry, sparse checkout trust and
 * inherited GIT_* environment variables.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('sec031 #2/#8: a long pathspec list is matched once over the whole tree', () => {
  it('directory and glob pathspecs, deletions, flagged and untracked files all show; unnamed files do not', async () => {
    process.env.WHY_DIFF_ARGV_BUDGET = '300';
    const { repo, tp } = makeRepo((r) => {
      mkdirSync(path.join(r, 'lib', 'deep'), { recursive: true });
      writeFileSync(path.join(r, 'lib', 'deep', 'a.js'), 'export const a = 1;\n');
      writeFileSync(path.join(r, 'lib', 'gone.js'), 'export const g = 1;\n');
      writeFileSync(path.join(r, 'other.js'), 'export const o = 1;\n');
      sh(r, ['add', '-A']);
      sh(r, ['commit', '-qm', 'lib']);
    });
    skipT5(tp);
    sh(repo, ['update-index', '--skip-worktree', TEST]);
    writeFileSync(path.join(repo, 'lib', 'deep', 'a.js'), 'export const a = 2;\n');
    rmSync(path.join(repo, 'lib', 'gone.js'));
    writeFileSync(path.join(repo, 'src', 'new.js'), 'export const n = 1;\n');
    writeFileSync(path.join(repo, 'other.js'), 'export const o = 2;\n');
    const filler = Array.from({ length: 50 }, (_, i) => `:(literal)nothing/here-${i}.js`);
    const paths = [...filler, ':(literal)lib', ':(glob)test/*.test.js', ':(literal)src/new.js'];
    const { diff } = await getDiffDetailed(repo, { workingTree: true }, { paths, contentIndex: true });
    const hunks = parseUnifiedDiff(diff);
    expect(new Set(hunks.map((h) => h.file))).toEqual(new Set(['lib/deep/a.js', 'lib/gone.js', TEST, 'src/new.js']));
    expect(hunks.find((h) => h.file === 'lib/gone.js')?.status).toBe('deleted');
    expect(sh(repo, ['ls-files', '-v', TEST]).trim()).toBe(`S ${TEST}`);
  });
});

describe('sec031 #3: a forged stat-clean index entry cannot hide a change', () => {
  /** Index entry carries the old blob id but the stat data of the modified file: git diff sees nothing. */
  function forge(repo: string): void {
    const head = sh(repo, ['rev-parse', `HEAD:${TEST}`]).trim();
    // An mtime well before the index write, so git does not treat the entry as racily clean.
    const past = new Date(Date.now() - 120_000);
    utimesSync(path.join(repo, TEST), past, past);
    sh(repo, ['update-index', TEST]);
    const idx = path.join(repo, '.git', 'index');
    const buf = Buffer.from(readFileSync(idx));
    const at = buf.indexOf(Buffer.from(sh(repo, ['rev-parse', `:${TEST}`]).trim(), 'hex'));
    Buffer.from(head, 'hex').copy(buf, at);
    const body = buf.subarray(0, buf.length - 20);
    writeFileSync(idx, Buffer.concat([body, createHash('sha1').update(body).digest()]));
  }
  it('blocks on an it.skip edit whose index entry was forged back to the committed blob', async () => {
    const { repo, home, tp } = makeRepo();
    skipT5(tp);
    forge(repo);
    expect(sh(repo, ['diff', '--stat', 'HEAD'])).toBe('');
    const r = await guardRun(repo, home, (t) => [editCall(t, tp), bash(t + 5000, 'python3 tools/reindex.py')]);
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('the temporary index leaves nothing behind in the repository, even with core.splitIndex', async () => {
    const { repo, tp } = makeRepo((r) => {
      sh(r, ['config', 'core.splitIndex', 'true']);
      sh(r, ['update-index', '--split-index']);
    });
    skipT5(tp);
    sh(repo, ['update-index', '--skip-worktree', TEST]);
    const listing = (): string[] => readdirSync(path.join(repo, '.git')).sort();
    const before = listing();
    const { diff } = await getDiffDetailed(repo, { workingTree: true }, { paths: [`:(literal)${TEST}`], contentIndex: true });
    expect(diff).toContain('+it.skip("t5"');
    expect(listing()).toEqual(before);
    expect(sh(repo, ['ls-files', '-v', TEST]).trim()).toBe(`S ${TEST}`);
  });

  it('getDiffDetailed throws FailClosedError, not an unreviewed list, when the temporary index fails', async () => {
    const { repo, tp } = makeRepo();
    skipT5(tp);
    sh(repo, ['update-index', '--assume-unchanged', TEST]);
    for (const k of ['TMPDIR', 'TMP', 'TEMP']) process.env[k] = path.join(repo, 'no-such-dir', 'tmp');
    await expect(getDiffDetailed(repo, { workingTree: true })).rejects.toBeInstanceOf(FailClosedError);
  });
});

describe('sec031 #4: sparse checkout is trusted only from the repository\'s own config', () => {
  /** Sparse patterns (from before the session) that leave test/ out; the agent flags and deletes the test file. */
  function sparseRepo(): { repo: string; home: string; tp: string } {
    const made = makeRepo((r) => writeFileSync(path.join(r, '.git', 'info', 'sparse-checkout'), '/src/\n'));
    return made;
  }
  const flagAndDelete = (repo: string, tp: string): void => {
    sh(repo, ['update-index', '--skip-worktree', TEST]);
    rmSync(tp);
  };
  const cmd = (t: number): SyntheticCall[] => [bash(t, `git update-index --skip-worktree ${TEST} && rm ${TEST}`)];

  it('core.sparseCheckout from ~/.gitconfig does not excuse a deletion', async () => {
    const { repo, home, tp } = sparseRepo();
    const fakeHome = temp('wd-s31-gh-');
    writeFileSync(path.join(fakeHome, '.gitconfig'), '[core]\n\tsparseCheckout = true\n\tautocrlf = false\n');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    flagAndDelete(repo, tp);
    expect((await guardRun(repo, home, cmd)).block).toBe(true);
  });

  it('core.sparseCheckout from $XDG_CONFIG_HOME/git/config does not excuse a deletion', async () => {
    const { repo, home, tp } = sparseRepo();
    const xdg = temp('wd-s31-xdg-');
    mkdirSync(path.join(xdg, 'git'));
    writeFileSync(path.join(xdg, 'git', 'config'), '[core]\n\tsparseCheckout = true\n');
    process.env.XDG_CONFIG_HOME = xdg;
    flagAndDelete(repo, tp);
    expect((await guardRun(repo, home, cmd)).block).toBe(true);
  });

  it('core.sparseCheckout from a file included into the local config during the session does not excuse a deletion', async () => {
    const { repo, home, tp } = sparseRepo();
    const inc = path.join(temp('wd-s31-inc-'), 'sparse.cfg');
    writeFileSync(inc, '[core]\n\tsparseCheckout = true\n');
    sh(repo, ['config', 'include.path', inc]);
    flagAndDelete(repo, tp);
    const objectTime = async (p: string): Promise<number> => (path.resolve(p) === path.resolve(inc) ? (await lstat(p)).ctimeMs : oldObjects(p));
    expect((await guardRun(repo, home, cmd, { objectTime })).block).toBe(true);
  });

  it('core.sparseCheckout from GIT_CONFIG_COUNT in the environment does not excuse a deletion', async () => {
    const { repo, home, tp } = sparseRepo();
    const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
    process.env[`GIT_CONFIG_KEY_${n}`] = 'core.sparseCheckout';
    process.env[`GIT_CONFIG_VALUE_${n}`] = 'true';
    process.env.GIT_CONFIG_COUNT = String(n + 1);
    flagAndDelete(repo, tp);
    expect((await guardRun(repo, home, cmd)).block).toBe(true);
  });

  it('control: the same sparse checkout in the local config, set up before the session, excuses the missing file', async () => {
    const { repo, home, tp } = sparseRepo();
    sh(repo, ['config', 'core.sparseCheckout', 'true']);
    flagAndDelete(repo, tp);
    expect((await guardRun(repo, home, cmd)).block).toBe(false);
  });
});

describe('sec031 #5/#6: only files the sparse patterns leave out may be missing', () => {
  it('a sparse checkout that includes everything does not excuse deleting a flagged test file', async () => {
    const { repo, home, tp } = makeRepo((r) => {
      sh(r, ['config', 'core.sparseCheckout', 'true']);
      writeFileSync(path.join(r, '.git', 'info', 'sparse-checkout'), '/*\n');
    });
    sh(repo, ['update-index', '--skip-worktree', TEST]);
    rmSync(tp);
    expect((await guardRun(repo, home, (t) => [bash(t, `git update-index --skip-worktree ${TEST} && rm ${TEST}`)])).block).toBe(true);
  });

  function coneRepo(): { repo: string; home: string; tp: string } {
    return makeRepo((r) => {
      writeFileSync(path.join(r, 'src', 'f.test.js'), testFile());
      sh(r, ['add', '-A']);
      sh(r, ['commit', '-qm', 'src test']);
      sh(r, ['sparse-checkout', 'set', '--cone', 'src']);
    });
  }
  it('cone mode: deleting a flagged in-cone test file blocks', async () => {
    const { repo, home } = coneRepo();
    const inCone = path.join(repo, 'src', 'f.test.js');
    sh(repo, ['update-index', '--skip-worktree', 'src/f.test.js']);
    rmSync(inCone);
    expect((await guardRun(repo, home, (t) => [bash(t, 'git update-index --skip-worktree src/f.test.js && rm src/f.test.js')])).block).toBe(true);
  });
  it('cone mode: an out-of-cone file missing from the working tree is no deletion', async () => {
    const { repo, home, tp } = coneRepo();
    expect(() => readFileSync(tp)).toThrow();
    expect((await guardRun(repo, home, (t) => [bash(t, `rm -f ${TEST}`)])).block).toBe(false);
  });
  it('cone mode: patterns changed during the session are not trusted', async () => {
    const { repo, home } = makeRepo();
    sh(repo, ['sparse-checkout', 'set', '--cone', 'src']);
    const objectTime = async (p: string): Promise<number> => (/sparse-checkout$/.test(p) ? (await lstat(p)).ctimeMs : oldObjects(p));
    let callAt = 0;
    const statTime = async (p: string): Promise<number> => { await lstat(p); return callAt + 1000; };
    const r = await guardRun(repo, home, (t) => {
      callAt = t;
      return [bash(t, 'git sparse-checkout set --cone src')];
    }, { objectTime, statTime });
    expect(r.block).toBe(true);
  });

  it('touching the config and the repo root during the session does not turn out-of-cone files into deletions', async () => {
    const { repo, home } = makeRepo((r) => {
      mkdirSync(path.join(r, 'vendor', 'pkg'), { recursive: true });
      writeFileSync(path.join(r, 'vendor', 'pkg', 'x.test.js'), testFile());
      sh(r, ['add', '-A']);
      sh(r, ['commit', '-qm', 'vendor']);
      sh(r, ['sparse-checkout', 'set', '--cone', 'src', 'test']);
    });
    expect(() => readFileSync(path.join(repo, 'vendor', 'pkg', 'x.test.js'))).toThrow();
    sh(repo, ['config', 'core.editor', 'vi']);
    let callAt = 0;
    // The config file and the repo root (where notes.md was written) changed during the call.
    const objectTime = async (p: string): Promise<number> => (/[\\/]config(\.worktree)?$/.test(p) ? callAt + 1000 : oldObjects(p));
    const statTime = async (p: string): Promise<number> => (path.resolve(p) === path.resolve(repo) ? callAt + 1000 : (await lstat(p)).ctimeMs);
    writeFileSync(path.join(repo, 'notes.md'), 'x\n');
    const r = await guardRun(repo, home, (t) => {
      callAt = t;
      return [bash(t, 'git config core.editor vi && touch notes.md')];
    }, { objectTime, statTime });
    expect(r.hits).toEqual([]);
    expect(r.block).toBe(false);
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

