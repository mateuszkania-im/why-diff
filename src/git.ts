/**
 * Thin, shell-free git helpers built on `child_process.execFile`.
 *
 * Everything here is read-only: the working tree and index are never mutated
 * (untracked files are diffed by reading them and synthesising hunks instead
 * of `git add -N`).
 */

import { execFile, spawn } from 'node:child_process';
import { copyFile, lstat, mkdtemp, open, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseUnifiedDiff } from './diff-parse.js';
import { BINARY_HUNK_HEADER } from './types.js';

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
  /**
   * In a sparse checkout, leave out skip-worktree files missing from the working tree (default true).
   * The guard passes false when the sparse checkout setup changed during the session.
   */
  honourSparseCheckout?: boolean;
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
 * Config that must not change what git reports about the working tree or a diff, whatever the
 * repository (or an agent working in it) set: no fsmonitor hook deciding which files changed, no
 * user attributes file, no external diff program, fixed `a/` `b/` prefixes, repo-relative paths.
 */
const SAFE_CONFIG = [
  'core.quotePath=false',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=',
  'diff.external=',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
  'core.bigFileThreshold=512m',
].flatMap((c) => ['-c', c]);

/**
 * Raised when why-diff cannot make git show the true content (a filter driver it cannot switch off,
 * an unreadable config). The guard blocks on it instead of letting the agent finish unchecked.
 */
export class FailClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailClosedError';
  }
}

const filterOverrides = new Map<string, Promise<Record<string, string>>>();

/**
 * Environment that switches off every filter driver configured for the repository at `cwd`
 * (`filter.<name>.clean` / `process` / `smudge` / `required`): a clean filter rewrites working tree
 * content before git compares it, so `*.js filter=x` plus `filter.x.clean = sed s/it.skip/it/`
 * would hide a change. The overrides travel as `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, which
 * take any name (`-c` cannot carry one holding `=`); inherited `GIT_CONFIG_*` entries are dropped
 * (see {@link baseEnv}). If the config cannot be listed, this throws {@link FailClosedError}.
 */
function filterEnv(cwd: string): Promise<Record<string, string>> {
  let found = filterOverrides.get(cwd);
  if (!found) {
    found = execFileAsync('git', ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], { cwd, encoding: 'utf8', env: baseEnv() })
      .then(({ stdout }) => stdout, (err: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => {
        // exit 1 with no output: no filter configured
        if ((err.code as unknown) === 1 && !err.stdout && !err.stderr) return '';
        if (err.code === 'ENOENT') throw new Error('git executable not found on PATH');
        throw new FailClosedError(`cannot list git filter drivers (${String(err.stderr ?? err.message).trim()})`);
      })
      .then((out) => {
        const names = new Set<string>();
        for (const key of out.split('\0')) {
          if (!key) continue;
          const m = /^filter\.([\s\S]+)\.[^.]+$/.exec(key);
          if (!m) throw new FailClosedError(`cannot switch off git filter config ${JSON.stringify(key)}`);
          names.add(m[1]!);
        }
        const env: Record<string, string> = {};
        let n = 0;
        for (const name of names) {
          for (const [k, v] of [['clean', ''], ['process', ''], ['smudge', ''], ['required', 'false']] as const) {
            env[`GIT_CONFIG_KEY_${n}`] = `filter.${name}.${k}`;
            env[`GIT_CONFIG_VALUE_${n}`] = v;
            n++;
          }
        }
        if (names.size) env.GIT_CONFIG_COUNT = String(n);
        return env;
      });
    filterOverrides.set(cwd, found);
    // Config can change between runs in one process (tests); a guard run is short.
    setTimeout(() => filterOverrides.delete(cwd), 1000).unref();
  }
  return found;
}

/**
 * Environment for every git process: no optional locks, C locale, no replace refs and no grafts
 * (either could make a commit read as another one), and filter drivers off. Every inherited `GIT_*`
 * variable is dropped first: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`... would point git at another
 * repository, index or config than the one in the working directory. Only the ones set here (and
 * per call by why-diff itself) reach git.
 */
