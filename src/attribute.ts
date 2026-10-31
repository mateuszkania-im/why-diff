/**
 * Attribution: which agent edit (and therefore which human prompt) explains
 * each changed line of the diff.
 *
 * For every hunk we look at the non-failed edits that touched the same file
 * and decide, line by line, which edit owns each added / removed line:
 *
 * 1. Exact pass: trailing whitespace is ignored and added lines are matched
 *    as contiguous runs inside each edit's `newText`. An edit that
 *    *introduced* a line (it is in its newText but not in its oldText, counted
 *    as a multiset) always beats one that merely carried the line as unchanged
 *    context inside old_string/new_string. Among equals the longest matching
 *    run wins, then the latest edit, so an agent rewriting the same line twice
 *    is credited to its final edit.
 * 2. Fragment pass: Claude Code's Edit tool replaces substrings, so an edit's
 *    old/new text often starts and ends mid-line (`Math.round(sub * taxRate)`
 *    -> `Math.round(discounted * taxRate)`). The first line of such text is
 *    treated as a line suffix, the last as a line prefix, a single line as an
 *    infix. An added line ending with / starting with / containing that
 *    fragment is claimed when the fragment is substantial (three or more
 *    non-space characters, not only punctuation) and was actually introduced
 *    (it differs from the old text). When putting the old fragment back into
 *    the added line reproduces one of the hunk's removed lines, the match is
 *    as good as a whole-line one; containment alone counts as `partial`.
 * 3. Fuzzy pass: lines still unexplained are compared with all whitespace and
 *    trailing `;`/`,` removed. This absorbs formatter (prettier, gofmt) runs
 *    after the edit but caps the hunk at `partial`.
 * 4. Trivial lines (blank, lone braces/brackets) never claim an owner on their
 *    own, because `}` appears in every edit ever made; they inherit the owner
 *    of their neighbour.
 *
 * Removed lines are owned by the edit whose `oldText` contained them and whose
 * `newText` did not (a Write's previous content, or a whole-file overwrite via
 * bash heredoc, counts as removing everything it replaced); sub-line fragments
 * apply symmetrically with the old text.
 *
 * Hunks whose changed lines all share one owner prompt are reported whole.
 * Hunks that mix owners (two prompts, or a prompt and a human) are split into
 * segments `h1.1`, `h1.2`, ... of consecutive changed lines with the same
 * owner, each with recomputed ranges/header and up to two lines of context,
 * so a human line hidden inside an agent hunk gets its own `unattributed`
 * entry instead of diluting a percentage. Splitting is kept readable:
 *
 * - Lines no edit explains, in a file an opaque shell command (sed -i, a
 *   formatter, a script) also touched, resolve to that command's prompt, so
 *   they do not break up a run of lines owned by the same prompt.
 * - A run of fewer than `MIN_SEGMENT_RUN` changed lines flanked on both sides
 *   by the same other owner is folded into that owner's segment: a human line
 *   or two inside agent work lowers the coverage and gets an info label naming
 *   the lines; an incidental one-line match inside human work does not turn
 *   it into agent work. Runs at a hunk's edge are kept as their own segment.
 * - In a new file where one prompt owns at least `DOMINANT_SHARE` of the
 *   lines, the hunk stays whole except for unexplained runs of
 *   `MIN_SEGMENT_RUN` lines or more, which are carved out.
 * - A hunk that would still shatter into many tiny segments (more than
 *   `MAX_SEGMENTS`, averaging under `MIN_LINES_PER_SEGMENT` changed lines) is
 *   reported as one hunk owned by the majority owner, with labels and the
 *   edits list describing the mix. Alternating owners every few lines is a
 *   formatter or script at work, not a story a reviewer can follow.
 *
 * Hunks carry `EditRef`s (edits without their text bodies); the report keeps
 * every referenced edit once in `Report.edits`.
 *
 * Labels added here: `unattributed` and `bash-edit`. Everything else is added
 * later by the labels module.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { DRIVE_PATH, driveKey } from './adapters/scan.js';

import type { AttributedHunk, DiffLine, EditRef, FileEdit, Hunk, Label, MatchStrength, Prompt, Session } from './types.js';

/** Edit enriched with precomputed, normalised line data. */
interface IndexedEdit {
  edit: FileEdit;
  /** Global order (session order, then transcript order); tie-breaker for equal timestamps. */
  seq: number;
  atMs: number;
  /** Repo-relative POSIX path, or null when the edit lies outside the repo. */
  rel: string | null;
  /** Lines written, exact- and fuzzy-normalised (null when the edit carries no text). */
  newExact: string[] | null;
  newFuzzy: string[] | null;
  /** Lines replaced, as multisets. */
  oldExact: Map<string, number> | null;
  oldFuzzy: Map<string, number> | null;
  /** Lines this edit created: in newText but not (as often) in oldText. */
  introducedExact: Map<string, number>;
  introducedFuzzy: Map<string, number>;
  /** Lines this edit deleted: in oldText but not (as often) in newText. */
  removedExact: Map<string, number>;
  removedFuzzy: Map<string, number>;
  /** Whole-file replacement with unknown previous content: deletes whatever was there. */
  replacesWholeFile: boolean;
  /** Sub-line view of an Edit-style replacement (null for whole-file writes and bash). */
  fragments: Fragments | null;
}

/**
 * One side (old or new text) of a substring replacement as lines. The first
 * line may be the tail of a real line and the last line the head of one (a
 * single line is an infix), so they are matched as fragments, not whole lines.
 * `norm` (trailing whitespace stripped) is used to find the fragment in a diff
 * line; `raw` decides whether a fragment really changed (a dropped trailing
 * space is a change) and rebuilds the counterpart line.
 */
interface FragmentText {
  norm: string[];
  raw: string[];
  rawSet: Set<string>;
}

interface Fragments {
  new: FragmentText;
  old: FragmentText;
}

interface Owner {
  edit: IndexedEdit;
  /** Matched only after whitespace normalisation. */
  fuzzy: boolean;
  /** The edit introduced/removed the line rather than carrying it as context. */
  strong: boolean;
  /** Length of the contiguous run the line was matched in. */
  run: number;
}

