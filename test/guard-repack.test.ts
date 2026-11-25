/**
 * The commit the SessionStart hook recorded stays the base when its object is repacked during the
 * session (`git gc`, `git maintenance`, a fetch that keeps a pack): the base snapshot is checked by
 * hashing its objects instead of by the age of the file holding them. A snapshot whose objects do
 * not hash to their names still fails closed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard, type GuardOptions } from '../src/guard.js';
import { recordSessionStart } from '../src/session-start.js';
import type { LabelKind } from '../src/types.js';
import { tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';

const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path', 'unreviewed']);
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
function repo(): { repo: string; home: string; tp: string; src: string } {
  const r = temp('wd-rp-repo-');
  mkdirSync(path.join(r, 'test'));
  mkdirSync(path.join(r, 'src', 'deep'), { recursive: true });
  writeFileSync(path.join(r, 'src', 'f.js'), 'export const f = (x) => x;\n');
  writeFileSync(path.join(r, 'src', 'deep', 'g.js'), 'export const g = 1;\n');
  writeFileSync(path.join(r, TEST), testFile());
  git(r, ['init', '-q', '-b', 'main']);
  git(r, ['config', 'gc.auto', '0']);
  git(r, ['add', '-A']);
  git(r, ['commit', '-qm', 'A'], PAST);
  return { repo: r, home: temp('wd-rp-home-'), tp: path.join(r, TEST), src: path.join(r, 'src', 'f.js') };
}
const replaceIn = (f: string, a: string, b: string): void => writeFileSync(f, readFileSync(f, 'utf8').replace(a, b));
const edit = (at: number, tp: string, a: string, b: string): SyntheticCall => ({ tool: 'Edit', at: iso(at), resultAt: iso(at + 4000), input: { file_path: tp, old_string: a, new_string: b } });
const bash = (at: number, command: string): SyntheticCall => ({ tool: 'Bash', at: iso(at), resultAt: iso(at + 4000), input: { command, description: 'x' } });

/** Objects written before the session, unless they sit in objects/pack (written by the repack, during it). */
const repackedDuring = async (p: string): Promise<number> => {
  await lstat(p);
  return p.split(path.sep).join('/').includes('/objects/pack/') ? Date.now() : 0;
};
/** Every object file reads as written during the session. */
const allNew = async (p: string): Promise<number> => {
  await lstat(p);
  return Date.now();
};

async function guardRun(x: { repo: string; home: string }, data: string, calls: (t: number) => SyntheticCall[], opts: Partial<GuardOptions> = {}) {
  const start = Date.now() - 60_000;
  let callAt = start + 10_000;
  const transcript = writeSyntheticTranscript(x.home, x.repo, 'srp', [{ prompt: 'make the suite green', at: iso(start), calls: calls(callAt) }]);
  const statTime = async (p: string): Promise<number> => {
    const st = await lstat(p);
    return path.resolve(p).startsWith(path.join(data, 'sessions')) ? callAt - 5000 : st.ctimeMs;
  };
  return runGuard({ transcript_path: transcript, cwd: x.repo, session_id: 'srp' }, { blocking: BL, home: x.home, statTime, ...opts });
}
function session(): { repo: string; home: string; tp: string; src: string; data: string } {
  const data = temp('wd-rp-data-');
  process.env.CLAUDE_PLUGIN_DATA = data;
  return { ...repo(), data };
}

