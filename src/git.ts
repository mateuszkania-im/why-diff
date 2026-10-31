/**
 * Thin, shell-free git helpers built on `child_process.execFile`.
 *
 * Everything here is read-only: the working tree and index are never mutated
 * (untracked files are diffed by reading them and synthesising hunks instead
 * of `git add -N`).
 */

import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Raised when a git command exits non-zero. `stderr` carries git's message. */
export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? '?'}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Diff of the working tree (index + unstaged + optionally untracked) against a base. */
export interface WorkingTreeTarget {
  workingTree: true;
  /** Include untracked (non-ignored) files as added hunks. Default true. */
  includeUntracked?: boolean;
  /**
   * Compare against `merge-base(base, HEAD)` instead of HEAD, so the diff is
   * "everything on this branch plus uncommitted work" in one pass.
   */
  base?: string;
  /** Diff against this exact revision instead of HEAD / the merge base (wins over `base`). */
  baseRev?: string;
}

/**
 * What to diff: a git revision range (`main...HEAD`, `HEAD~3..HEAD`, a single
 * commit-ish meaning `<rev>..HEAD`... anything `git diff` accepts), or the
 * working tree.
 */
export type DiffTarget = string | WorkingTreeTarget;

export interface DiffOptions {
  /** Context lines (`--unified=N`). Default 3. */
  unified?: number;
  /** Git pathspecs limiting both the tracked diff and the untracked files (e.g. `:(literal)src/a.ts`). */
  paths?: string[];
}

/** Output of `resolveDefaultTarget`. */
export interface ResolvedTarget {
  target: DiffTarget;
  /** Human label for the report header, e.g. "origin/main...HEAD + working tree". */
  label: string;
  /** Base ref the branch was compared against, when one was found. */
  base?: string;
  /** True when HEAD is on (or equal to) a base candidate, so there is no branch to compare. */
  onBase?: boolean;
}

/** Time window covered by a diff target. */
export interface TimeWindow {
  /**
   * Time of the base commit the diff starts from (merge base, left side of a
   * range, or HEAD for working-tree diffs). All diffed work happened after it.
   */
  since: Date;
  until: Date;
  /** Number of commits inside the range (0 for working-tree-only diffs). */
  commits: number;
}

const MAX_BUFFER = 512 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
/** Untracked files above this size are not diffed (build outputs, dumps, media). */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * Run git in `cwd` without a shell. Resolves with trimmed-right stdout.
 * `-c core.quotePath=false` keeps non-ASCII paths readable in diff headers.
 */
export async function git(cwd: string, args: string[], opts: { trim?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return opts.trim === false ? stdout : stdout.replace(/\s+$/, '');
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    if (e.code === 'ENOENT') throw new Error('git executable not found on PATH');
    throw new GitError(args, String(e.stderr ?? e.message), typeof e.code === 'number' ? e.code : null);
  }
}

/** Absolute path of the repository top level containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/**
 * Absolute real paths of every git worktree of the repository containing `cwd`,
 * except the one `cwd` belongs to. Empty when git cannot list them.
 */
export async function worktreeRoots(cwd: string): Promise<string[]> {
  try {
    const self = await realpath(await repoRoot(cwd));
    const out = await git(cwd, ['worktree', 'list', '--porcelain']);
    const roots: string[] = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const p = line.slice('worktree '.length);
      const real = await realpath(p).catch(() => path.resolve(p));
      if (real !== self && !roots.includes(real)) roots.push(real);
    }
    return roots;
  } catch {
    return [];
  }
}