const MAX_POSITIONS_PER_LINE = 64;
const SEGMENT_CONTEXT = 2;
/** A run of changed lines flanked by one other owner needs this many lines to stand as its own segment. */
const MIN_SEGMENT_RUN = 3;
/** Share of a new file's changed lines one prompt must own for the hunk to stay whole. */
const DOMINANT_SHARE = 0.9;
/** Beyond this many segments, a hunk averaging fewer than MIN_LINES_PER_SEGMENT changed lines each is collapsed. */
const MAX_SEGMENTS = 8;
const MIN_LINES_PER_SEGMENT = 8;
/** File-only matches list at most this many (most recent) edits that touched the file. */
const MAX_FILE_ONLY_EDITS = 8;
const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/;

/**
 * Attribute every hunk to the agent edits (and prompts) that explain it.
 * Hunks with lines from several owners come back as several segments.
 *
 * @param hunks     Parsed diff hunks (repo-relative paths).
 * @param sessions  Parsed agent sessions whose edits are candidates.
 * @param repoRoot  Absolute repository root, used to relativise edit paths.
 * @param opts.since Start of the diff's time window. Edits older than this can
 *                  still match by content (branches merged later), but are not
 *                  used for the weak file-only fallback.
 */
export function attribute(hunks: Hunk[], sessions: Session[], repoRoot: string, opts: { since?: Date; extraRoots?: string[] } = {}): AttributedHunk[] {
  const prompts = new Map<string, Prompt>();
  for (const s of sessions) for (const p of s.prompts) prompts.set(p.id, p);

  const diffFiles = new Set<string>();
  for (const h of hunks) {
    diffFiles.add(h.file.normalize('NFC'));
    if (h.oldFile) diffFiles.add(h.oldFile.normalize('NFC'));
  }
  const index = indexEdits(sessions, repoRoot, diffFiles, opts.extraRoots);
  index.sinceMs = opts.since?.getTime();
  return hunks.flatMap((hunk) => attributeHunk(hunk, index, prompts));
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/** One shell command the agent ran (a Bash tool call), whatever files it was seen to touch. */
interface ShellCommand {
  atMs: number;
  command: string;
  /** Repo-relative paths bash-mutations detected for it that may have changed content (may be empty). */
  rels: string[];
  /** False when every detected operation of the command only changes metadata (chmod, chown, touch). */
  contentOps: boolean;
}

/** Shell operations that change metadata, never content: they explain no changed line. */
const NON_CONTENT_OPS: ReadonlySet<string> = new Set(['chmod', 'touch']);
/** Operations on the repo root itself (`.`) that can rewrite any file below it. */
const REPO_WIDE_OPS: ReadonlySet<string> = new Set(['restore', 'format']);

/** Does a shell edit of `rel` with this op count as touching content there? */
function shellRelCounts(op: string | undefined, rel: string): boolean {
  if (op !== undefined && NON_CONTENT_OPS.has(op)) return false;
  if (rel === '' || rel === '.') return op === undefined || REPO_WIDE_OPS.has(op);
  return true;
}

interface EditIndex {
  byFile: Map<string, IndexedEdit[]>;
  /** Bash edits whose path may be a directory or glob; matched by prefix/pattern. */
  bash: IndexedEdit[];
  /** Every shell command in the sessions, for "was this file touched by a shell command" checks. */
  shell: ShellCommand[];
  /** Repo root variants in POSIX form, for matching absolute paths in command text. */
  roots: string[];
  /** Window start (ms); older edits do not count for file-only matches. */
  sinceMs?: number;
  /** Built on first use (after `sinceMs` is known) by `touchedByShell`. */
  shellIndex?: ShellIndex;
}

/** What the in-window shell commands named or were seen to touch, for O(1) per-file lookups. */
interface ShellIndex {
  /** Path-like tokens of command text, repo-relative (root and `./` prefixes stripped). */
  tokens: Set<string>;
  /** Exact repo-relative paths (files or directories) bash-mutations detected. */
  rels: Set<string>;
  /** Detected paths containing glob characters. */
  globs: string[];
}

function indexEdits(sessions: Session[], repoRoot: string, diffFiles: Set<string> = new Set(), extraRoots: string[] = []): EditIndex {
  // Longest first: a worktree nested in the repo (`.claude/worktrees/x`) must win over the repo root.
  const roots = [repoRoot, ...extraRoots].flatMap(rootVariants).sort((a, b) => b.length - a.length);
  const byFile = new Map<string, IndexedEdit[]>();
  const bash: IndexedEdit[] = [];
  const shell = new Map<string, ShellCommand>();
  let seq = 0;

  const resolved = sessions.map((session) => {
    const cwdVariants = rootVariants(session.cwd);
    return session.edits.map((edit) => (edit.failed ? null : repoRelativePath(edit.filePath, roots, session.cwd, cwdVariants)));
  });
  const worktrees = nestedWorktreeRoots(sessions, resolved, diffFiles);

  for (const [si, session] of sessions.entries()) {
    for (const [ei, edit] of session.edits.entries()) {
      if (edit.failed) continue;
      let rel = resolved[si]?.[ei] ?? null;
      if (worktrees.length) rel = remapWorktree(edit, rel, session.cwd, worktrees) ?? rel;
      if (edit.kind === 'bash' && edit.command) {
        const key = `${edit.sessionId}:${edit.toolUseId}`;
        let cmd = shell.get(key);
        if (!cmd) {
          cmd = { atMs: Date.parse(edit.at) || 0, command: edit.command, rels: [], contentOps: false };
          shell.set(key, cmd);
        }
        if (rel !== null && shellRelCounts(edit.bashOp, rel)) cmd.rels.push(rel);
        if (edit.bashOp === undefined || !NON_CONTENT_OPS.has(edit.bashOp)) cmd.contentOps = true;
      }
      if (rel === null) continue;
      const indexed = indexEdit(edit, seq++, rel);
      if (edit.kind === 'bash') bash.push(indexed);
      const list = byFile.get(rel);
      if (list) list.push(indexed);
      else byFile.set(rel, [indexed]);
    }
  }
  const byRecency = (a: IndexedEdit, b: IndexedEdit): number => a.atMs - b.atMs || a.seq - b.seq;
  for (const list of byFile.values()) list.sort(byRecency);
  bash.sort(byRecency);
  return { byFile, bash, shell: [...shell.values()], roots: roots.map((r) => r.split(path.sep).join('/')) };
}

/**
 * Did any shell command in the window touch `file`? True when bash-mutations
 * saw the command write the file (or its directory / a glob covering it), or
 * when the command text names the file's repo path as a whole token (a
 * script run from elsewhere, `node fix.js src/a.ts`), which bash-mutations
 * cannot follow.
 */
function touchedByShell(raw: string, index: EditIndex): boolean {
  const file = raw.normalize('NFC');
  const shell = (index.shellIndex ??= buildShellIndex(index));
  if (shell.tokens.has(file) || shell.rels.has(file) || shell.rels.has('') || shell.rels.has('.')) return true;
  for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
    if (shell.rels.has(file.slice(0, slash))) return true;
  }
  return shell.globs.some((g) => globToRegExp(g).test(file));
}