const NO_GRAFTS = path.join(os.tmpdir(), `why-diff-no-grafts-${randomBytes(8).toString('hex')}`);
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: NO_GRAFTS };
}
async function gitEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  return { ...baseEnv(), ...(await filterEnv(cwd)) };
}

/**
 * Run git in `cwd` without a shell. Resolves with trimmed-right stdout.
 * `-c core.quotePath=false` keeps non-ASCII paths readable in diff headers; see {@link SAFE_CONFIG}.
 * `input` is written to git's standard input.
 */
export async function git(cwd: string, args: string[], opts: { trim?: boolean; maxBuffer?: number; env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const env = { ...(await gitEnv(cwd)), ...opts.env };
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile('git', [...SAFE_CONFIG, ...args], { cwd, maxBuffer: opts.maxBuffer ?? MAX_BUFFER, encoding: 'utf8', env }, (err, out, stderr) => {
      if (!err) return resolve(out);
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      if (e.code === 'ENOENT') return reject(new Error('git executable not found on PATH'));
      reject(new GitError(args, String(stderr || e.message), typeof e.code === 'number' ? e.code : null));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
  return opts.trim === false ? stdout : stdout.replace(/\s+$/, '');
}

/** Default size of the path arguments on one git command line (Windows caps a whole command line at 32767 characters). */
const ARGV_BUDGET = process.platform === 'win32' ? 12_000 : 96_000;

/**
 * Split `paths` into groups whose arguments fit one command line (`WHY_DIFF_ARGV_BUDGET`, in bytes,
 * overrides the budget, for tests). `git diff` and `git ls-files` cannot read pathspecs from stdin,
 * so a long list (thousands of files a session touched) is run in several calls instead of one that
 * fails with E2BIG.
 */
export function chunkPaths(paths: readonly string[]): string[][] {
  const budget = Number(process.env.WHY_DIFF_ARGV_BUDGET) > 0 ? Number(process.env.WHY_DIFF_ARGV_BUDGET) : ARGV_BUDGET;
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const p of paths) {
    const n = Buffer.byteLength(p) + 3; // separator and quoting
    if (cur.length && size + n > budget) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * `git <args> -- <paths>`, split by {@link chunkPaths} when the list is long, outputs joined in order.
 * No paths (undefined or empty) means no pathspec at all: the whole tree.
 */
export async function gitPaths(cwd: string, args: string[], paths: readonly string[] | undefined, opts: { maxBuffer?: number; env?: Record<string, string> } = {}): Promise<string> {
  if (!paths?.length) return git(cwd, args, { ...opts, trim: false });
  let out = '';
  for (const chunk of chunkPaths(paths)) out += await git(cwd, [...args, '--', ...chunk], { ...opts, trim: false });
  return out;
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

/**
 * Does the repository's file system ignore letter case? Asked of the file system itself (`.git`
 * and `.GIT` are the same entry), not only of `core.ignorecase`, which anyone can set to false.
 */
export async function isCaseInsensitive(root: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  try {
    const [a, b] = await Promise.all([stat(path.join(root, '.git')), stat(path.join(root, '.GIT'))]);
    if (a.ino === b.ino && a.dev === b.dev) return true;
  } catch {
    // `.GIT` missing: case-sensitive, unless git says otherwise
  }
  return (await git(root, ['config', '--bool', 'core.ignorecase']).catch(() => '')) === 'true';
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
  return (await getDiffDetailed(cwd, target, opts)).diff;
}

/** A diff plus the files shown as binary stubs that could not be re-diffed as text (see {@link revealTextMarkedBinary}). */
export interface DetailedDiff {
  diff: string;
  /** Repo paths git showed as binary because of attributes, whose text could not be produced */
  unreviewed: string[];
}

/** {@link getDiff}, also listing the files whose real content could not be shown. */
export async function getDiffDetailed(cwd: string, target: DiffTarget, opts: DiffOptions = {}): Promise<DetailedDiff> {
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

async function getDiffUnwrapped(cwd: string, target: DiffTarget, opts: DiffOptions): Promise<DetailedDiff> {
  const unified = `--unified=${opts.unified ?? 3}`;
  // No textconv and no external diff: the diff shows the bytes, not what a filter makes of them.
  const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', unified];

  if (typeof target === 'string') {
    // A range is a revision, never an option (`--output=<file>` would make git write a file).
    if (target.startsWith('-')) throw new Error(`invalid range "${target}"`);
    return revealTextMarkedBinary(cwd, [...common, target], await git(cwd, [...common, target], { trim: false }));
  }

  let baseRev: string;
  if (target.baseRev && (await hasHead(cwd))) {
    baseRev = target.baseRev;
  } else if (await hasHead(cwd)) {
    baseRev = target.base ? await mergeBase(cwd, target.base, 'HEAD') : 'HEAD';
  } else {
    baseRev = await emptyTree(cwd); // unborn branch: everything tracked is "added"
  }
  const revealed = await revealTextMarkedBinary(cwd, [...common, baseRev], await gitPaths(cwd, [...common, baseRev], opts.paths));
  let diff = revealed.diff;
  const unreviewed = [...revealed.unreviewed];
  // Files flagged assume-unchanged or skip-worktree: git diff takes their index entry for the
  // working tree file, so a change to them would not show. Diff them again through a copy of the
  // index with the flags cleared (the real index is never touched).
  const hidden = await indexFlagged(cwd, opts.paths, opts.honourSparseCheckout ?? true).catch(() => null);
  if (hidden === null) throw new FailClosedError('cannot list index entries flagged assume-unchanged or skip-worktree');
  if (hidden.length) {
    const own = await diffWithoutIndexFlags(cwd, [...common, baseRev], hidden).catch(() => null);
    if (own === null) {
      unreviewed.push(...hidden);
    } else {
      const names = new Set(hidden);
      const kept = splitSections(diff).filter((section) => {
        const h = parseUnifiedDiff(section)[0];
        return !h || !(names.has(h.file) || (h.oldFile !== undefined && names.has(h.oldFile)));
      });
      diff = kept.join('') + own.diff;
      unreviewed.push(...own.unreviewed);
    }
  }

  if (target.includeUntracked !== false) {
    const root = await repoRoot(cwd);
    const untracked = await listUntracked(cwd, opts.paths);
    for (const rel of untracked) {
      const synthetic = await syntheticAddedFileDiff(root, rel);
      if (synthetic) diff += synthetic;
    }
  }
  return { diff, unreviewed };
}

/**
 * Index entries flagged assume-unchanged (lowercase tag in `git ls-files -v`) or skip-worktree
 * (`S`). In a sparse checkout (`core.sparseCheckout`), a skip-worktree file missing from the working
 * tree is expected and left out, unless `honourSparse` is false.
 */
export async function indexFlagged(cwd: string, paths?: string[], honourSparse = true): Promise<string[]> {
  const root = await repoRoot(cwd);
  const out = await gitPaths(root, ['ls-files', '-v', '-z'], paths);
  const sparse = honourSparse && (await git(root, ['config', '--bool', 'core.sparseCheckout']).catch(() => '')) === 'true';
  const flagged: string[] = [];
  for (const entry of out.split('\0')) {
    if (entry.length < 3 || entry[1] !== ' ') continue;
    const tag = entry[0]!;
    const file = entry.slice(2);
    const skipWorktree = tag === 'S' || tag === 's';
    if (!(skipWorktree || (tag >= 'a' && tag <= 'z'))) continue;
    if (skipWorktree && sparse && !(await lstat(path.join(root, file)).then(() => true, () => false))) continue;
    flagged.push(file);
  }
  return [...new Set(flagged)];
}

/** `args` (a `git diff` up to its base revision) for `files`, against a temporary copy of the index without their flags. */
async function diffWithoutIndexFlags(cwd: string, args: string[], files: string[]): Promise<DetailedDiff> {
  const root = await repoRoot(cwd);
  const index = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'index']));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'why-diff-index-'));
  try {
    const copy = path.join(dir, 'index');
    await copyFile(index, copy);
    const env = { GIT_INDEX_FILE: copy };
    const literal = files.map((f) => `:(literal)${f}`);
    // One flag per call: git applies only the first of the two to the paths when both are given.
    const list = files.map((f) => `${f}\0`).join('');
    await git(root, ['update-index', '--no-skip-worktree', '-z', '--stdin'], { env, input: list });
    await git(root, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], { env, input: list });
    const raw = await gitPaths(root, args, literal, { env });
    return await revealTextMarkedBinary(root, args, raw);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Git's binary sniff: a NUL byte within the first this many bytes of either side. */
const BINARY_SNIFF = 8000;

/**
 * Git shows a file as binary when its content is (a NUL byte in the first 8000 bytes of either
 * side), but also when attributes say so (`*.js -diff` in `.gitattributes` or `.git/info/attributes`,
 * a diff driver with `binary = true`). Attributes cannot be switched off for a diff, so every file
 * shown as binary whose content git would call text is diffed again with `--text`, and that text
 * replaces the binary stub. NUL bytes later in such a file are shown as U+2400. There is no file or
 * size cap: if the content cannot be checked, the file is re-diffed as text (fail closed).
 */
async function revealTextMarkedBinary(cwd: string, args: string[], diff: string): Promise<DetailedDiff> {
  if (!diff.includes('Binary files ') && !diff.includes('GIT binary patch')) return { diff, unreviewed: [] };
  const sections = splitSections(diff);
  const binary = new Map<number, string[]>();
  for (const [i, section] of sections.entries()) {
    const h = parseUnifiedDiff(section)[0];
    if (h?.header === BINARY_HUNK_HEADER) binary.set(i, [...new Set([h.file, ...(h.oldFile ? [h.oldFile] : [])])]);
  }
  if (!binary.size) return { diff, unreviewed: [] };
  const realBinary = await binaryByContent(cwd, args, [...new Set([...binary.values()].flat())]).catch(() => new Set<string>());
  // One re-diff per file group (a rename re-diffs both of its names together), in small batches; a
  // batch that fails (too big, git error) is retried file by file, and a file that still fails is
  // reported as unreviewed rather than passed off as binary.
  const groups = [...binary.values()].filter((names) => !names.some((n) => realBinary.has(n)));
  const maxBuffer = Number(process.env.WHY_DIFF_REDIFF_MAX_BYTES) || REDIFF_MAX_BYTES;
  const byFile = new Map<string, string>();
  const unreviewed = new Set<string>();
  const rediff = (names: string[]): Promise<string> =>
    gitPaths(cwd, [...args, '--text'], names.map((f) => `:(literal)${f}`), { maxBuffer });
  const take = (out: string): void => {
    for (const section of splitSections(out)) {
      const h = parseUnifiedDiff(section)[0];
      if (h) byFile.set(h.file, section.replace(/\0/g, '\u2400'));
    }
  };
  for (let i = 0; i < groups.length; i += REDIFF_BATCH) {
    const batch = groups.slice(i, i + REDIFF_BATCH);
    try {
      take(await rediff(batch.flat()));
    } catch {
      for (const names of batch) {
        try {
          take(await rediff(names));
        } catch {
          unreviewed.add(names[0]!);
        }
      }
    }
  }
  return {
    diff: sections.map((section, i) => {
      const names = binary.get(i);
      return (names && byFile.get(names[0]!)) ?? section;
    }).join(''),
    unreviewed: [...unreviewed],
  };
}

const REDIFF_BATCH = 16;
/** Output cap for one re-diff (`WHY_DIFF_REDIFF_MAX_BYTES` overrides it, for tests). */
const REDIFF_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Of `files` (paths on either side of the diff `args` describes), those whose content is binary by
 * git's own rule, ignoring attributes: a NUL byte in the first 8000 bytes of the old or the new side.
 */
async function binaryByContent(cwd: string, args: string[], files: string[]): Promise<Set<string>> {
  const raw = (await gitPaths(cwd, [...args.filter((a) => !a.startsWith('--unified')), '--raw', '-z', '--no-abbrev'], files.map((f) => `:(literal)${f}`))).split('\0');
  const root = await repoRoot(cwd);
  const entries: Array<{ shas: string[]; paths: string[] }> = [];
  for (let i = 0; i < raw.length; ) {
    const meta = raw[i]!;
    if (!meta.startsWith(':')) { i++; continue; }
    const [, , oldSha = '', newSha = '', status = ''] = meta.slice(1).split(' ');
    const n = /^[RC]/.test(status) ? 2 : 1;
    entries.push({ shas: [oldSha, newSha], paths: raw.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  const heads = await blobHeads(cwd, [...new Set(entries.flatMap((e) => e.shas).filter((s) => !/^0+$/.test(s)))], BINARY_SNIFF);
  const out = new Set<string>();
  for (const e of entries) {
    let isBinary = false;
    for (const sha of e.shas) {
      // All zeros: no blob (added or deleted side) or the working tree file (new side).
      const head = /^0+$/.test(sha)
        ? sha === e.shas[1] ? await readHead(path.join(root, e.paths[e.paths.length - 1]!), BINARY_SNIFF) : undefined
        : heads.get(sha);
      if (head?.includes(0)) isBinary = true;
    }
    if (isBinary) for (const p of e.paths) out.add(p);
  }
  return out;
}

async function readHead(file: string, n: number): Promise<Buffer | undefined> {
  const fh = await open(file, 'r').catch(() => undefined);
  if (!fh) return undefined;
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The first `n` bytes of each blob, read through one `git cat-file --batch` (contents streamed, not kept). */
function blobHeads(cwd: string, shas: string[], n: number): Promise<Map<string, Buffer>> {
  const heads = new Map<string, Buffer>();
  if (!shas.length) return Promise.resolve(heads);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_CONFIG, 'cat-file', '--batch'], { cwd, env: baseEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    // cat-file --batch reads raw objects: no filters apply.
    let pending: Buffer = Buffer.alloc(0);
    let current: { sha: string; left: number; head: Buffer[]; kept: number } | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (!current) {
          const nl = pending.indexOf(0x0a);
          if (nl === -1) return;
          const [sha = '', type = '', size = ''] = pending.subarray(0, nl).toString('latin1').split(' ');
          pending = pending.subarray(nl + 1);
          if (type === 'missing' || !size) continue;
          current = { sha, left: Number(size) + 1, head: [], kept: 0 };
        }
        if (!pending.length) return;
        const take = Math.min(current.left, pending.length);
        const part = pending.subarray(0, take);
        if (current.kept < n) {
          const keep = part.subarray(0, n - current.kept);
          current.head.push(Buffer.from(keep));
          current.kept += keep.length;
        }
        current.left -= take;
        pending = pending.subarray(take);
        if (current.left === 0) {
          heads.set(current.sha, Buffer.concat(current.head).subarray(0, n));
          current = null;
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(heads) : reject(new Error(`git cat-file exited ${code}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(`${shas.join('\n')}\n`);
  });
}

/** A diff split into its per-file sections (each starting with `diff --git`). */
function splitSections(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean);
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
  const out = await gitPaths(root, ['ls-files', '--others', '--exclude-standard', '-z'], paths);
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
  let mode = '100644';
  try {
    // lstat: a symlink is shown as git shows it (its target text, mode 120000); what it points at
    // (possibly outside the repo) is never read.
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      buf = Buffer.from(await readlink(abs, { encoding: 'buffer' }));
      mode = '120000';
    } else {
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
      buf = await readFile(abs);
    }
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
  const header = `diff --git ${oldSide} ${newSide}\nnew file mode ${mode}\nindex 0000000..0000000\n--- /dev/null\n+++ ${newSide}\n`;
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
