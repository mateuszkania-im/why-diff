import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../src/diff-parse.js';
import { buildReport } from '../src/pipeline.js';
import { GitError, commitTimes, currentBranch, getDiff, hasHead, isShallow, listUntracked, repoName, repoRoot, resolveDefaultTarget } from '../src/git.js';
import { tempDir } from './helpers/claude-fixture.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs: string[] = [];

function freshRepo(): string {
  const dir = tempDir('why-diff-git-');
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: ENV });
  return dir;
}
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const put = (root: string, rel: string, content: string | Buffer): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('git helpers', () => {
  it('diffs a repository with no commits yet: staged and untracked files all appear as added', async () => {
    const repo = freshRepo();
    put(repo, 'staged.txt', 'staged\n');
    put(repo, 'loose.txt', 'loose\n');
    sh(repo, 'add', 'staged.txt');
    expect(await hasHead(repo)).toBe(false);
    expect(await currentBranch(repo)).toBe('main');

    const hunks = parseUnifiedDiff(await getDiff(repo, { workingTree: true }));
    expect(hunks.map((h) => [h.file, h.status])).toEqual([
      ['staged.txt', 'added'],
      ['loose.txt', 'added'],
    ]);
    expect((await resolveDefaultTarget(repo)).label).toBe('working tree');
    expect((await commitTimes(repo, { workingTree: true })).since.getTime()).toBe(0);
  });

  it('synthesises untracked files faithfully: no trailing newline, spaces, quotes, empty and binary files', async () => {
    const repo = freshRepo();
    put(repo, 'base.txt', 'base\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');

    put(repo, 'no-newline.txt', 'last line without newline');
    put(repo, 'docs/my notes.md', '# notes\n');
    put(repo, 'weird "name".txt', 'quoted\n');
    put(repo, 'empty.txt', '');
    put(repo, 'image.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    put(repo, 'ignored.log', 'nope\n');
    put(repo, '.gitignore', '*.log\n');

    const untracked = await listUntracked(repo);
    expect(untracked).not.toContain('ignored.log');

    const diff = await getDiff(repo, { workingTree: true, includeUntracked: true });
    expect(diff).toContain('\\ No newline at end of file');
    const hunks = parseUnifiedDiff(diff);
    const files = hunks.map((h) => h.file).sort();
    expect(files).toEqual(['.gitignore', 'docs/my notes.md', 'no-newline.txt', 'weird "name".txt'].sort());
    expect(hunks.find((h) => h.file === 'no-newline.txt')?.lines).toEqual([{ type: 'add', text: 'last line without newline', newNo: 1 }]);
    // Binary and empty files add no hunks; the index was never touched.
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('');

    const withoutUntracked = parseUnifiedDiff(await getDiff(repo, { workingTree: true, includeUntracked: false }));
    expect(withoutUntracked).toEqual([]);
  });

  it('combines staged, unstaged and committed-on-branch changes through the merge base', async () => {
    const repo = freshRepo();
    put(repo, 'a.txt', 'one\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base', '--date', '2026-10-31T08:00:00Z');
    sh(repo, 'checkout', '-q', '-b', 'feature');
    put(repo, 'a.txt', 'one\ntwo\n');
    sh(repo, 'commit', '-q', '-am', 'two', '--date', '2026-10-31T09:00:00Z');
    put(repo, 'a.txt', 'one\ntwo\nthree\n'); // staged
    sh(repo, 'add', 'a.txt');
    put(repo, 'a.txt', 'one\ntwo\nthree\nfour\n'); // unstaged on top

    const target = await resolveDefaultTarget(repo);
    expect(target).toMatchObject({ base: 'main', label: 'main...HEAD + working tree' });
    const [hunk] = parseUnifiedDiff(await getDiff(repo, target.target));
    expect(hunk?.lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['two', 'three', 'four']);

    const window = await commitTimes(repo, target.target);
    expect(window.commits).toBe(1);
    expect(window.since.toISOString()).toBe('2026-10-31T08:00:00.000Z');
    expect(window.until.getTime()).toBeGreaterThan(window.since.getTime());

    // Back on main the branch has nothing beyond the base: fall back to the working tree.
    sh(repo, 'checkout', '-q', '-f', 'main');
    expect((await resolveDefaultTarget(repo)).label).toBe('working tree');
  });

  it('reports the repo root and name, and raises GitError with stderr for bad input', async () => {
    const repo = freshRepo();
    put(repo, 'x.txt', 'x\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    mkdirSync(path.join(repo, 'nested/deeper'), { recursive: true });
    expect(await repoRoot(path.join(repo, 'nested/deeper'))).toBe(sh(repo, 'rev-parse', '--show-toplevel'));
    expect(await repoName(repo)).toBe(path.basename(await repoRoot(repo)));
    sh(repo, 'remote', 'add', 'origin', 'git@github.com:someone/why-diff-demo.git');
    expect(await repoName(repo)).toBe('why-diff-demo');

    const err = await getDiff(repo, 'definitely-not-a-ref..HEAD').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).stderr).toMatch(/bad revision|unknown revision|ambiguous argument/);
    expect((err as GitError).message).toContain('git diff');

    // A range that looks like an option is rejected, not handed to git (`--output=` writes files).
    await expect(getDiff(repo, `--output=${path.join(repo, 'pwned.txt')}`)).rejects.toThrow(/invalid range/);
    expect(existsSync(path.join(repo, 'pwned.txt'))).toBe(false);
  });
});

