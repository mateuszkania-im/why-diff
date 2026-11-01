import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, runGuard } from '../src/guard.js';
import type { LabelKind } from '../src/types.js';
import { shellPath, tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';
import { bestOfAsync, expectSubQuadratic } from './helpers/perf.js';

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

function makeRepo(realRoot = true): { repo: string; home: string; stateDir: string } {
  const repo = realRoot ? temp('why-diff-guard-repo-') : mkdtempSync(path.join(os.tmpdir(), 'why-diff-guard-sym-'));
  if (!realRoot) dirs.push(repo);
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

  describe('shell deletes and renames of tests', () => {
    const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path']);
    async function run(cmd: string | null, act: (repo: string) => void, blocking = BL, seed?: (repo: string) => void): Promise<{ block: boolean; message?: string }> {
      const { repo, home, stateDir } = makeRepo();
      mkdirSync(path.join(repo, 'src'), { recursive: true });
      writeFileSync(path.join(repo, 'src', 'x.js'), 'export const x = 1;\n');
      seed?.(repo);
      sh(repo, ['add', '-A']);
      sh(repo, ['commit', '-qm', 'more'], LONG_AGO);
      const calls: SyntheticCall[] = [{ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'src', 'x.js'), old_string: 'x = 1', new_string: 'x = 2' } }];
      if (cmd) calls.push({ tool: 'Bash', at: CALL_AT, input: { command: cmd.replaceAll('$R', shellPath(repo)), description: 'x' } });
      const transcript = writeSyntheticTranscript(home, repo, 's-sh', [{ prompt: 'tidy up', at: SESSION_AT, calls }]);
      writeFileSync(path.join(repo, 'src', 'x.js'), 'export const x = 2;\n');
      act(repo);
      return runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-sh' }, { blocking, home, stateDir });
    }
    it('blocks on rm of a test file', async () => {
      const r = await run('rm $R/test/f.test.js', (repo) => rmSync(path.join(repo, 'test', 'f.test.js')));
      expect(r.block).toBe(true);
      expect(r.message).toContain('test/f.test.js');
    });
    it('blocks on git rm of a test file', async () => {
      const r = await run('cd $R && git rm test/f.test.js', (repo) => sh(repo, ['rm', '-q', 'test/f.test.js']));
      expect(r.block).toBe(true);
    });
    it('blocks on mv that disables a test file', async () => {
      const r = await run('mv $R/test/f.test.js $R/test/f.test.js.disabled', (repo) => sh(repo, ['mv', 'test/f.test.js', 'test/f.test.js.disabled']));
      expect(r.block).toBe(true);
    });
    it('blocks on git rm -r of the test directory', async () => {
      const r = await run('cd $R && git rm -r test', (repo) => sh(repo, ['rm', '-rq', 'test']));
      expect(r.block).toBe(true);
    });
    it('blocks on rm -rf of the test directory', async () => {
      const r = await run('rm -rf $R/test/', (repo) => rmSync(path.join(repo, 'test'), { recursive: true }));
      expect(r.block).toBe(true);
    });
    it('counts a relative git mv of the test directory (test-modified is blocking here: the files keep test names)', async () => {
      const r = await run('cd $R && git mv test old-test', (repo) => sh(repo, ['mv', 'test', 'old-test']), new Set<LabelKind>(['test-modified']));
      expect(r.block).toBe(true);
    });
    it('does not credit a shell rename when a human also changed lines in the renamed file', async () => {
      const r = await run('mv $R/test/f.test.js $R/test/g.test.js', (repo) => {
        sh(repo, ['mv', 'test/f.test.js', 'test/g.test.js']);
        const g = path.join(repo, 'test', 'g.test.js');
        writeFileSync(g, readFileSync(g, 'utf8').replace('  expect(f(7)).toBe(7);\n', ''));
      });
      expect(r.block).toBe(false);
    });
    it('blocks on rm with a glob that covers the test file', async () => {
      const r = await run('cd $R && rm test/*.test.js', (repo) => rmSync(path.join(repo, 'test', 'f.test.js')));
      expect(r.block).toBe(true);
      expect(r.message).toContain('test/f.test.js');
    });
    it('blocks on rm -f with a ** glob across directories', async () => {
      const r = await run('cd $R && rm -f tests/**/*.spec.ts', (repo) => rmSync(path.join(repo, 'tests', 'unit', 'a.spec.ts')), BL, (repo) => {
        mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true });
        writeFileSync(path.join(repo, 'tests', 'unit', 'a.spec.ts'), testFile());
      });
      expect(r.block).toBe(true);
      expect(r.message).toContain('tests/unit/a.spec.ts');
    });
    it('blocks on rm -rf with a glob that covers a nested test file', async () => {
      const r = await run('cd $R && rm -rf test/*', (repo) => rmSync(path.join(repo, 'test', 'unit'), { recursive: true }), BL, (repo) => {
        mkdirSync(path.join(repo, 'test', 'unit'), { recursive: true });
        writeFileSync(path.join(repo, 'test', 'unit', 'a.test.js'), testFile());
      });
      expect(r.block).toBe(true);
      expect(r.message).toContain('test/unit/a.test.js');
    });
    it('blocks on mv -t into a target directory', async () => {
      const r = await run('cd $R && mv -t old test/f.test.js', (repo) => {
        mkdirSync(path.join(repo, 'old'));
        sh(repo, ['mv', 'test/f.test.js', 'old/f.test.js']);
      }, new Set<LabelKind>(['tests-disabled', 'test-modified']));
      expect(r.block).toBe(true);
    });
    it('blocks on git mv -k', async () => {
      const r = await run('cd $R && git mv -k test/f.test.js test/f.test.js.bak', (repo) => sh(repo, ['mv', 'test/f.test.js', 'test/f.test.js.bak']));
      expect(r.block).toBe(true);
    });
    it('blocks on rm -- file', async () => {
      const r = await run('cd $R && rm -- test/f.test.js', (repo) => rmSync(path.join(repo, 'test', 'f.test.js')));
      expect(r.block).toBe(true);
    });
    it('does not block when the session only removed an unrelated file and a human deleted a test', async () => {
      const r = await run('cd $R && rm src/tmp.js', (repo) => {
        rmSync(path.join(repo, 'src', 'tmp.js'));
        rmSync(path.join(repo, 'test', 'f.test.js'));
      }, BL, (repo) => writeFileSync(path.join(repo, 'src', 'tmp.js'), 'export const t = 1;\n'));
      expect(r.block).toBe(false);
    });
    describe('shell edits of a test file', () => {
      const skipT5 = (repo: string) => applyEdit(repo, SKIP_OLD, SKIP_NEW);
      const weaken = (repo: string) => applyEdit(repo, ASSERT_OLD.replace('toBe(2)', 'toBe(2)'), '  expect(f(2)).toBeTruthy();\n');
      const empty = (repo: string) => writeFileSync(path.join(repo, 'test', 'f.test.js'), '');
      const forms: Array<[string, string, (repo: string) => void]> = [
        ['sed -i', `cd $R && sed -i 's/it("t5"/it.skip("t5"/' test/f.test.js`, skipT5],
        ['sed -i with a glob', `cd $R && sed -i '' -e 's/toBe(2)/toBeTruthy()/' test/*.test.js`, weaken],
        ['perl -pi', `perl -pi -e 's/toBe\\(2\\)/toBeTruthy()/' $R/test/f.test.js`, weaken],
        ['a > redirect', 'cd $R && : > test/f.test.js', empty],
        ['tee', 'cd $R && echo "" | tee test/f.test.js', empty],
        ['cp /dev/null', 'cp /dev/null $R/test/f.test.js', empty],
        ['truncate', 'truncate -s 0 $R/test/f.test.js', empty],
        ['a python heredoc', `cd $R && python3 - <<'EOF'\np = "test/f.test.js"\nopen(p, "w").write(open(p).read().replace("toBe(2)", "toBeTruthy()"))\nEOF`, weaken],
        ['python -c', `cd $R && python3 -c "open('test/f.test.js','w').write('')"`, empty],
        ['node -e', `cd $R && node -e "require('fs').writeFileSync('test/f.test.js','')"`, empty],
      ];
      for (const [name, cmd, act] of forms) {
        it(`blocks on ${name}`, async () => {
          const r = await run(cmd, act);
          expect(r.block).toBe(true);
          expect(r.message).toContain('test/f.test.js');
        });
      }
      it('does not credit a human edit in a test file when the session only edited another file through the shell', async () => {
        const r = await run(`cd $R && sed -i 's/x = 1/x = 3/' src/x.js`, (repo) => {
          writeFileSync(path.join(repo, 'src', 'x.js'), 'export const x = 3;\n');
          skipT5(repo);
        });
        expect(r.block).toBe(false);
      });
      it('does not credit a human edit when the command only reads the test file', async () => {
        const r = await run('cd $R && cat test/f.test.js > /dev/null && grep -c it test/f.test.js', skipT5);
        expect(r.block).toBe(false);
      });
    });
    it('does not block on a human rm with no transcript edit', async () => {
      const r = await run(null, (repo) => rmSync(path.join(repo, 'test', 'f.test.js')));
      expect(r.block).toBe(false);
    });
  });

  it('keeps every session entry when guards for different sessions run in parallel', async () => {
    const { repo, home, stateDir } = makeRepo();
    const ids = ['s-par-1', 's-par-2', 's-par-3', 's-par-4', 's-par-5', 's-par-6'];
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const transcripts = ids.map((id) => writeSyntheticTranscript(home, repo, id, [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]));
    const results = await Promise.all(ids.map((id, i) => runGuard({ transcript_path: transcripts[i], cwd: repo, session_id: id }, { blocking: BLOCKING, home, stateDir })));
    expect(results.every((r) => r.block)).toBe(true);
    const state = JSON.parse(readFileSync(path.join(stateDir, 'guard-state.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(ids);
  });

  describe('state lock never hangs the guard', () => {
    const old = new Date(Date.now() - 3600_000);
    it('a lock path that is a directory: the decision comes back quickly', async () => {
      const { repo, home, stateDir } = makeRepo();
      mkdirSync(path.join(stateDir, 'guard-state.json.lock'));
      utimesSync(path.join(stateDir, 'guard-state.json.lock'), old, old);
      const transcript = writeSyntheticTranscript(home, repo, 's-lockdir', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      const t0 = Date.now();
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-lockdir' }, { blocking: BLOCKING, home, stateDir });
      expect(r.block).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5000);
    }, 10_000);

    // chmod 0o555 does not stop deleting files on Windows.
    it.skipIf(process.platform === 'win32')('a stale lock that cannot be removed: acquireLock gives up instead of looping', async () => {
      const dir = temp('why-diff-guard-lockro-');
      const lock = path.join(dir, 'state.lock');
      writeFileSync(lock, '1');
      utimesSync(lock, old, old);
      chmodSync(dir, 0o555);
      try {
        const t0 = Date.now();
        expect(await acquireLock(lock, { waitMs: 200, staleMs: 1000 })).toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        chmodSync(dir, 0o755);
      }
    }, 10_000);

    it('releases only its own lock: a lock taken over by another writer is left alone', async () => {
      const dir = temp('why-diff-guard-lockown-');
      const lock = path.join(dir, 'state.lock');
      const token = await acquireLock(lock);
      expect(token).toEqual(expect.any(String));
      writeFileSync(lock, 'someone-else');
      await releaseLock(lock, token!);
      expect(readFileSync(lock, 'utf8')).toBe('someone-else');
      writeFileSync(lock, token!);
      await releaseLock(lock, token!);
      expect(existsSync(lock)).toBe(false);
    });

    it('a stale lock that is re-created all the time: acquireLock stops at the deadline', async () => {
      const dir = temp('why-diff-guard-lockre-');
      const lock = path.join(dir, 'state.lock');
      // Another writer keeps putting back a stale-looking lock (a hostile or broken peer).
      const keep = setInterval(() => {
        try { writeFileSync(lock, '1'); utimesSync(lock, old, old); } catch { /* racing */ }
      }, 0);
      try {
        const t0 = Date.now();
        await acquireLock(lock, { waitMs: 300, staleMs: 1000 });
        expect(Date.now() - t0).toBeLessThan(3000);
      } finally {
        clearInterval(keep);
      }
    }, 10_000);
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

  it('blocks when the transcript uses a symlinked (non-realpath) location of the repo', async () => {
    const { repo, home, stateDir } = makeRepo(false);
    const transcript = writeSyntheticTranscript(home, repo, 's-sym', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-sym' }, { blocking: BLOCKING, home, stateDir });
    expect(r.block).toBe(true);
  });

  it('does not create .why-diff on a clean turn', async () => {
    const { repo, home } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-clean', [{ prompt: 'add an assertion to t2', at: SESSION_AT, calls: [editCall(repo, ASSERT_OLD, ASSERT_NEW)] }]);
    applyEdit(repo, ASSERT_OLD, ASSERT_NEW);
    await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-clean' }, { blocking: BLOCKING, home });
    expect(existsSync(path.join(repo, '.why-diff'))).toBe(false);
  });

  it('keeps an existing .why-diff/.gitignore and prunes state entries older than 30 days', async () => {
    const { repo, home } = makeRepo();
    mkdirSync(path.join(repo, '.why-diff'));
    writeFileSync(path.join(repo, '.why-diff', '.gitignore'), 'custom\n');
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    writeFileSync(path.join(repo, '.why-diff', 'guard-state.json'), JSON.stringify({ stale: { hash: 'x', at: old } }));
    const transcript = writeSyntheticTranscript(home, repo, 's-prune', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-prune' }, { blocking: BLOCKING, home });
    expect(readFileSync(path.join(repo, '.why-diff', '.gitignore'), 'utf8')).toBe('custom\n');
    const state = JSON.parse(readFileSync(path.join(repo, '.why-diff', 'guard-state.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(['s-prune']);
  });

  it('a corrupt state file cannot turn the guard off', async () => {
    const { repo, home } = makeRepo();
    mkdirSync(path.join(repo, '.why-diff'));
    writeFileSync(path.join(repo, '.why-diff', 'guard-state.json'), '{"s1": null, "s2": 42, "s3": "abc"}');
    const transcript = writeSyntheticTranscript(home, repo, 's-corrupt', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-corrupt' }, { blocking: BLOCKING, home });
    expect(r.block).toBe(true);
    const state = JSON.parse(readFileSync(path.join(repo, '.why-diff', 'guard-state.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(['s-corrupt']);
  });

  it('skips a huge untracked file the agent wrote (2 MB cap): cost does not grow with its size', async () => {
    const { repo, home, stateDir } = makeRepo();
    const big = path.join(repo, 'dump.log');
    const transcript = writeSyntheticTranscript(home, repo, 's-big', [{ prompt: 'write a dump', at: SESSION_AT, calls: [{ tool: 'Write', at: CALL_AT, input: { file_path: big, content: 'it.skip("x")\n' } }] }]);
    const timeWith = async (mb: number): Promise<number> => {
      writeFileSync(big, Buffer.alloc(mb * 1024 * 1024, 'a'));
      let block = true;
      const ms = await bestOfAsync(async () => {
        block = (await runGuard({ transcript_path: transcript, cwd: repo, session_id: `s-big-${mb}` }, { blocking: BLOCKING, home, stateDir })).block;
      });
      expect(block).toBe(false);
      return ms;
    };
    try {
      const t1 = await timeWith(12);
      const t4 = await timeWith(48);
      expect(t4).toBeLessThan(15_000);
      expectSubQuadratic(t1, t4, 250);
    } finally {
      rmSync(big, { force: true });
    }
  }, 60_000);
});

describe('runGuard: shell changes whose path the command does not name (mtime windows)', () => {
  const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path']);
  const T = Date.now() - 30 * 60_000; // the Bash call starts here
  const iso = (ms: number): string => new Date(ms).toISOString();
  const sec = (ms: number): Date => new Date(ms);
  // A script that computes the path it rewrites: no literal test path on the command line.
  const FIX_JS = "const fs = require('fs');\nconst p = ['te', 'st'].join('') + '/f.' + 'test.js';\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('it(\"t5\"', 'it.skip(\"t5\"'));\n";

  // Tests date files by their mtime (settable with utimes); the guard itself uses ctime on POSIX.
  const byMtime = async (p: string): Promise<number> => (await lstat(p)).mtimeMs;
  async function run(act: (repo: string) => void, opts: { resultAt?: number; sessionAt?: number; callAt?: number; statTime?: (p: string) => Promise<number> } = {}): Promise<{ block: boolean; message?: string }> {
    const { repo, home, stateDir } = makeRepo();
    writeFileSync(path.join(repo, 'fix.js'), FIX_JS);
    sh(repo, ['add', '-A']);
    sh(repo, ['commit', '-qm', 'script'], LONG_AGO);
    const callAt = opts.callAt ?? T;
    const transcript = writeSyntheticTranscript(home, repo, 's-win', [{
      prompt: 'make the suite green',
      at: iso(opts.sessionAt ?? callAt - 60_000),
      calls: [{ tool: 'Bash', at: iso(callAt), resultAt: iso(opts.resultAt ?? callAt + 4000), input: { command: `cd ${shellPath(repo)} && node fix.js`, description: 'run the fixer' } }],
    }]);
    act(repo);
    return runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-win' }, { blocking: BL, home, stateDir, statTime: 'statTime' in opts ? opts.statTime : byMtime });
  }
  const testPath = (repo: string): string => path.join(repo, 'test', 'f.test.js');

  it('blocks on a test file a script rewrote, when its mtime lies inside the Bash call window', async () => {
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      utimesSync(testPath(repo), sec(T + 2000), sec(T + 2000));
    });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
    expect(r.message).toContain('test-skip-added');
  });

  it('allows 2 s of clock slack on each side of the window', async () => {
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      utimesSync(testPath(repo), sec(T + 4000 + 1500), sec(T + 4000 + 1500));
    });
    expect(r.block).toBe(true);
  });

  it('does not credit the same change when the file mtime lies outside every window (a human edit)', async () => {
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      utimesSync(testPath(repo), sec(T + 60_000), sec(T + 60_000));
    });
    expect(r.block).toBe(false);
  });

  it('a later human edit moves the mtime out of the window, so the change is not credited', async () => {
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW); // mtime = now, long after the window
    });
    expect(r.block).toBe(false);
  });

  it('blocks on a whole-file deletion when the parent directory mtime lies inside the window', async () => {
    const r = await run((repo) => {
      rmSync(testPath(repo));
      utimesSync(path.join(repo, 'test'), sec(T + 1000), sec(T + 1000));
    });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
  });

  it('does not credit a deletion when the parent directory mtime lies outside the window', async () => {
    const r = await run((repo) => {
      rmSync(testPath(repo));
      utimesSync(path.join(repo, 'test'), sec(T + 60_000), sec(T + 60_000));
    });
    expect(r.block).toBe(false);
  });

  it('keeps a Bash window longer than 10 minutes (`sleep 700; node fix.js`)', async () => {
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      utimesSync(testPath(repo), sec(T + 11 * 60_000), sec(T + 11 * 60_000));
    }, { resultAt: T + 12 * 60_000 });
    expect(r.block).toBe(true);
  });

  it('dates a deletion by the nearest existing ancestor when the parent directory went too', async () => {
    const r = await run((repo) => {
      rmSync(path.join(repo, 'test'), { recursive: true });
      utimesSync(repo, sec(T + 1000), sec(T + 1000));
    });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
  });

  it('does not credit a deletion whose nearest existing ancestor was changed outside the window', async () => {
    const r = await run((repo) => {
      rmSync(path.join(repo, 'test'), { recursive: true });
      utimesSync(repo, sec(T + 60_000), sec(T + 60_000));
    });
    expect(r.block).toBe(false);
  });

  // POSIX only: Windows has no ctime that utimes leaves alone, so the guard falls back to mtime there.
  it.skipIf(process.platform === 'win32')('uses ctime by default: a script that backdates the mtime is still credited', async () => {
    const now = Date.now();
    const r = await run((repo) => {
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      // `touch -d` style backdating: mtime far outside the window, ctime stays "now" (inside it)
      utimesSync(testPath(repo), sec(now - 3 * 3600_000), sec(now - 3 * 3600_000));
    }, { callAt: now - 5000, resultAt: now + 60_000, sessionAt: now - 30_000, statTime: undefined as unknown as (p: string) => Promise<number> });
    expect(r.block).toBe(true);
  });

  it('credits a change under a protected path the same way', async () => {
    const { repo, home, stateDir } = makeRepo();
    mkdirSync(path.join(repo, 'infra'));
    writeFileSync(path.join(repo, 'infra', 'main.tf'), 'a = 1\n');
    writeFileSync(path.join(repo, '.why-diff.json'), JSON.stringify({ protected: ['infra/**'] }));
    sh(repo, ['add', '-A']);
    sh(repo, ['commit', '-qm', 'rules'], LONG_AGO);
    const transcript = writeSyntheticTranscript(home, repo, 's-prot', [{
      prompt: 'bump it', at: iso(T - 60_000),
      calls: [{ tool: 'Bash', at: iso(T), resultAt: iso(T + 3000), input: { command: `cd ${shellPath(repo)} && ./bump.sh`, description: 'x' } }],
    }]);
    writeFileSync(path.join(repo, 'infra', 'main.tf'), 'a = 2\n');
    utimesSync(path.join(repo, 'infra', 'main.tf'), sec(T + 1000), sec(T + 1000));
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-prot' }, { blocking: BL, home, stateDir, statTime: byMtime });
    expect(r.block).toBe(true);
    expect(r.message).toContain('protected-path');
  });
});

describe('runGuard with Unicode file names', () => {
  for (const [name, form] of [['NFD', 'NFD'], ['NFC', 'NFC']] as const) {
    it(`blocks on an it.skip the agent wrote into a test file named in ${name}`, async () => {
      const { repo, home, stateDir } = makeRepo();
      const file = path.join(repo, 'test', 'caf\u00e9.test.js'.normalize(form));
      writeFileSync(file, testFile());
      sh(repo, ['add', '-A']);
      sh(repo, ['commit', '-qm', 'cafe'], LONG_AGO);
      const transcript = writeSyntheticTranscript(home, repo, 's-nfd', [{ prompt: 'fix t5', at: SESSION_AT, calls: [{ tool: 'Edit', at: CALL_AT, input: { file_path: path.join(repo, 'test', 'cafe\u0301.test.js'), old_string: SKIP_OLD, new_string: SKIP_NEW } }] }]);
      writeFileSync(file, readFileSync(file, 'utf8').replace(SKIP_OLD, SKIP_NEW));
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-nfd' }, { blocking: BLOCKING, home, stateDir });
      expect(r.block).toBe(true);
    });
  }
});

describe('runGuard on pasted blobs', () => {
  for (const [name, blob] of [
    ['a word run', 'a'.repeat(300_000)],
    ['dotted words', 'a.'.repeat(150_000)],
    ['unclosed reminder tags', '<system-reminder>'.repeat(18_000)],
  ] as const) {
    it(`blocks on a 300 KB prompt of ${name} well within the hook timeout`, async () => {
      const { repo, home, stateDir } = makeRepo();
      const transcript = writeSyntheticTranscript(home, repo, 's-blob', [{ prompt: `fix t5 ${blob}`, at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
      applyEdit(repo, SKIP_OLD, SKIP_NEW);
      const t0 = Date.now();
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-blob' }, { blocking: BLOCKING, home, stateDir });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.block).toBe(true);
    }, 120_000);
  }
});

describe('why-diff guard CLI', () => {
  it('exits 2 with the message on stderr when the agent skipped a test, 0 otherwise', () => {
    const { repo, home } = makeRepo();
    const transcript = writeSyntheticTranscript(home, repo, 's-cli', [{ prompt: 'fix t5', at: SESSION_AT, calls: [editCall(repo, SKIP_OLD, SKIP_NEW)] }]);
    applyEdit(repo, SKIP_OLD, SKIP_NEW);
    const run = (payload: object) => spawnSync(path.resolve('node_modules/.bin/tsx'), [path.resolve('src/cli.ts'), 'guard'], { input: JSON.stringify(payload), encoding: 'utf8', cwd: repo });
    const first = run({ transcript_path: transcript, cwd: repo, session_id: 's-cli' });
    expect(first.status).toBe(2);
    expect(first.stderr).toContain('test-skip-added');
    expect(run({ transcript_path: transcript, cwd: repo, session_id: 's-cli' }).status).toBe(0);
    expect(run({ cwd: repo }).status).toBe(0);
  });
});