const PATH_TOKEN_SEPARATOR = /[^\w./-]+/;

/** Index the in-window shell commands once: path-like tokens of their text plus the paths detected for them. */
function buildShellIndex(index: EditIndex): ShellIndex {
  const since = index.sinceMs;
  const tokens = new Set<string>();
  const rels = new Set<string>();
  const globs: string[] = [];
  const prefixes = index.roots.map((r) => `${r}/`);
  for (const s of index.shell) {
    if (since !== undefined && s.atMs !== 0 && s.atMs < since) continue;
    for (const rel of s.rels) {
      if (/[*?[]/.test(rel)) globs.push(rel);
      else rels.add(rel);
    }
    if (!s.contentOps) continue; // chmod/chown/touch only: naming a file does not change it
    for (const raw of s.command.split(PATH_TOKEN_SEPARATOR)) {
      if (!raw) continue;
      let token = raw;
      for (const prefix of prefixes) {
        if (token.startsWith(prefix)) {
          token = token.slice(prefix.length);
          break;
        }
      }
      if (token.startsWith('./')) token = token.slice(2);
      if (token) tokens.add(token);
    }
  }
  return { tokens, rels, globs: [...new Set(globs)] };
}

/** A repo-relative path that lies inside a nested worktree checkout (`.claude/worktrees/<name>/...`). */
const NESTED_WORKTREE = /(?:^|\/)\.?(?:claude\/)?worktrees\/[^/]+\//;

function absoluteEditPath(edit: FileEdit, cwd: string): string | null {
  if (path.isAbsolute(edit.filePath)) return path.normalize(edit.filePath);
  return cwd ? path.resolve(cwd, edit.filePath) : null;
}

/**
 * Directories that look like other checkouts (git worktrees) of this repo:
 * agents often work in `git worktree add /tmp/wt-x` or `.claude/worktrees/x`
 * and the result lands here via merge. A directory qualifies when an edit
 * outside the repo (or inside a nested `worktrees/<name>/`) ends with the
 * path of a file in this diff that has at least one directory component, so
 * a lone `package.json` in some other project is not enough. Line content
 * still has to match for any hunk to be attributed.
 */
function nestedWorktreeRoots(sessions: Session[], resolved: Array<Array<string | null>>, diffFiles: Set<string>): string[] {
  const byBase = new Map<string, string[]>();
  for (const f of diffFiles) {
    if (!f.includes('/')) continue;
    const base = f.slice(f.lastIndexOf('/') + 1);
    const list = byBase.get(base);
    if (list) list.push(f);
    else byBase.set(base, [f]);
  }
  if (byBase.size === 0) return [];
  const roots = new Set<string>();
  for (const [si, session] of sessions.entries()) {
    for (const [ei, edit] of session.edits.entries()) {
      if (edit.failed) continue;
      const rel = resolved[si]?.[ei];
      if (rel !== null && rel !== undefined && !NESTED_WORKTREE.test(rel)) continue;
      const abs = absoluteEditPath(edit, session.cwd);
      if (!abs) continue;
      const posix = abs.split(path.sep).join('/');
      let best: string | undefined;
      for (const f of byBase.get(posix.slice(posix.lastIndexOf('/') + 1)) ?? []) {
        if (posix.endsWith(`/${f}`) && (!best || f.length > best.length)) best = f;
      }
      if (best) roots.add(posix.slice(0, posix.length - best.length - 1));
    }
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/** Repo-relative path of an edit made inside one of `worktrees`, else null. */
function remapWorktree(edit: FileEdit, rel: string | null, cwd: string, worktrees: string[]): string | null {
  if (rel !== null && !NESTED_WORKTREE.test(rel)) return null;
  const abs = absoluteEditPath(edit, cwd);
  if (!abs) return null;
  const posix = abs.split(path.sep).join('/');
  for (const root of worktrees) {
    if (posix.startsWith(`${root}/`)) return posix.slice(root.length + 1);
  }
  return null;
}

function indexEdit(edit: FileEdit, seq: number, rel: string): IndexedEdit {
  const newLines = edit.newText === null ? null : splitLines(edit.newText);
  const oldLines = edit.oldText === null ? null : splitLines(edit.oldText);
  const newExact = newLines?.map(normExact) ?? null;
  const newFuzzy = newLines?.map(normFuzzy) ?? null;
  const oldExact = oldLines ? countLines(oldLines.map(normExact)) : null;
  const oldFuzzy = oldLines ? countLines(oldLines.map(normFuzzy)) : null;
  return {
    edit,
    seq,
    atMs: Date.parse(edit.at) || 0,
    rel,
    newExact,
    newFuzzy,
    oldExact,
    oldFuzzy,
    introducedExact: difference(newExact ? countLines(newExact) : new Map(), oldExact),
    introducedFuzzy: difference(newFuzzy ? countLines(newFuzzy) : new Map(), oldFuzzy),
    removedExact: difference(oldExact ?? new Map(), newExact ? countLines(newExact) : null),
    removedFuzzy: difference(oldFuzzy ?? new Map(), newFuzzy ? countLines(newFuzzy) : null),
    replacesWholeFile: edit.oldText === null && edit.newText !== null && (edit.kind === 'write' || edit.kind === 'bash'),
    fragments:
      edit.kind === 'edit' && newExact && newLines && oldLines
        ? {
            new: { norm: newExact, raw: newLines, rawSet: new Set(newLines) },
            old: { norm: oldLines.map(normExact), raw: oldLines, rawSet: new Set(oldLines) },
          }
        : null,
  };
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
}

/** Multiset difference a − b, keeping only positive counts. */
function difference(a: Map<string, number>, b: Map<string, number> | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, n] of a) {
    const left = n - (b?.get(key) ?? 0);
    if (left > 0) out.set(key, left);
  }
  return out;
}

/**
 * Repo-relative POSIX path for an absolute edit path, trying the root and
 * its realpath, and remapping paths under the session cwd when that cwd is a
 * symlink alias of a directory inside the repo (macOS `/tmp` -> `/private/tmp`).
 */
export function repoRelativePath(
  filePath: string,
  roots: string[],
  cwd = '',
  cwdVariants: string[] = rootVariants(cwd),
): string | null {
  if (DRIVE_PATH.test(filePath) || (!path.isAbsolute(filePath) && DRIVE_PATH.test(cwd))) return driveRelativePath(filePath, roots, cwd);
  // Compared in Unicode NFC: macOS file APIs and agents may hand over NFD names (`cafe\u0301.js`)
  // where git reports NFC (`caf\u00e9.js`).
  const candidates = new Set<string>();
  const nfcCwd = cwd.normalize('NFC');
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath.normalize('NFC')) : nfcCwd ? path.resolve(nfcCwd, filePath.normalize('NFC')) : null;
  if (!abs) return null;
  cwdVariants = cwdVariants.map((v) => v.normalize('NFC'));
  roots = roots.map((r) => r.normalize('NFC'));
  candidates.add(abs);
  for (const v of cwdVariants) {
    for (const w of cwdVariants) {
      if (v !== w && (abs === v || abs.startsWith(v + path.sep))) candidates.add(w + abs.slice(v.length));
    }
  }
  for (const c of candidates) {
    for (const root of roots) {
      if (c === root) return '';
      if (c.startsWith(root + path.sep)) return path.relative(root, c).split(path.sep).join('/');
    }
  }
  return null;
}