describe('base and window resolution', () => {
  const commitFile = (repo: string, rel: string, content: string, msg: string, env: Record<string, string> = {}): void => {
    put(repo, rel, content);
    execFileSync('git', ['add', '-A'], { cwd: repo, env: ENV });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo, env: { ...ENV, ...env } });
  };

  it('resolveDefaultTarget uses GITHUB_BASE_REF', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    sh(repo, 'checkout', '-q', '--detach', 'feat');
    const r = await resolveDefaultTarget(repo, { GITHUB_BASE_REF: 'main' });
    expect(['main', 'origin/main']).toContain(r.base);
    expect(r.label).toBe(`${r.base}...HEAD + working tree`);
    expect(r.label).toBe('main...HEAD + working tree');
  });

  it.each(['develop', 'trunk'])('resolveDefaultTarget finds develop and trunk (%s)', async (name) => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'branch', name);
    sh(repo, 'checkout', '-q', '-b', 'feat');
    sh(repo, 'branch', '-D', 'main');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    const r = await resolveDefaultTarget(repo, {});
    expect(r.base).toBe(name);
  });

  it("resolveDefaultTarget prefers origin's default branch", async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    sh(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    const r = await resolveDefaultTarget(repo, {});
    expect(r.base).toBe('origin/develop');
  });

  it('commitTimes uses the earliest author date in the range', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'root');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    commitFile(repo, 'b.txt', 'b\n', 'A', { GIT_AUTHOR_DATE: twoDaysAgo, GIT_COMMITTER_DATE: twoDaysAgo });
    sh(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'c.txt', 'c\n', 'main moves on');
    sh(repo, 'checkout', '-q', 'feat');
    execFileSync('git', ['rebase', '-q', 'main'], { cwd: repo, env: ENV });
    const w = await commitTimes(repo, { workingTree: true, base: 'main' });
    expect(w.since.getTime()).toBeLessThanOrEqual(Date.parse(twoDaysAgo));
    expect(w.commits).toBe(1);
  });

  it('listUntracked ignores .why-diff/', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    put(repo, '.why-diff/report.html', '<html>');
    put(repo, 'x.js', 'x\n');
    expect(await listUntracked(repo)).toEqual(['x.js']);
  });

  it('explicit --base that does not exist rejects instead of falling back', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    await expect(buildReport({ cwd: repo, base: 'release/2', home: repo })).rejects.toThrow('cannot compare against --base release/2');
    // An existing base still works.
    const ok = await buildReport({ cwd: repo, base: 'main', home: repo });
    expect(ok.range).toBe('main...HEAD + working tree');
  });

  it('rejects --base and ignores CI env values that look like options', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    await expect(resolveDefaultTarget(repo, {}, '--output=x')).rejects.toThrow(/invalid base/);
    const r = await resolveDefaultTarget(repo, { GITHUB_BASE_REF: '--output=x' });
    expect(r.base).toBe('main');
  });

  it('shallow clone on a base branch falls back to the working tree', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    const parent = tempDir('why-diff-shallow-');
    dirs.push(parent);
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, clone], { env: ENV });
    put(clone, 'a.txt', 'one\nchanged\n');
    const report = await buildReport({ cwd: clone, home: parent });
    expect(report.range).toBe('working tree');
    expect(report.hunks).toHaveLength(1);
  });

  it('shallow clone gives a fetch-depth hint', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    const parent = tempDir('why-diff-shallow-');
    dirs.push(parent);
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feat', `file://${repo}`, clone], { env: ENV });
    expect(await isShallow(clone)).toBe(true);
    await expect(buildReport({ cwd: clone, range: 'origin/main...HEAD', home: parent })).rejects.toThrow('fetch-depth: 0');
    await expect(buildReport({ cwd: clone, home: parent })).rejects.toThrow('fetch-depth: 0');
  });
});
