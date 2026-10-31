import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard } from '../src/guard.js';
import type { LabelKind } from '../src/types.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';
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
      if (cmd) calls.push({ tool: 'Bash', at: CALL_AT, input: { command: cmd.replaceAll('$R', repo), description: 'x' } });
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