/** {@link repoRelativePath} for Windows drive paths: case-insensitive, either slash style. */
function driveRelativePath(filePath: string, roots: string[], cwd: string): string | null {
  const abs = (DRIVE_PATH.test(filePath) ? filePath : `${cwd}/${filePath}`).normalize('NFC').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/(?:\.\/)+/g, '/').replace(/\/$/, '');
  const lower = abs.toLowerCase();
  for (const root of roots) {
    if (!DRIVE_PATH.test(root)) continue;
    const r = driveKey(root.normalize('NFC'));
    if (lower === r) return '';
    if (lower.startsWith(`${r}/`) && abs.length === lower.length) return abs.slice(r.length + 1);
  }
  return null;
}

export function rootVariants(p: string): string[] {
  if (!p) return [];
  const normalised = path.resolve(p);
  const out = new Set<string>([normalised]);
  try {
    out.add(realpathSync(normalised));
  } catch {
    // path may not exist any more
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Per-hunk attribution
// ---------------------------------------------------------------------------

function attributeHunk(hunk: Hunk, index: EditIndex, prompts: Map<string, Prompt>): AttributedHunk[] {
  const candidates = candidatesFor(hunk, index);
  const lines = hunk.lines;
  const addedIdx: number[] = [];
  const removedIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.type === 'add') addedIdx.push(i);
    else if (l.type === 'del') removedIdx.push(i);
  });

  const addedText = addedIdx.map((i) => lines[i]?.text ?? '');
  const removedText = removedIdx.map((i) => lines[i]?.text ?? '');
  const addOwners = explainAdded(addedText, candidates, removedText.map(normExact));
  const delOwners = explainRemoved(removedText, candidates, addedText.map(normExact));
  const owners: Array<Owner | null> = new Array<Owner | null>(lines.length).fill(null);
  addedIdx.forEach((i, n) => (owners[i] = addOwners[n] ?? null));
  removedIdx.forEach((i, n) => (owners[i] = delOwners[n] ?? null));

  const changed = [...addedIdx, ...removedIdx].sort((a, b) => a - b);

  // "Touched the same file" is weak evidence: only edits inside the window count.
  const since = index.sinceMs;
  const recent = since === undefined ? candidates : candidates.filter((c) => c.atMs === 0 || c.atMs >= since);
  if (changed.length === 0 || changed.every((i) => owners[i] === null)) {
    return [unexplained(hunk, recent, prompts, index)];
  }
  return splitHunk(hunk, owners, changed, recent, prompts, index);
}

/** Nothing in the hunk text matches an edit: file-only when the file was touched, else none. */
function unexplained(hunk: Hunk, candidates: IndexedEdit[], prompts: Map<string, Prompt>, index: EditIndex): AttributedHunk {
  if (candidates.length === 0) {
    return { hunk, match: 'none', coverage: 0, editIds: [], edits: [], labels: [unattributedLabel(hunk, index, false)] };
  }
  const recent = candidates.slice(-MAX_FILE_ONLY_EDITS);
  const latest = recent[recent.length - 1];
  const prompt = latest ? prompts.get(latest.edit.promptId) : undefined;
  return {
    hunk,
    match: 'file-only',
    coverage: 0,
    ...refs(recent),
    ...(prompt ? { prompt } : {}),
    labels: labelsFor('file-only', recent),
  };
}

/** A hunk or segment of changed lines nobody explains (human edit or unrecorded tool). */
function unattributedSegment(hunk: Hunk, index: EditIndex): AttributedHunk {
  return { hunk, match: 'none', coverage: 0, editIds: [], edits: [], labels: [unattributedLabel(hunk, index, true)] };
}

/**
 * The `unattributed` label for lines no edit explains. When a shell command
 * in the window touched the file (a script, a formatter we could not follow)
 * the lines are more likely its output than a human's, so the label is
 * informational; otherwise it warns.
 */
function unattributedLabel(hunk: Hunk, index: EditIndex, segment: boolean): Label {
  if (touchedByShell(hunk.file, index)) {
    return { kind: 'unattributed', severity: 'info', detail: 'Not traced to a specific edit (the file was also changed by agent shell commands).' };
  }
  return {
    kind: 'unattributed',
    severity: 'warn',
    detail: segment
      ? 'No agent edit explains these lines (human edit or unrecorded tool) although the rest of the hunk is agent work.'
      : 'No agent edit in the analysed sessions explains this hunk.',
  };
}

/** Consecutive changed lines (indices into `hunk.lines`) that resolve to one prompt (null = nobody). */
interface Group {
  idx: number[];
  promptId: string | null;
}

