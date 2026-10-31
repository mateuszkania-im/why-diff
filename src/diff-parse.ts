/**
 * Parser for unified `git diff` output (as produced with `--no-color -M --unified=N`).
 *
 * Produces a flat list of {@link Hunk}s with stable ids (`h1`, `h2`, ...) in the
 * order they appear. File-level metadata (status, rename, mode change) is folded
 * into every hunk of that file so downstream modules never need the raw diff.
 *
 * Handled: added / deleted / renamed / copied files, binary files (skipped),
 * `\ No newline at end of file` markers, C-quoted paths (`"a/caf\303\251.ts"`),
 * paths with spaces, `--no-prefix` diffs, mode-only changes (emitted as an empty
 * hunk so the change is still visible), and hunk headers without line counts
 * (`@@ -5 +5,2 @@`, as `--unified=0` produces). Hunk bodies are delimited by the
 * line counts in the header, so content that looks like a header (a removed
 * line `-- foo` rendering as `--- foo`) is parsed correctly.
 */

import type { Hunk } from './types.js';

/** Per-file state while walking the diff. */
interface FileHeader {
  oldPath: string | null;
  newPath: string | null;
  status: Hunk['status'];
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  /** True once at least one hunk was emitted for this file. */
  emittedHunk: boolean;
}

/** Hunk under construction plus the number of body lines still expected. */
interface OpenHunk {
  hunk: Hunk;
  remainingOld: number;
  remainingNew: number;
  oldNo: number;
  newNo: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT = /^diff --git (.+)$/;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const COPY_FROM = /^copy from (.+)$/;
const COPY_TO = /^copy to (.+)$/;
const OLD_MODE = /^old mode (\d+)$/;
const NEW_MODE = /^new mode (\d+)$/;
const NEW_FILE = /^new file mode (\d+)$/;
const DELETED_FILE = /^deleted file mode (\d+)$/;
const BINARY = /^Binary files .* differ$/;
const GIT_BINARY_PATCH = /^GIT binary patch$/;

/**
 * Parse unified git diff text into hunks.
 *
 * @param diff Raw output of `git diff` (any `--unified` value, `--no-color`).
 * @returns Hunks in diff order, ids `h1..hN`.
 */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = diff.split('\n');
  // A trailing newline yields one empty final element; drop it so it is not
  // mistaken for an empty context line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let file: FileHeader | null = null;
  let open: OpenHunk | null = null;

  const newFile = (oldPath: string | null, newPath: string | null): FileHeader => ({
    oldPath,
    newPath,
    status: 'modified',
    binary: false,
    emittedHunk: false,
  });

  const finishFile = (): void => {
    if (file && !file.binary && !file.emittedHunk && isModeOnlyChange(file)) {
      hunks.push(modeChangeHunk(file, hunks.length + 1));
    } else if (file && !file.binary && !file.emittedHunk && isContentlessMove(file)) {
      hunks.push(contentlessHunk(file, hunks.length + 1));
    }
    file = null;
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // 1. Hunk body: consume exactly as many lines as the header announced.
    if (open && (open.remainingOld > 0 || open.remainingNew > 0)) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (consumeBodyLine(open, line)) continue;
      // Malformed counts: the hunk ended early. Fall through to header parsing.
      open = null;
    }
    if (line.startsWith('\\')) continue; // marker after the final body line

    // 2. New file section.
    const gitMatch = DIFF_GIT.exec(line);
    if (gitMatch) {
      finishFile();
      const [oldPath, newPath] = splitDiffGitPaths(gitMatch[1] ?? '');
      file = newFile(oldPath, newPath);
      continue;
    }

    if (!file) {
      // Diff without `diff --git` headers (plain `diff -u`): accept a `---`/`+++` pair.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        file = newFile(null, null);
      } else {
        continue; // preamble such as `git log -p` metadata
      }
    }

    // 3. Hunk header.
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      if (file.binary) continue;
      const oldStart = Number(hunkMatch[1]);
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      const path = displayPath(file);
      const hunk: Hunk = {
        id: `h${hunks.length + 1}`,
        file: path,
        ...(file.oldPath && file.oldPath !== path ? { oldFile: file.oldPath } : {}),
        status: file.status,
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line,
        lines: [],
      };
      open = {
        hunk,
        remainingOld: oldLines,
        remainingNew: newLines,
        // A zero-length side is reported as "start,0" where start is the line
        // *before* the change; numbering of real lines still begins at start.
        oldNo: oldStart,
        newNo: newStart,
      };
      hunks.push(hunk);
      file.emittedHunk = true;
      continue;
    }

    // 4. Extended headers.
    let m: RegExpExecArray | null;
    if ((m = OLD_MODE.exec(line))) {
      file.oldMode = m[1];
    } else if ((m = NEW_MODE.exec(line))) {
      file.newMode = m[1];
    } else if ((m = NEW_FILE.exec(line))) {
      file.status = 'added';
      file.newMode = m[1];
    } else if ((m = DELETED_FILE.exec(line))) {
      file.status = 'deleted';
      file.oldMode = m[1];
    } else if ((m = RENAME_FROM.exec(line)) || (m = COPY_FROM.exec(line))) {
      file.status = 'renamed';
      file.oldPath = unquotePath(m[1] ?? '');
    } else if ((m = RENAME_TO.exec(line)) || (m = COPY_TO.exec(line))) {
      file.status = 'renamed';
      file.newPath = unquotePath(m[1] ?? '');
    } else if (BINARY.test(line) || GIT_BINARY_PATCH.test(line)) {
      file.binary = true;
    } else if (line.startsWith('--- ')) {
      const p = stripPrefix(unquotePath(line.slice(4)), 'a/');
      if (p === '/dev/null') {
        if (file.status !== 'renamed') file.status = 'added';
      } else if (file.status !== 'renamed') {
        file.oldPath = p;
      }
    } else if (line.startsWith('+++ ')) {
      const p = stripPrefix(unquotePath(line.slice(4)), 'b/');
      if (p === '/dev/null') {
        file.status = 'deleted';
      } else if (file.status !== 'renamed') {
        file.newPath = p;
      }
    }
    // `index`, `similarity index`, `dissimilarity index`: nothing to record.
  }
  finishFile();
  return hunks;
}