/** Current branch name, or `undefined` on a detached HEAD / unborn branch. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const name = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** True when `rev` resolves to a commit. */
export async function revExists(cwd: string, rev: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** True when the repository has at least one commit. */
export async function hasHead(cwd: string): Promise<boolean> {
  return revExists(cwd, 'HEAD');
}

/**
 * Produce unified diff text for `target`.
 *
 * - string: passed straight to `git diff <range>`.
 * - working tree: `git diff <base-or-HEAD>` (staged + unstaged) plus synthetic
 *   "new file" sections for untracked files, read from disk (binary skipped).
 */
export async function getDiff(cwd: string, target: DiffTarget, opts: DiffOptions = {}): Promise<string> {
  try {
    return await getDiffUnwrapped(cwd, target, opts);
  } catch (err) {
    if (err instanceof GitError && MISSING_REVISION.test(err.stderr) && (await isShallow(cwd))) {
      throw new Error(`${SHALLOW_HINT} (${err.stderr.trim()})`);
    }
    throw err;
  }
}

/** Git errors a deeper fetch can fix: a revision or merge base the shallow history lacks. */
const MISSING_REVISION = /unknown revision|bad revision|no merge base|ambiguous argument|not a valid object name|bad object|invalid symmetric difference/i;

async function getDiffUnwrapped(cwd: string, target: DiffTarget, opts: DiffOptions): Promise<string> {
  const unified = `--unified=${opts.unified ?? 3}`;
  const common = ['diff', '--no-color', '--no-ext-diff', '-M', unified];

  if (typeof target === 'string') {
    // A range is a revision, never an option (`--output=<file>` would make git write a file).
    if (target.startsWith('-')) throw new Error(`invalid range "${target}"`);
    return git(cwd, [...common, target], { trim: false });
  }

  let baseRev: string;
  if (target.baseRev && (await hasHead(cwd))) {
    baseRev = target.baseRev;
  } else if (await hasHead(cwd)) {
    baseRev = target.base ? await mergeBase(cwd, target.base, 'HEAD') : 'HEAD';
  } else {
    baseRev = await emptyTree(cwd); // unborn branch: everything tracked is "added"
  }
  const pathspec = opts.paths?.length ? ['--', ...opts.paths] : [];
  let diff = await git(cwd, [...common, baseRev, ...pathspec], { trim: false });

  if (target.includeUntracked !== false) {
    const root = await repoRoot(cwd);
    const untracked = await listUntracked(cwd, opts.paths);
    for (const rel of untracked) {
      const synthetic = await syntheticAddedFileDiff(root, rel);
      if (synthetic) diff += synthetic;
    }
  }
  return diff;
}

/**
 * Hash of the empty tree for this repository's object format (SHA-1 or
 * SHA-256), so a repo with no commits can still be diffed.
 */
export async function emptyTree(cwd: string): Promise<string> {
  return git(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
}

/** Merge base of two revisions (falls back to `a` when unrelated histories). */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  try {
    return await git(cwd, ['merge-base', a, b]);
  } catch {
    return git(cwd, ['rev-parse', '--verify', a]);
  }
}

/** Untracked, non-ignored files relative to the repo root. */
export async function listUntracked(cwd: string, paths?: string[]): Promise<string[]> {
  const root = await repoRoot(cwd);
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...(paths?.length ? ['--', ...paths] : [])], { trim: false });
  return out.split('\0').filter((p) => p.length > 0 && !p.startsWith('.why-diff/'));
}

/** True in a shallow clone (`git clone --depth N`, default `actions/checkout`). */
export async function isShallow(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-shallow-repository'])) === 'true';
  } catch {
    return false;
  }
}

export const SHALLOW_HINT = 'this is a shallow clone; fetch full history (actions/checkout: fetch-depth: 0)';

/**
 * Build a `git diff`-shaped "new file" section for an untracked file. Returns
 * `null` for binary files, directories and files that cannot be read.
 */
async function syntheticAddedFileDiff(root: string, rel: string): Promise<string | null> {
  const abs = path.join(root, rel);
  let buf: Buffer;
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
    buf = await readFile(abs);
  } catch {
    return null;
  }
  if (looksBinary(buf)) {
    const side = quotePathIfNeeded(`b/${rel}`);
    return `diff --git ${quotePathIfNeeded(`a/${rel}`)} ${side}\nnew file mode 100644\nindex 0000000..0000000\nBinary files /dev/null and ${side} differ\n`;
  }
  const content = buf.toString('utf8');
  // git quotes the whole prefixed path: `"a/weird \"name\".txt"`.
  const oldSide = quotePathIfNeeded(`a/${rel}`);
  const newSide = quotePathIfNeeded(`b/${rel}`);
  const header = `diff --git ${oldSide} ${newSide}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ ${newSide}\n`;
  if (content.length === 0) return header;
  const endsWithNewline = content.endsWith('\n');
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  let body = `@@ -0,0 +1,${lines.length} @@\n`;
  for (const l of lines) body += `+${l}\n`;
  if (!endsWithNewline) body += '\\ No newline at end of file\n';
  return header + body;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Mirror git's C-quoting for paths with control characters, quotes or backslashes. */