/**
 * Split a hunk whose changed lines have different owners into segments of
 * consecutive changed lines (context between same-owner lines is kept inside
 * the segment) sharing one owner prompt, each with up to two context lines.
 * Returns the hunk whole (original id) when everything folds into one group.
 */
function splitHunk(
  hunk: Hunk,
  owners: Array<Owner | null>,
  changed: number[],
  candidates: IndexedEdit[],
  prompts: Map<string, Prompt>,
  index: EditIndex,
): AttributedHunk[] {
  // Shell commands whose output we cannot read (sed -i, formatters) may have
  // produced the unexplained lines: credit them to the latest such command's
  // prompt rather than calling them human.
  const opaqueBash = candidates.filter((c) => c.edit.kind === 'bash' && c.newExact === null).slice(-MAX_FILE_ONLY_EDITS);
  const bashPromptId = opaqueBash[opaqueBash.length - 1]?.edit.promptId ?? null;

  let groups: Group[] = [];
  for (const i of changed) {
    const promptId = promptOf(owners[i]) ?? bashPromptId;
    const last = groups[groups.length - 1];
    if (last && last.promptId === promptId) last.idx.push(i);
    else groups.push({ idx: [i], promptId });
  }
  if (hunk.status === 'added') groups = absorbMinorOwners(groups, changed.length);
  groups = absorbShortRuns(groups);
  if (groups.length > MAX_SEGMENTS && changed.length / groups.length < MIN_LINES_PER_SEGMENT) groups = [collapse(groups)];

  const build = (segment: Hunk, g: Group): AttributedHunk =>
    g.promptId === null ? unattributedGroup(segment, g, owners, hunk.lines, index) : explainedGroup(segment, g, owners, opaqueBash, prompts, hunk.lines, index);

  const only = groups[0];
  if (groups.length === 1 && only) return [build(hunk, only)];

  const lines = hunk.lines;
  const section = HUNK_HEADER.exec(hunk.header)?.[1] ?? '';
  return groups.map((g, n) => {
    const start = g.idx[0] ?? 0;
    const end = g.idx[g.idx.length - 1] ?? start;
    let from = start;
    for (let k = 0; k < SEGMENT_CONTEXT && from > 0 && lines[from - 1]?.type === 'ctx'; k++) from--;
    let to = end;
    for (let k = 0; k < SEGMENT_CONTEXT && to < lines.length - 1 && lines[to + 1]?.type === 'ctx'; k++) to++;
    const segmentLines = lines.slice(from, to + 1);
    const range = segmentRange(hunk, from, segmentLines);
    const segment: Hunk = {
      ...hunk,
      id: `${hunk.id}.${n + 1}`,
      ...range,
      header: `@@ -${formatRange(range.oldStart, range.oldLines)} +${formatRange(range.newStart, range.newLines)} @@${section}`,
      lines: segmentLines,
    };
    return build(segment, g);
  });
}

/**
 * New file dominated by one prompt (>= DOMINANT_SHARE of changed lines): keep
 * it whole, carving out only unexplained runs of MIN_UNATTRIBUTED_RUN+ lines.
 * Lines of minor owners stay credited to their edits (listed in `edits`).
 */
function absorbMinorOwners(groups: Group[], total: number): Group[] {
  const counts = new Map<string, number>();
  for (const g of groups) if (g.promptId !== null) counts.set(g.promptId, (counts.get(g.promptId) ?? 0) + g.idx.length);
  let top: string | null = null;
  let topCount = 0;
  for (const [promptId, n] of counts) {
    if (n > topCount) {
      top = promptId;
      topCount = n;
    }
  }
  if (top === null || topCount < DOMINANT_SHARE * total) return groups;
  const out: Group[] = [];
  for (const g of groups) {
    const carve = g.promptId === null && g.idx.length >= MIN_SEGMENT_RUN;
    const last = out[out.length - 1];
    if (carve) out.push(g);
    else if (last && last.promptId === top) last.idx.push(...g.idx);
    else out.push({ idx: [...g.idx], promptId: top });
  }
  return out;
}

/** Fold runs of fewer than MIN_SEGMENT_RUN changed lines that sit between two runs of one other owner into that owner. */
function absorbShortRuns(groups: Group[]): Group[] {
  const out = groups.map((g) => ({ idx: [...g.idx], promptId: g.promptId }));
  for (let i = 1; i < out.length - 1; ) {
    const prev = out[i - 1];
    const run = out[i];
    const next = out[i + 1];
    if (prev && run && next && run.idx.length < MIN_SEGMENT_RUN && prev.promptId === next.promptId && prev.promptId !== run.promptId) {
      out.splice(i - 1, 3, { promptId: prev.promptId, idx: [...prev.idx, ...run.idx, ...next.idx] });
      i = Math.max(1, i - 1);
    } else {
      i++;
    }
  }
  return out;
}

/** One group for the whole hunk, owned by whoever owns most changed lines (nobody counts too). */
function collapse(groups: Group[]): Group {
  const counts = new Map<string | null, number>();
  for (const g of groups) counts.set(g.promptId, (counts.get(g.promptId) ?? 0) + g.idx.length);
  let top: string | null = null;
  let topCount = -1;
  for (const [promptId, n] of counts) {
    if (n > topCount) {
      top = promptId;
      topCount = n;
    }
  }
  return { promptId: top, idx: groups.flatMap((g) => g.idx) };
}

/**
 * A segment owned by nobody. Lines in it that do match an edit (a short run
 * folded in, or a collapsed hunk) keep their edits listed and raise the
 * coverage, but the segment stays prompt-less: it is mostly not agent work.
 */
function unattributedGroup(segment: Hunk, g: Group, owners: Array<Owner | null>, lines: DiffLine[], index: EditIndex): AttributedHunk {
  const contentOwners: Owner[] = [];
  let added = 0;
  let ownedAdded = 0;
  for (const i of g.idx) {
    const line = lines[i];
    const owner = owners[i];
    if (!line) continue;
    if (line.type === 'add') added++;
    if (owner) {
      contentOwners.push(owner);
      if (line.type === 'add') ownedAdded++;
    }
  }
  if (contentOwners.length === 0) return unattributedSegment(segment, index);
  const unowned = g.idx.length - contentOwners.length;
  const shell = touchedByShell(segment.file, index);
  const of = `${unowned} of ${g.idx.length} changed line${g.idx.length === 1 ? '' : 's'}`;
  return {
    hunk: segment,
    match: 'partial',
    coverage: added === 0 ? 0 : ownedAdded / added,
    ...refs(uniqueEdits(contentOwners.map((o) => o.edit))),
    labels: [
      shell
        ? { kind: 'unattributed', severity: 'info', detail: `${of} not traced to a specific edit (the file was also changed by agent shell commands); the rest match the edits listed.` }
        : { kind: 'unattributed', severity: 'warn', detail: `${of} match no agent edit (human edit or unrecorded tool); the rest match the edits listed.` },
    ],
  };
}

