import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../src/diff-parse.js';
import { buildReport } from '../src/pipeline.js';
import { GitError, commitTimes, currentBranch, getDiff, getDiffDetailed, git, hasHead, isShallow, listUntracked, repoName, repoRoot, resolveDefaultTarget, worktreeRoots } from '../src/git.js';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

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
    // `"` is not allowed in Windows file names: that one case runs on POSIX only.
    const quoted = process.platform !== 'win32';
    if (quoted) put(repo, 'weird "name".txt', 'quoted\n');
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
    expect(files).toEqual(['.gitignore', 'docs/my notes.md', 'image.bin', 'no-newline.txt', ...(quoted ? ['weird "name".txt'] : [])].sort());
    expect(hunks.find((h) => h.file === 'no-newline.txt')?.lines).toEqual([{ type: 'add', text: 'last line without newline', newNo: 1 }]);
    expect(hunks.find((h) => h.file === 'image.bin')).toMatchObject({ header: 'Binary file changed', lines: [] });
    // The index was never touched.
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

  it('reports the repo root and the root basename as name (an origin remote is ignored), and raises GitError with stderr for bad input', async () => {
    const repo = freshRepo();
    put(repo, 'x.txt', 'x\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    mkdirSync(path.join(repo, 'nested/deeper'), { recursive: true });
    expect(await repoRoot(path.join(repo, 'nested/deeper'))).toBe(sh(repo, 'rev-parse', '--show-toplevel'));
    expect(await repoName(repo)).toBe(path.basename(await repoRoot(repo)));
    sh(repo, 'remote', 'add', 'origin', 'git@github.com:someone/why-diff-demo.git');
    expect(await repoName(repo)).toBe(path.basename(await repoRoot(repo)));

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

  it('commitTimes counts baseRev..HEAD when a baseRev is given', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    const base = sh(repo, 'rev-parse', 'HEAD');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    commitFile(repo, 'a.txt', 'one\ntwo\nthree\n', 'three');
    const w = await commitTimes(repo, { workingTree: true, baseRev: base });
    expect(w.commits).toBe(2);
    expect((await commitTimes(repo, { workingTree: true, baseRev: 'HEAD' })).commits).toBe(0);
  });

  it('an a..b range reads the post-image of runner configs from b (git show), not from the disk', async () => {
    const repo = freshRepo();
    const config = (exclude: boolean): string => [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({',
      '  test: {',
      "    environment: 'node',",
      '    globals: true,',
      "    include: ['src/**/*.ts'],",
      "    setupFiles: ['./setup.ts'],",
      '    retry: 1,',
      ...(exclude ? ["    exclude: ['**/*.test.ts'],"] : []),
      "    reporters: ['default'],",
      '    testTimeout: 5000,',
      '    hookTimeout: 5000,',
      '  },',
      '});',
      '',
    ].join('\n');
    commitFile(repo, 'vitest.config.ts', config(false), 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'vitest.config.ts', config(true), 'exclude tests');
    sh(repo, 'checkout', '-q', 'main'); // the disk now has the pre-image
    const report = await buildReport({ cwd: repo, range: 'main..feat', home: repo });
    const h = report.hunks.find((x) => x.hunk.file === 'vitest.config.ts');
    expect(h?.hunk.lines.some((l) => l.type === 'ctx' && l.text.includes('test: {'))).toBe(false); // the key is outside the hunk
    expect(h?.labels.map((l) => l.kind)).toContain('tests-disabled');
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
    expect(ok.includesWorkingTree).toBe(true);
    const committed = await buildReport({ cwd: repo, base: 'main', committedOnly: true, home: repo });
    expect(committed.range).toBe('main...HEAD');
    expect(committed.includesWorkingTree).toBe(false);
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

  it('shallow clone: only missing-revision errors get the fetch-depth hint, others pass through unchanged', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    const parent = tempDir('why-diff-shallow-');
    dirs.push(parent);
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, clone], { env: ENV });
    // A typo in the range that is not a missing revision: git's own error, no hint.
    const typo = await buildReport({ cwd: clone, range: 'HEAD:nope.txt', home: parent }).catch((e: Error) => e);
    expect((typo as Error).message).toContain("path 'nope.txt' does not exist");
    expect((typo as Error).message).not.toContain('fetch-depth');
    const magic = await buildReport({ cwd: clone, workingTree: true, paths: [':(bad)x'], home: parent }).catch((e: Error) => e);
    expect((magic as Error).message).toContain('pathspec magic');
    expect((magic as Error).message).not.toContain('fetch-depth');
    // A typo in a ref name looks like a missing revision: the hint is added, git's own text is kept.
    const mistyped = await buildReport({ cwd: clone, range: 'mian...HEAD', home: parent }).catch((e: Error) => e);
    expect((mistyped as Error).message).toContain('fetch-depth: 0');
    expect((mistyped as Error).message).toContain('mian...HEAD');
    expect((mistyped as Error).message).toMatch(/unknown revision|ambiguous argument|bad revision|not a valid object name|no merge base/);
    // A revision the shallow history does not have: the hint.
    await expect(buildReport({ cwd: clone, range: 'HEAD~1..HEAD', home: parent })).rejects.toThrow('fetch-depth: 0');
  });

  it('shallow detached checkout with an explicit --base gives the fetch-depth hint, not "ref not found"', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    sh(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'a.txt', 'one\ntwo\n', 'two');
    const parent = tempDir('why-diff-shallow-');
    dirs.push(parent);
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feat', `file://${repo}`, clone], { env: ENV });
    sh(clone, 'checkout', '-q', '--detach');
    const err = await buildReport({ cwd: clone, base: 'main', home: parent }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('fetch-depth: 0');
    expect((err as Error).message).not.toContain('pass --base');
    expect((err as Error).message).not.toContain('ref not found');
  });

  it('--base equal to the current branch falls back to the working tree instead of throwing', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    put(repo, 'a.txt', 'one\nchanged\n');
    const report = await buildReport({ cwd: repo, base: 'main', home: repo });
    expect(report.range).toBe('working tree');
    expect(report.hunks).toHaveLength(1);
  });

  it('lists other worktrees but not the current root', async () => {
    const repo = freshRepo();
    commitFile(repo, 'a.txt', 'one\n', 'base');
    expect(await worktreeRoots(repo)).toEqual([]);
    const wt = `${repo}-wt`;
    dirs.push(wt);
    sh(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const real = realpathSync(wt);
    expect(await worktreeRoots(repo)).toEqual([real]);
    expect(await worktreeRoots(wt)).toEqual([realpathSync(repo)]);
  });

  it('attributes a top-level file edited in a worktree nested under the repo (.claude/worktrees/x)', async () => {
    const repo = freshRepo();
    commitFile(repo, 'README.md', 'hi\n', 'base');
    put(repo, '.gitignore', '.claude/\n');
    sh(repo, 'add', '.gitignore');
    sh(repo, 'commit', '-q', '-m', 'ignore');
    const wt = path.join(repo, '.claude', 'worktrees', 'x');
    mkdirSync(path.dirname(wt), { recursive: true });
    sh(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const content = 'export const answer = 42;\n';
    put(wt, 'a.js', content);
    sh(wt, 'add', 'a.js');
    sh(wt, 'commit', '-q', '-m', 'add a');
    const at = new Date().toISOString();
    const home = tempDir('why-diff-home-');
    dirs.push(home);
    const real = realpathSync(wt);
    writeSyntheticTranscript(home, real, 'wt-session-0002', [
      { prompt: 'create a.js exporting the answer', at, calls: [{ tool: 'Write', at, input: { file_path: path.join(real, 'a.js'), content } }] },
    ]);
    sh(repo, 'merge', '-q', '--ff-only', 'wt');
    const report = await buildReport({ cwd: repo, range: 'HEAD~1...HEAD', home, harnesses: ['claude-code'], classify: 'none' });
    expect(report.hunks).toHaveLength(1);
    expect(report.hunks[0]?.match).toBe('exact');
  });

  it('attributes a merged change to a session that ran in a sibling git worktree', async () => {
    const repo = freshRepo();
    commitFile(repo, 'README.md', 'hi\n', 'base');
    const wt = `${repo}-wt`;
    dirs.push(wt);
    sh(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const content = 'export const answer = 42;\n';
    put(wt, 'a.js', content);
    sh(wt, 'add', 'a.js');
    sh(wt, 'commit', '-q', '-m', 'add a');
    const at = new Date().toISOString();
    const home = tempDir('why-diff-home-');
    dirs.push(home);
    writeSyntheticTranscript(home, realpathSync(wt), 'wt-session-0001', [
      { prompt: 'create a.js exporting the answer', at, calls: [{ tool: 'Write', at, input: { file_path: path.join(realpathSync(wt), 'a.js'), content } }] },
    ]);
    sh(repo, 'merge', '-q', '--ff-only', 'wt');
    const report = await buildReport({ cwd: repo, range: 'HEAD~1...HEAD', home, harnesses: ['claude-code'], classify: 'none' });
    expect(report.hunks).toHaveLength(1);
    expect(report.hunks[0]?.match).toBe('exact');
    expect(report.hunks[0]?.prompt?.text).toContain('create a.js');
  });
});

describe('report paths', () => {
  it('json and html carry no absolute path under the home directory: repo root tildified, edit paths repo-relative', async () => {
    const home = realpathSync(tempDir('why-diff-home-user-'));
    dirs.push(home);
    const repo = path.join(home, 'code', 'shop');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: ENV });
    put(repo, 'base.txt', 'base\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    put(repo, 'src/a.js', 'export const a = 1;\n');
    const at = new Date(Date.now() - 60_000).toISOString();
    writeSyntheticTranscript(home, repo, 'paths-1', [{ prompt: 'add a', at, calls: [{ tool: 'Write', at, input: { file_path: path.join(repo, 'src', 'a.js'), content: 'export const a = 1;\n' } }] }]);
    const report = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    expect(report.hunks[0]?.match).toBe('exact');
    expect(report.repo.root).toBe('~/code/shop');
    expect(Object.values(report.edits).map((e) => e.filePath)).toEqual(['src/a.js']);
    expect(report.hunks.flatMap((h) => h.edits.map((e) => e.filePath))).toEqual(['src/a.js']);
    const { renderJson, renderHtml } = await import('../src/report/index.js');
    expect(renderJson(report)).not.toContain(home);
    expect(renderHtml(report)).not.toContain(home);
  });
});

describe('Python package detection', () => {
  async function labelsAfterDeleting(withInit: boolean): Promise<string[]> {
    const repo = freshRepo();
    put(repo, 'tools/foo.py', 'def foo():\n    return 1\n');
    if (withInit) put(repo, 'tools/__init__.py', '');
    put(repo, 'tests/test_foo.py', 'def test_foo():\n    assert True\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    rmSync(path.join(repo, 'tools', 'foo.py'));
    rmSync(path.join(repo, 'tests', 'test_foo.py'));
    const report = await buildReport({ cwd: repo, workingTree: true, home: repo });
    return report.hunks.find((h) => h.hunk.file === 'tests/test_foo.py')?.labels.map((l) => l.kind) ?? [];
  }
  it('pairs a deleted top-level test with its deleted source in a tools/ package that has __init__.py', async () => {
    expect(await labelsAfterDeleting(true)).not.toContain('tests-disabled');
    expect(await labelsAfterDeleting(false)).toContain('tests-disabled');
  });
});

// Creating symlinks on Windows needs developer mode or admin rights.
describe.skipIf(process.platform === 'win32')('untracked symlinks', () => {
  it('shows an untracked symlink as git does (its target, mode 120000) and never reads what it points at', async () => {
    const repo = freshRepo();
    put(repo, 'base.txt', 'base\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    const outside = tempDir('why-diff-outside-');
    dirs.push(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET CONTENT\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'));
    symlinkSync(path.join(outside, 'missing.txt'), path.join(repo, 'dangling.txt'));
    const diff = await getDiff(repo, { workingTree: true });
    expect(diff).not.toContain('TOP SECRET');
    const hunks = parseUnifiedDiff(diff);
    const leak = hunks.find((h) => h.file === 'leak.txt');
    expect(leak?.status).toBe('added');
    expect(leak?.lines.map((l) => l.text)).toEqual([path.join(outside, 'secret.txt')]);
    expect(diff).toContain('new file mode 120000');
    expect(hunks.find((h) => h.file === 'dangling.txt')?.lines.map((l) => l.text)).toEqual([path.join(outside, 'missing.txt')]);
    // Same lines as git's own view of the link.
    sh(repo, 'add', '-N', 'leak.txt');
    const own = parseUnifiedDiff(sh(repo, 'diff', '--', 'leak.txt') + '\n');
    expect(own[0]?.lines.map((l) => l.text)).toEqual(leak?.lines.map((l) => l.text));
  });
});

describe('untracked size cap', () => {
  it('skips untracked files over 2 MB but keeps small ones', async () => {
    const dir = freshRepo();
    put(dir, 'big.txt', 'a'.repeat(3 * 1024 * 1024));
    put(dir, 'small.txt', 'hi\n');
    const diff = await getDiff(dir, { workingTree: true });
    expect(diff).toContain('small.txt');
    expect(diff).not.toContain('big.txt');
  });
});

describe('tests-disabled end to end', () => {
  it('flags a test file removed with git rm', async () => {
    const repo = freshRepo();
    put(repo, 'src/a.js', 'export const a = 1;\n');
    put(repo, 'test/a.test.js', 'import { a } from "../src/a.js";\nit("works", () => { expect(a).toBe(1); });\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    sh(repo, 'rm', '-q', 'test/a.test.js');
    const home = tempDir('why-diff-home-');
    dirs.push(home);
    const report = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    const h = report.hunks.find((x) => x.hunk.file === 'test/a.test.js');
    expect(h?.hunk.status).toBe('deleted');
    expect(h?.labels.map((l) => l.kind)).toEqual(expect.arrayContaining(['tests-disabled', 'test-modified']));
  });

  it('flags a vitest test.exclude added far below the test key (full file read from the working tree)', async () => {
    const repo = freshRepo();
    const cfg = (extra: string): string => [
      "import { defineConfig } from 'vitest/config';", 'export default defineConfig({', '  test: {', "    environment: 'node',", '    globals: true,',
      "    include: ['src/**/*.ts'],", "    setupFiles: ['./setup.ts'],", '    retry: 1,', extra, "    reporters: ['default'],", '    testTimeout: 5000,', '    hookTimeout: 5000,', '  },', '});', '',
    ].join('\n');
    put(repo, 'vitest.config.ts', cfg("    bail: 1,"));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    put(repo, 'vitest.config.ts', cfg("    bail: 1,\n    exclude: ['**/*.test.ts'],"));
    const home = tempDir('why-diff-home-');
    dirs.push(home);
    const report = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    const h = report.hunks.find((x) => x.hunk.file === 'vitest.config.ts');
    expect(h?.labels.map((l) => l.kind)).toContain('tests-disabled');
  });
});

describe('getDiff: attributes, textconv and fsmonitor cannot hide changes', () => {
  function repoWithChange(): string {
    const repo = freshRepo();
    put(repo, 'a.test.js', 'it("a", () => {});\n');
    put(repo, 'img.bin', Buffer.from([0x89, 0x50, 0, 1, 2, 3, 0, 4]));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'init');
    put(repo, 'a.test.js', 'it.skip("a", () => {});\n');
    put(repo, 'img.bin', Buffer.from([0x89, 0x50, 0, 9, 9, 9, 0, 4]));
    return repo;
  }
  const added = (diff: string, file: string): string[] =>
    parseUnifiedDiff(diff).filter((h) => h.file === file).flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.text));

  it('shows a text file marked -diff in .git/info/attributes as text; a real binary stays binary', async () => {
    const repo = repoWithChange();
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    const diff = await getDiff(repo, { workingTree: true });
    expect(added(diff, 'a.test.js')).toEqual(['it.skip("a", () => {});']);
    expect(diff).not.toContain('\0');
    expect(diff).toMatch(/Binary files a\/img\.bin and b\/img\.bin differ/);
  });

  it('ignores a textconv driver and core.fsmonitor', async () => {
    const repo = repoWithChange();
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js diff=hide\n');
    sh(repo, 'config', 'diff.hide.textconv', 'sed s/it.skip/it/');
    sh(repo, 'config', 'core.fsmonitor', 'false-hook-that-does-not-exist');
    expect(added(await getDiff(repo, { workingTree: true }), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
  });

  it('shows a file a committed .gitattributes marks binary as text in a range diff', async () => {
    const repo = repoWithChange();
    put(repo, '.gitattributes', '*.js binary\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'hide');
    expect(added(await getDiff(repo, 'HEAD~1..HEAD'), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
  });

  it('ignores clean and process filter drivers', async () => {
    const repo = repoWithChange();
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js filter=hide\n');
    sh(repo, 'config', 'filter.hide.clean', 'sed s/it.skip/it/');
    sh(repo, 'config', 'filter.hide.required', 'true');
    sh(repo, 'config', 'filter.odd.name.with.dots.clean', 'cat');
    expect(added(await getDiff(repo, { workingTree: true }), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
  });

  it('keeps the text of a -diff file whose first 8000 bytes have no NUL, with later NULs made visible', async () => {
    const repo = freshRepo();
    const body = (skip: string): string => `${'// pad\n'.repeat(1200)}${skip}("a", () => {});\nconst s = "\0";\n`;
    put(repo, 'a.test.js', body('it'));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'init');
    put(repo, 'a.test.js', body('it.skip'));
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    const diff = await getDiff(repo, { workingTree: true });
    expect(added(diff, 'a.test.js')).toEqual(['it.skip("a", () => {});']);
    expect(diff).not.toContain('\0');
  });

  it('has no file cap: hundreds of decoy -diff files do not hide the real one', async () => {
    const repo = freshRepo();
    for (let i = 0; i < 600; i++) put(repo, `aa/decoy${String(i).padStart(3, '0')}.js`, `x${i}\n`);
    put(repo, 'zz/a.test.js', 'it("a", () => {});\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'init');
    for (let i = 0; i < 600; i++) put(repo, `aa/decoy${String(i).padStart(3, '0')}.js`, `y${i}\n`);
    put(repo, 'zz/a.test.js', 'it.skip("a", () => {});\n');
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    expect(added(await getDiff(repo, { workingTree: true }), 'zz/a.test.js')).toEqual(['it.skip("a", () => {});']);
  }, 60_000);

  it('ignores a core.bigFileThreshold that would make every file binary', async () => {
    const repo = repoWithChange();
    sh(repo, 'config', 'core.bigFileThreshold', '1');
    expect(added(await getDiff(repo, { workingTree: true }), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
  });

  it('switches off a filter whose name holds "=" (not expressible with -c)', async () => {
    const repo = repoWithChange();
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js filter=a=b\n');
    appendFileSync(path.join(repo, '.git', 'config'), '[filter "a=b"]\n\tclean = sed s/it.skip/it/\n');
    expect(added(await getDiff(repo, { workingTree: true }), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
  });

  it('keeps GIT_CONFIG_COUNT entries from the environment', async () => {
    const repo = repoWithChange();
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js filter=hide\n');
    sh(repo, 'config', 'filter.hide.clean', 'sed s/it.skip/it/');
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'from-env' });
    try {
      expect(added(await getDiff(repo, { workingTree: true }), 'a.test.js')).toEqual(['it.skip("a", () => {});']);
      expect(await git(repo, ['config', 'user.name'])).toBe('from-env');
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('re-diffs per file: one file too big to re-diff is reported unreviewed, the others still show as text', async () => {
    const repo = freshRepo();
    put(repo, 'aa/huge.js', `${'x'.repeat(100)}\n`.repeat(2000));
    put(repo, 'zz/a.test.js', 'it("a", () => {});\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'init');
    put(repo, 'aa/huge.js', `${'y'.repeat(100)}\n`.repeat(2000));
    put(repo, 'zz/a.test.js', 'it.skip("a", () => {});\n');
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    process.env.WHY_DIFF_REDIFF_MAX_BYTES = '50000';
    try {
      const { diff, unreviewed } = await getDiffDetailed(repo, { workingTree: true });
      expect(added(diff, 'zz/a.test.js')).toEqual(['it.skip("a", () => {});']);
      expect(unreviewed).toEqual(['aa/huge.js']);
    } finally {
      delete process.env.WHY_DIFF_REDIFF_MAX_BYTES;
    }
  });
});

describe('getDiff: index flags cannot hide working tree changes', () => {
  function flagged(flag: string): string {
    const repo = freshRepo();
    put(repo, 'a.test.js', 'it("a", () => {});\n');
    put(repo, 'clean.test.js', 'it("c", () => {});\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'init');
    sh(repo, 'update-index', flag, 'a.test.js', 'clean.test.js');
    return repo;
  }
  const added = (diff: string, file: string): string[] =>
    parseUnifiedDiff(diff).filter((h) => h.file === file).flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.text));
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    it(`shows a change to a file flagged ${flag}, and nothing for a clean flagged file`, async () => {
      const repo = flagged(flag);
      put(repo, 'a.test.js', 'it.skip("a", () => {});\n');
      const diff = await getDiff(repo, { workingTree: true });
      expect(added(diff, 'a.test.js')).toEqual(['it.skip("a", () => {});']);
      expect(parseUnifiedDiff(diff).some((h) => h.file === 'clean.test.js')).toBe(false);
    });
    it(`shows the deletion of a file flagged ${flag}`, async () => {
      const repo = flagged(flag);
      rmSync(path.join(repo, 'a.test.js'));
      expect(parseUnifiedDiff(await getDiff(repo, { workingTree: true })).find((h) => h.file === 'a.test.js')?.status).toBe('deleted');
    });
  }
  it('leaves the index flags as they were', async () => {
    const repo = flagged('--skip-worktree');
    put(repo, 'a.test.js', 'it.skip("a", () => {});\n');
    await getDiff(repo, { workingTree: true });
    expect(sh(repo, 'ls-files', '-v', 'a.test.js')).toBe('S a.test.js');
  });
});