function quotePathIfNeeded(p: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x1f"\\\x7f]/.test(p)) return p;
  let out = '"';
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * Pick what to diff when the user gave no range:
 * 1. On a branch that has a merge base with a base candidate (explicit `base`,
 *    CI target-branch variables, origin's default branch, then `origin/main`,
 *    `main`, `master`, `develop`, `trunk`) and is not that base itself:
 *    everything since the merge base, including uncommitted work.
 * 2. Otherwise: working tree vs HEAD (plus untracked files).
 */
export async function resolveDefaultTarget(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitBase?: string,
): Promise<ResolvedTarget> {
  const workingTree: ResolvedTarget = {
    target: { workingTree: true, includeUntracked: true },
    label: 'working tree',
  };
  if (!(await hasHead(cwd))) return workingTree;

  const branch = await currentBranch(cwd);
  const head = await git(cwd, ['rev-parse', 'HEAD']);

  if (explicitBase?.startsWith('-')) throw new Error(`invalid base "${explicitBase}"`);
  const candidates: string[] = [];
  if (explicitBase) {
    candidates.push(`origin/${explicitBase}`, explicitBase);
  } else {
    // A ref is never an option (same rule as ranges in getDiff).
    for (const x of [env.GITHUB_BASE_REF, env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME, env.BITBUCKET_PR_DESTINATION_BRANCH]) {
      if (x && !x.startsWith('-')) candidates.push(`origin/${x}`, x);
    }
    try {
      candidates.push(await git(cwd, ['rev-parse', '--abbrev-ref', 'refs/remotes/origin/HEAD']));
    } catch {
      // no origin/HEAD
    }
    candidates.push('origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop', 'origin/trunk', 'trunk');
  }

  let onBase = false;
  for (const base of candidates) {
    if (base === branch || base === `origin/${branch}`) {
      onBase = true;
      continue;
    }
    if (!(await revExists(cwd, base))) continue;
    let mb: string;
    try {
      mb = await git(cwd, ['merge-base', base, 'HEAD']);
    } catch {
      continue;
    }
    if (mb === head) {
      onBase = true; // nothing on this branch beyond the base
      continue;
    }
    return {
      target: { workingTree: true, includeUntracked: true, base },
      label: `${base}...HEAD + working tree`,
      base,
    };
  }
  return { ...workingTree, onBase };
}

/**
 * Time window for `target`: from the base commit the diff starts at to now.
 *
 * The edits that produced a range's *first* commit happened before that
 * commit, so the window opens at the commit the work builds on: the merge
 * base for `A...B` and `{ base }` targets, `A` for `A..B`, the named revision
 * for a bare `<rev>` (git diffs it against the working tree), and HEAD for
 * plain working-tree diffs. The earlier of author/committer time is used so
 * rebases and amends never shrink the window. Repos without commits start at
 * the epoch.
 */
export async function commitTimes(cwd: string, target: DiffTarget): Promise<TimeWindow> {
  const until = new Date();
  if (!(await hasHead(cwd))) return { since: new Date(0), until, commits: 0 };

  let baseRev = 'HEAD';
  let countRange: string | null = null;
  if (typeof target === 'string') {
    const symmetric = target.indexOf('...');
    const twoDot = target.indexOf('..');
    if (symmetric !== -1) {
      const left = target.slice(0, symmetric) || 'HEAD';
      const right = target.slice(symmetric + 3) || 'HEAD';
      baseRev = await mergeBase(cwd, left, right);
      countRange = target;
    } else if (twoDot !== -1) {
      baseRev = target.slice(0, twoDot) || 'HEAD';
      countRange = target;
    } else {
      baseRev = target;
      countRange = `${target}..HEAD`;
    }
  } else if (target.baseRev) {
    baseRev = target.baseRev;
    countRange = `${baseRev}..HEAD`;
  } else if (target.base) {
    baseRev = await mergeBase(cwd, target.base, 'HEAD');
    countRange = `${baseRev}..HEAD`;
  }

  let since: Date;
  try {
    const out = await git(cwd, ['log', '-1', '--format=%aI%n%cI', baseRev]);
    const stamps = out.split('\n').map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
    since = new Date(Math.min(...stamps));
  } catch {
    const headTime = await git(cwd, ['log', '-1', '--format=%cI', 'HEAD']);
    since = new Date(headTime);
  }

  if (countRange) {
    try {
      const authored = (await git(cwd, ['log', '--format=%aI', countRange]))
        .split('\n')
        .map((l) => Date.parse(l))
        .filter((n) => !Number.isNaN(n));
      if (authored.length) since = new Date(Math.min(since.getTime(), ...authored));
    } catch {
      // keep the base time
    }
  }

  let commits = 0;
  if (countRange) {
    try {
      commits = Number(await git(cwd, ['rev-list', '--count', countRange])) || 0;
    } catch {
      commits = 0;
    }
  }
  return { since, until, commits };
}

/** Repository name: basename of the repo root. */
export async function repoName(cwd: string): Promise<string> {
  return path.basename(await repoRoot(cwd));
}