/**
 * A segment whose changed lines resolve to one prompt. Lines owned by edits
 * set the match; lines nobody explains lower the coverage and add an info
 * label (bash-edit when an opaque shell command touched the file, else
 * unattributed). All-bash-resolved segments are file-only.
 */
function explainedGroup(
  segment: Hunk,
  g: Group,
  owners: Array<Owner | null>,
  opaqueBash: IndexedEdit[],
  prompts: Map<string, Prompt>,
  lines: DiffLine[],
  index: EditIndex,
): AttributedHunk {
  const contentOwners: Owner[] = [];
  const unownedAt: number[] = [];
  let added = 0;
  let ownedAdded = 0;
  for (const i of g.idx) {
    const line = lines[i];
    const owner = owners[i];
    if (!line) continue;
    if (line.type === 'add') added++;
    if (owner) {
      contentOwners.push(owner);
      if (line.type === 'add') ownedAdded++;
    } else {
      unownedAt.push(line.newNo ?? line.oldNo ?? 0);
    }
  }
  // Every line resolved through an opaque shell command: a file-only match on that command.
  if (contentOwners.length === 0) return unexplained(segment, opaqueBash, prompts, index);

  const edits = uniqueEdits(contentOwners.map((o) => o.edit));
  const viaBash = unownedAt.length > 0 && opaqueBash.length > 0;
  const match: MatchStrength = unownedAt.length > 0 || contentOwners.some((o) => o.fuzzy) ? 'partial' : 'exact';
  const prompt = g.promptId ? prompts.get(g.promptId) : undefined;
  const labels = labelsFor(match, edits);
  if (unownedAt.length > 0) {
    const n = unownedAt.length;
    const of = `${n} of ${g.idx.length} changed line${g.idx.length === 1 ? '' : 's'}`;
    if (viaBash) {
      const cmd = opaqueBash[opaqueBash.length - 1]?.edit.command ?? '';
      labels.push({ kind: 'bash-edit', severity: 'info', detail: `${of} match no recorded edit; the file was also touched by a shell command (${shorten(cmd, 80)}).` });
    } else {
      labels.push({ kind: 'unattributed', severity: 'info', detail: `${of} (${lineList(unownedAt)}) match no agent edit; shown with the prompt that owns the lines around them.` });
    }
  }
  return {
    hunk: segment,
    match,
    coverage: added === 0 ? 1 : ownedAdded / added,
    ...refs(viaBash ? uniqueEdits([...edits, ...opaqueBash]) : edits),
    ...(prompt ? { prompt } : {}),
    labels,
  };
}

function lineList(numbers: number[], max = 5): string {
  const shown = numbers.slice(0, max).map((n) => `L${n}`);
  return numbers.length > max ? `${shown.join(', ')}, …` : shown.join(', ');
}

/** Old/new start and line counts for a slice of a hunk, following git's header conventions. */
function segmentRange(hunk: Hunk, from: number, segment: DiffLine[]): Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'> {
  const firstOld = segment.find((l) => l.oldNo !== undefined)?.oldNo;
  const firstNew = segment.find((l) => l.newNo !== undefined)?.newNo;
  // A side with no lines is anchored at the last line before the segment
  // on that side (git writes "-N,0" where N is the line *before* an insertion).
  const before = hunk.lines.slice(0, from);
  const prevOld = [...before].reverse().find((l) => l.oldNo !== undefined)?.oldNo;
  const prevNew = [...before].reverse().find((l) => l.newNo !== undefined)?.newNo;
  return {
    oldStart: firstOld ?? prevOld ?? Math.max(0, hunk.oldStart - (hunk.oldLines > 0 ? 1 : 0)),
    oldLines: segment.filter((l) => l.type !== 'add').length,
    newStart: firstNew ?? prevNew ?? Math.max(0, hunk.newStart - (hunk.newLines > 0 ? 1 : 0)),
    newLines: segment.filter((l) => l.type !== 'del').length,
  };
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Edits that touched this hunk's file (new or old name), including bash prefix/glob hits. */
function candidatesFor(hunk: Hunk, index: EditIndex): IndexedEdit[] {
  const files = (hunk.oldFile ? [hunk.file, hunk.oldFile] : [hunk.file]).map((f) => f.normalize('NFC'));
  const set = new Set<IndexedEdit>();
  for (const f of files) for (const e of index.byFile.get(f) ?? []) set.add(e);
  for (const e of index.bash) {
    if (e.rel === null || set.has(e)) continue;
    if (!shellRelCounts(e.edit.bashOp, e.rel) && !NON_CONTENT_OPS.has(e.edit.bashOp ?? '')) continue;
    if (files.some((f) => bashPathMatches(e.rel ?? '', f))) set.add(e);
  }
  // chmod/chown/touch explain a mode change or an empty new file, never changed lines.
  const changesLines = hunk.lines.some((l) => l.type !== 'ctx');
  return [...set]
    .filter((e) => !(changesLines && e.edit.kind === 'bash' && NON_CONTENT_OPS.has(e.edit.bashOp ?? '')))
    .sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
}