describe('recorded base after a repack during the session', () => {
  it('git gc during the session: a plain change still passes, the recorded commit is the base', async () => {
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    replaceIn(x.src, '(x) => x', '(x) => x * 1');
    git(x.repo, ['gc', '-q', '--prune=now']);
    expect(readdirSync(path.join(x.repo, '.git', 'objects', 'pack')).some((f) => f.endsWith('.idx'))).toBe(true);
    const res = await guardRun(x, x.data, (t) => [edit(t, x.src, '(x) => x', '(x) => x * 1'), bash(t + 5000, 'git gc')], { objectTime: repackedDuring });
    expect(res.message ?? '').not.toContain('was not written before the session');
    expect(res.message ?? '').not.toContain('pack index');
    expect(res.block).toBe(false);
  });

  it('git gc during the session does not hide a skip the agent added', async () => {
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    git(x.repo, ['add', '-A']);
    git(x.repo, ['commit', '-qm', 'skip']);
    git(x.repo, ['gc', '-q', '--prune=now']);
    const res = await guardRun(x, x.data, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'git commit -am skip && git gc')], { objectTime: repackedDuring });
    expect(res.block).toBe(true);
    expect(res.message).toContain('test-skip-added');
  });

  it('a recorded commit whose object was rewritten with other content fails closed', async () => {
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    const head = git(x.repo, ['rev-parse', 'HEAD']).trim();
    // The agent adds the skip, commits it on a fresh root, and makes the recorded name hold that commit's content.
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    git(x.repo, ['add', '-A']);
    const fresh = git(x.repo, ['commit-tree', git(x.repo, ['write-tree']).trim(), '-m', 'A'], PAST).trim();
    const forged = git(x.repo, ['cat-file', 'commit', fresh]);
    const file = path.join(x.repo, '.git', 'objects', head.slice(0, 2), head.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(forged)}\0`), Buffer.from(forged)])));
    git(x.repo, ['update-ref', 'HEAD', fresh]);
    const res = await guardRun(x, x.data, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'node forge.js')], { objectTime: allNew });
    expect(res.block).toBe(true);
    // Git itself refuses a commit that does not hash to its name when parsing it.
    expect(res.message).toContain('recorded at session start');
  });

  it('a recorded tree object rewritten with other content fails closed', async () => {
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    const testTree = git(x.repo, ['rev-parse', 'HEAD:test']).trim();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    git(x.repo, ['add', '-A']);
    const tree = git(x.repo, ['write-tree']).trim();
    const forged = execFileSync('git', ['cat-file', 'tree', git(x.repo, ['rev-parse', `${tree}:test`]).trim()], { cwd: x.repo });
    const file = path.join(x.repo, '.git', 'objects', testTree.slice(0, 2), testTree.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`tree ${forged.length}\0`), forged])));
    // The commit object itself is untouched but every object reads as new: only hashing can vouch for the snapshot.
    const res = await guardRun(x, x.data, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'node forge.js')], { objectTime: allNew });
    expect(res.block).toBe(true);
    expect(res.message).toContain('does not hash to its name');
  });

  it('a recorded blob rewritten with other content fails closed', async () => {
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    const blob = git(x.repo, ['rev-parse', `HEAD:${TEST}`]).trim();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    const forged = readFileSync(x.tp);
    const file = path.join(x.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
    const res = await guardRun(x, x.data, (t) => [edit(t, x.tp, 'it("t5"', 'it.skip("t5"'), bash(t + 5000, 'node forge.js')], { objectTime: allNew });
    expect(res.block).toBe(true);
    expect(res.message).toContain('does not hash to its name');
  });

  it('a base snapshot past the byte cap fails closed and says why', async () => {
    process.env.WHY_DIFF_MAX_SNAPSHOT_BYTES = '10';
    const x = session();
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    replaceIn(x.src, '(x) => x', '(x) => x * 1');
    git(x.repo, ['gc', '-q', '--prune=now']);
    const res = await guardRun(x, x.data, (t) => [edit(t, x.src, '(x) => x', '(x) => x * 1'), bash(t + 5000, 'git gc')], { objectTime: repackedDuring });
    expect(res.block).toBe(true);
    expect(res.message).toContain('WHY_DIFF_MAX_SNAPSHOT_BYTES');
  });

  it('a skip the human staged before the session is not blamed on the agent after a repack', async () => {
    const x = session();
    replaceIn(x.tp, 'it("t5"', 'it.skip("t5"');
    git(x.repo, ['add', x.tp]); // the human, before the session
    await recordSessionStart({ session_id: 'srp', cwd: x.repo, source: 'startup' });
    replaceIn(x.src, '(x) => x', '(x) => x * 1');
    git(x.repo, ['gc', '-q', '--prune=now']);
    const res = await guardRun(x, x.data, (t) => [edit(t, x.src, '(x) => x', '(x) => x * 1'), bash(t + 5000, 'git gc')], { objectTime: repackedDuring });
    expect(res.message ?? '').not.toContain('test-skip-added');
    expect(res.block).toBe(false);
  });
});