/**
 * Append one body line to the open hunk. Returns false when the line cannot
 * be a body line (unknown marker), which signals a malformed hunk.
 */
function consumeBodyLine(open: OpenHunk, line: string): boolean {
  const marker = line[0];
  const text = line.slice(1);
  if (marker === '+' && open.remainingNew > 0) {
    open.hunk.lines.push({ type: 'add', text, newNo: open.newNo++ });
    open.remainingNew--;
    return true;
  }
  if (marker === '-' && open.remainingOld > 0) {
    open.hunk.lines.push({ type: 'del', text, oldNo: open.oldNo++ });
    open.remainingOld--;
    return true;
  }
  if ((marker === ' ' || line === '') && open.remainingOld > 0 && open.remainingNew > 0) {
    // Some tools strip the single space of an empty context line.
    open.hunk.lines.push({
      type: 'ctx',
      text: line === '' ? '' : text,
      oldNo: open.oldNo++,
      newNo: open.newNo++,
    });
    open.remainingOld--;
    open.remainingNew--;
    return true;
  }
  return false;
}

/** True when the diff header changed only the file mode (chmod) and carried no content. */
function isModeOnlyChange(file: FileHeader): boolean {
  return file.oldMode !== undefined && file.newMode !== undefined && file.status === 'modified';
}

/**
 * A pure rename (similarity 100%) or the deletion of an empty file carries no
 * `@@` hunk, yet a reviewer must see it (moving a test aside disables it).
 */
function isContentlessMove(file: FileHeader): boolean {
  return file.status === 'renamed' || file.status === 'deleted';
}

function contentlessHunk(file: FileHeader, n: number): Hunk {
  const path = displayPath(file);
  return {
    id: `h${n}`,
    file: path,
    ...(file.oldPath && file.oldPath !== path ? { oldFile: file.oldPath } : {}),
    status: file.status,
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    header: file.status === 'deleted' ? `deleted file ${path}` : `rename ${file.oldPath ?? '?'} => ${path}`,
    lines: [],
  };
}

function modeChangeHunk(file: FileHeader, n: number): Hunk {
  return {
    id: `h${n}`,
    file: displayPath(file),
    status: 'modified',
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    header: `mode change ${file.oldMode ?? '?'} => ${file.newMode ?? '?'}`,
    lines: [],
  };
}

/** Repo-relative path a hunk is reported under: new path, old path for deletions. */
function displayPath(file: FileHeader): string {
  if (file.status === 'deleted') return file.oldPath ?? file.newPath ?? '';
  return file.newPath ?? file.oldPath ?? '';
}

/**
 * Split the `a/x b/y` part of a `diff --git` header into [old, new].
 * Paths may be quoted, and unquoted paths may contain spaces, so when the
 * halves are not quoted we look for the split point where the left half
 * (minus `a/`) equals the right half (minus `b/`), which holds for every
 * non-rename; renames are corrected afterwards by `rename from/to`.
 */
export function splitDiffGitPaths(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest, 0);
    const oldQuoted = rest.slice(0, end + 1);
    const newRaw = rest.slice(end + 1).trim();
    return [stripPrefix(unquotePath(oldQuoted), 'a/'), stripPrefix(unquotePath(newRaw), 'b/')];
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    if (start > 0) {
      return [stripPrefix(rest.slice(0, start), 'a/'), stripPrefix(unquotePath(rest.slice(start + 1)), 'b/')];
    }
  }
  const candidates: Array<[string, string]> = [];
  for (let i = rest.indexOf(' '); i !== -1; i = rest.indexOf(' ', i + 1)) {
    candidates.push([rest.slice(0, i), rest.slice(i + 1)]);
  }
  for (const [left, right] of candidates) {
    if (stripPrefix(left, 'a/') === stripPrefix(right, 'b/')) {
      return [stripPrefix(left, 'a/'), stripPrefix(right, 'b/')];
    }
  }
  const prefixed = candidates.find(([l, r]) => l.startsWith('a/') && r.startsWith('b/'));
  if (prefixed) return [stripPrefix(prefixed[0], 'a/'), stripPrefix(prefixed[1], 'b/')];
  const first = candidates[0];
  return first ? [first[0], first[1]] : [rest, rest];
}

function findClosingQuote(s: string, openIndex: number): number {
  for (let i = openIndex + 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Decode a git C-style quoted path (`"caf\303\251 \"x\".ts"`). Unquoted
 * input is returned unchanged, except for the trailing tab git appends in
 * `---`/`+++` lines when the path contains spaces.
 */
export function unquotePath(raw: string): string {
  let s = raw;
  if (s.endsWith('\t')) s = s.slice(0, -1);
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  const simpleEscapes: Record<string, number> = {
    n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34,
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? '';
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = inner[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    bytes.push(simpleEscapes[next] ?? next.charCodeAt(0));
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Count added/removed lines in a hunk. */
export function countLines(hunk: Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of hunk.lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Group hunks by file, preserving first-appearance order. */
export function groupByFile(hunks: Hunk[]): Map<string, Hunk[]> {
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const list = byFile.get(h.file);
    if (list) list.push(h);
    else byFile.set(h.file, [h]);
  }
  return byFile;
}