/** A bash edit path matches a file when it is that file, a parent directory, or a glob covering it. */
function bashPathMatches(editRel: string, file: string): boolean {
  if (editRel === file) return true;
  if (editRel === '' || file.startsWith(`${editRel}/`)) return true;
  if (/[*?[]/.test(editRel)) return globToRegExp(editRel).test(file);
  return false;
}

const globCache = new Map<string, RegExp>();

/** Shell glob to an anchored RegExp: `*` and `?` stay within one path segment, `**` spans segments. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Line matching
// ---------------------------------------------------------------------------

/** Is `candidate` a better explanation for a line than the current owner? */
function prefer(candidate: Owner, current: Owner | null): boolean {
  if (!current) return true;
  if (candidate.fuzzy !== current.fuzzy) return !candidate.fuzzy;
  if (candidate.strong !== current.strong) return candidate.strong;
  if (candidate.run !== current.run) return candidate.run > current.run;
  return isLater(candidate.edit, current.edit);
}

/**
 * Owner per added line (null = unexplained). `removed` holds the hunk's
 * removed lines (exact-normalised) so sub-line matches can be verified by
 * reconstructing the line an edit replaced.
 */
function explainAdded(added: string[], candidates: IndexedEdit[], removed: string[] = []): Array<Owner | null> {
  const owners: Array<Owner | null> = new Array<Owner | null>(added.length).fill(null);
  if (added.length === 0) return owners;
  const trivial = added.map((l) => TRIVIAL_LINE.test(l));
  const exact = added.map(normExact);

  const pass = (keys: string[], source: (c: IndexedEdit) => string[] | null, introduced: (c: IndexedEdit) => Map<string, number>, fuzzy: boolean): void => {
    for (const cand of candidates) {
      const lines = source(cand);
      if (!lines || lines.length === 0) continue;
      const strongKeys = introduced(cand);
      matchRuns(keys, lines, (start, run) => {
        for (let i = start; i < start + run; i++) {
          if (trivial[i]) continue;
          const owner: Owner = { edit: cand, fuzzy, strong: strongKeys.has(keys[i] ?? ''), run };
          if (prefer(owner, owners[i] ?? null)) owners[i] = owner;
        }
      });
    }
  };

  pass(exact, (c) => c.newExact, (c) => c.introducedExact, false);

  // Sub-line replacements: the added line ends with / starts with / contains
  // the fragment the edit wrote.
  const removedSet = new Set(removed);
  for (let i = 0; i < exact.length; i++) {
    if (trivial[i]) continue;
    for (const cand of candidates) {
      if (!cand.fragments) continue;
      const rebuilt = fragmentMatch(exact[i] ?? '', cand.fragments.new, cand.fragments.old, removedSet, removed);
      if (rebuilt === null) continue;
      const owner: Owner = { edit: cand, fuzzy: !rebuilt, strong: true, run: 1 };
      if (prefer(owner, owners[i] ?? null)) owners[i] = owner;
    }
  }

  if (owners.some((o, i) => o === null && !trivial[i])) {
    pass(added.map(normFuzzy), (c) => c.newFuzzy, (c) => c.introducedFuzzy, true);
  }
  inheritTrivial(added, owners);
  return owners;
}

/** Fragments shorter than this (non-space characters) or made only of punctuation never claim a line. */
const MIN_FRAGMENT_CHARS = 3;
/** Occurrences of a fragment tried per line (`replace_all` edits repeat it). */
const MAX_FRAGMENT_POSITIONS = 16;

function substantialFragment(frag: string): boolean {
  const stripped = frag.replace(/\s+/g, '');
  return stripped.length >= MIN_FRAGMENT_CHARS && /[\p{L}\p{N}_]/u.test(stripped);
}

/**
 * Does `line` carry one of `from`'s fragments (first line as a suffix, last
 * line as a prefix, a single line anywhere) that `to` does not contain?
 *
 * Returns `true` when swapping the fragment for its `to` counterpart rebuilds
 * a line of `other` (the opposite side of the hunk), i.e. the edit demonstrably
 * turned that line into this one; `false` for containment alone; `null` for
 * no match. Used for added lines (`from` = newText, `to` = oldText, `other` =
 * removed lines) and symmetrically for removed lines.
 */
function fragmentMatch(line: string, from: FragmentText, to: FragmentText, other: Set<string>, otherList: string[]): boolean | null {
  const n = from.norm.length;
  const m = to.norm.length;
  if (n === 0 || m === 0) return null;
  // Raw counterparts keep their whitespace so a rebuilt line is byte-exact
  // (`" * Grand total: "` + rest), then compared after trailing-space stripping.
  const toFirst = to.raw[0] ?? '';
  const toLast = to.raw[m - 1] ?? '';
  const has = (s: string): boolean => other.has(normExact(s));
  let found: boolean | null = null;
  const record = (rebuilt: boolean): void => {
    if (found !== true) found = rebuilt;
  };
  /** A fragment claims nothing when it is the whole line, too small, or unchanged from the other side. */
  const eligible = (idx: number): boolean => {
    const norm = from.norm[idx] ?? '';
    return norm !== line && substantialFragment(norm) && !to.rawSet.has(from.raw[idx] ?? '');
  };

  if (n === 1) {
    if (!eligible(0)) return null;
    const raw = from.raw[0] ?? '';
    const frag = line.includes(raw) ? raw : (from.norm[0] ?? '');
    let p = line.indexOf(frag);
    if (p === -1) return null;
    if (m === 1 && has(line.split(frag).join(toFirst))) return true; // replace_all: every occurrence swapped
    for (let tries = 0; p !== -1 && tries < MAX_FRAGMENT_POSITIONS; tries++, p = line.indexOf(frag, p + 1)) {
      const prefix = line.slice(0, p);
      const suffix = line.slice(p + frag.length);
      record(m === 1 ? has(prefix + toFirst + suffix) : has(prefix + toFirst) || has(toLast + suffix));
    }
    return found;
  }

  // First line of the text: the tail of a real line.
  const first = from.norm[0] ?? '';
  if (eligible(0) && line.endsWith(first)) {
    const prefix = line.slice(0, line.length - first.length);
    record(m === 1 ? otherList.some((o) => o !== line && o.startsWith(normExact(prefix + toFirst))) : has(prefix + toFirst));
  }
  // Last line of the text: the head of a real line (raw first, so a trailing
  // space inside the fragment is not mistaken for the start of the remainder).
  const lastRaw = from.raw[n - 1] ?? '';
  const lastNorm = from.norm[n - 1] ?? '';
  const head = line.startsWith(lastRaw) ? lastRaw : line.startsWith(lastNorm) ? lastNorm : null;
  if (eligible(n - 1) && head !== null) {
    const suffix = line.slice(head.length);
    record(m === 1 ? otherList.some((o) => o !== line && o.endsWith(normExact(toLast + suffix))) : has(toLast + suffix));
  }
  return found;
}

/**
 * Owner per removed line: the edit that deleted it (whole line or sub-line
 * fragment, verified against the hunk's `added` lines), else one whose
 * oldText carried it.
 */
function explainRemoved(removed: string[], candidates: IndexedEdit[], added: string[] = []): Array<Owner | null> {
  const owners: Array<Owner | null> = new Array<Owner | null>(removed.length).fill(null);
  if (removed.length === 0) return owners;
  const addedSet = new Set(added);
  for (let i = 0; i < removed.length; i++) {
    const text = removed[i] ?? '';
    if (TRIVIAL_LINE.test(text)) continue;
    const exact = normExact(text);
    const fuzzy = normFuzzy(text);
    for (const cand of candidates) {
      // Every way this edit could explain the line; `prefer` ranks them (a
      // rebuildable fragment beats a whitespace-insensitive whole-line match).
      const options: Owner[] = [];
      if (cand.oldExact?.has(exact)) options.push({ edit: cand, fuzzy: false, strong: cand.removedExact.has(exact), run: 1 });
      if (fuzzy && cand.oldFuzzy?.has(fuzzy)) options.push({ edit: cand, fuzzy: true, strong: cand.removedFuzzy.has(fuzzy), run: 1 });
      if (cand.fragments) {
        const rebuilt = fragmentMatch(exact, cand.fragments.old, cand.fragments.new, addedSet, added);
        if (rebuilt !== null) options.push({ edit: cand, fuzzy: !rebuilt, strong: true, run: 1 });
      }
      if (options.length === 0 && cand.replacesWholeFile) options.push({ edit: cand, fuzzy: false, strong: false, run: 0 });
      for (const owner of options) if (prefer(owner, owners[i] ?? null)) owners[i] = owner;
    }
  }
  inheritTrivial(removed, owners);
  return owners;
}

/**
 * Report every maximal matching run of `target` inside `source`.
 * `onRun(start, length)` is called for each target index that begins a run.
 * Runs may only start on non-trivial lines but extend through trivial ones.
 */
function matchRuns(target: string[], source: string[], onRun: (start: number, length: number) => void): void {
  const positions = new Map<string, number[]>();
  for (let p = 0; p < source.length; p++) {
    const key = source[p] ?? '';
    if (TRIVIAL_LINE.test(key)) continue;
    const list = positions.get(key);
    if (!list) positions.set(key, [p]);
    else if (list.length < MAX_POSITIONS_PER_LINE) list.push(p);
  }
  let coveredUntil = 0;
  for (let i = 0; i < target.length; i++) {
    const key = target[i] ?? '';
    const starts = positions.get(key);
    if (!starts) continue;
    // Inside a run we already reported, a line with a single occurrence can
    // only continue that run; skip it to stay linear on big writes.
    if (i < coveredUntil && starts.length === 1) continue;
    let best = 0;
    for (const p of starts) {
      let k = 0;
      while (i + k < target.length && p + k < source.length && target[i + k] === source[p + k]) k++;
      if (k > best) best = k;
    }
    if (best > 0) {
      onRun(i, best);
      if (i + best > coveredUntil) coveredUntil = i + best;
    }
  }
}

/** Blank / punctuation-only lines take the owner of the previous (else next) non-trivial line. */
function inheritTrivial(lines: string[], owners: Array<Owner | null>): void {
  const trivial = lines.map((l) => TRIVIAL_LINE.test(l));
  // nextOwner[i]: owner of the first owned non-trivial line after i (one backward pass
  // instead of a forward scan per trivial line, which was quadratic on big unowned files).
  const nextOwner: Array<Owner | null> = new Array<Owner | null>(lines.length).fill(null);
  for (let j = lines.length - 2; j >= 0; j--) {
    const o = trivial[j + 1] ? null : (owners[j + 1] ?? null);
    nextOwner[j] = o ?? nextOwner[j + 1] ?? null;
  }
  for (let i = 0; i < lines.length; i++) {
    if (owners[i] !== null || !trivial[i]) continue;
    const prev = (i > 0 ? owners[i - 1] : null) ?? null;
    const source = prev ?? nextOwner[i] ?? null;
    if (source) owners[i] = { ...source, run: 1 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prompt id behind a line owner (null for unexplained lines). */
function promptOf(owner: Owner | null | undefined): string | null {
  return owner?.edit.edit.promptId ?? null;
}

function uniqueEdits(edits: IndexedEdit[]): IndexedEdit[] {
  return [...new Set(edits)].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
}

/** `editIds` + lightweight `edits` for a hunk, oldest first. */
function refs(edits: IndexedEdit[]): Pick<AttributedHunk, 'editIds' | 'edits'> {
  return { editIds: edits.map((e) => e.edit.id), edits: edits.map((e) => toEditRef(e.edit)) };
}

/** Drop the text bodies of an edit (old/new text and the shell command); they live in `Report.edits`. */
export function toEditRef(edit: FileEdit): EditRef {
  const { oldText: _old, newText: _new, command: _cmd, ...ref } = edit;
  return ref;
}

function isLater(a: IndexedEdit, b: IndexedEdit): boolean {
  return a.atMs > b.atMs || (a.atMs === b.atMs && a.seq > b.seq);
}

/** Labels for an explained (exact / partial / file-only) hunk; `none` is handled by `unattributedLabel`. */
function labelsFor(match: Exclude<MatchStrength, 'none'>, edits: IndexedEdit[]): Label[] {
  const allBash = edits.length > 0 && edits.every((e) => e.edit.kind === 'bash');
  const anyBash = edits.some((e) => e.edit.kind === 'bash');
  if (match === 'file-only') {
    if (anyBash) {
      const cmd = [...edits].reverse().find((e) => e.edit.kind === 'bash')?.edit.command ?? '';
      return [{ kind: 'bash-edit', severity: 'warn', detail: `File touched by a shell command (${shorten(cmd, 80)}); hunk text not recoverable from the transcript.` }];
    }
    return [{ kind: 'unattributed', severity: 'info', detail: 'Agent edited this file, but none of its edits contain this text.' }];
  }
  if (allBash) {
    return [{ kind: 'bash-edit', severity: 'info', detail: 'Explained by content a shell command wrote (heredoc/echo).' }];
  }
  return [];
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normExact(line: string): string {
  return line.replace(/\s+$/, '');
}

function normFuzzy(line: string): string {
  return line.replace(/\s+/g, '').replace(/[;,]+$/, '');
}

function shorten(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
