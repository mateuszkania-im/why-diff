/**
 * Shared parsing helpers for the Codex and OpenCode adapters.
 *
 * - {@link parseApplyPatch}: the Codex "apply_patch" envelope format
 *   (`*** Begin Patch` ... `*** End Patch`), also used by OpenCode's
 *   `patch` / `apply_patch` tools.
 * - {@link parseUnifiedHunks}: plain unified-diff hunks (`@@ -a,b +c,d @@`),
 *   as recorded by Codex `FileChange` events.
 * - {@link shellWriteTargets}: best-effort detection of shell commands that
 *   mutate files (sed -i, redirects, tee, mv/cp/rm, package managers, ...).
 * - Small JSON narrowing helpers so adapters can walk untyped transcript
 *   records without `any`.
 */

import os from 'node:os';
import path from 'node:path';
import type { EditKind } from '../types.js';

/* ------------------------------------------------------------------------ */
/* JSON narrowing helpers                                                   */
/* ------------------------------------------------------------------------ */

/** A parsed JSON object. */
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `obj[key]` when it is a string, else undefined. */
export function str(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** `obj[key]` when it is a finite number, else undefined. */
export function num(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `obj[key]` when it is an object, else undefined. */
export function rec(obj: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return isRecord(v) ? v : undefined;
}

/** `obj[key]` when it is an array, else an empty array. */
export function arr(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) return [];
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** Truncate to `max` characters (adds an ellipsis when cut). */
export function clip(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------------ */
/* Edit bodies                                                              */
/* ------------------------------------------------------------------------ */

/** The harness-independent payload of one FileEdit (ids/timestamps are added by the adapter). */
export interface EditBody {
  kind: EditKind;
  /** Absolute path */
  filePath: string;
  oldText: string | null;
  newText: string | null;
}

/** One `@@` chunk of a patch, reduced to before/after snippets. */
export interface PatchHunk {
  /** Context + removed lines, joined with '\n' */
  oldText: string;
  /** Context + added lines, joined with '\n' */
  newText: string;
}

/** One file operation inside an apply_patch envelope. */
export type PatchFileOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; hunks: PatchHunk[] };

/** Resolve a possibly relative path against `base` (returns absolute, normalised). */
export function resolvePath(base: string, p: string): string {
  // Windows has no HOME unless Git Bash set one: fall back to the user profile.
  const home = process.env.HOME || os.homedir();
  const expanded = p.startsWith('~/') && home ? path.join(home, p.slice(2)) : p;
  return path.resolve(base, expanded);
}

/**
 * Convert parsed patch operations into edit bodies:
 * - Add File  -> `write` with the whole content,
 * - Update    -> one `patch` per hunk (filePath = move target when renamed),
 * - Delete    -> `write` with newText `''` (the file no longer has content).
 */
export function patchOpsToEdits(ops: PatchFileOp[], baseDir: string): EditBody[] {
  const out: EditBody[] = [];
  for (const op of ops) {
    if (op.kind === 'add') {
      out.push({ kind: 'write', filePath: resolvePath(baseDir, op.path), oldText: null, newText: op.content });
    } else if (op.kind === 'delete') {
      out.push({ kind: 'write', filePath: resolvePath(baseDir, op.path), oldText: null, newText: '' });
    } else {
      const filePath = resolvePath(baseDir, op.movePath ?? op.path);
      if (op.hunks.length === 0) {
        // Pure rename: still a mutation of the destination path.
        out.push({ kind: 'patch', filePath, oldText: '', newText: '' });
      }
      for (const h of op.hunks) {
        out.push({ kind: 'patch', filePath, oldText: h.oldText, newText: h.newText });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* apply_patch envelope                                                     */
/* ------------------------------------------------------------------------ */

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';

/**
 * Pull the `*** Begin Patch ... *** End Patch` envelope out of arbitrary text
 * (e.g. a shell heredoc `apply_patch <<'EOF' ... EOF`). Returns null if absent.
 */
export function extractPatchEnvelope(text: string): string | null {
  const start = text.indexOf(BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(END, start);
  return end < 0 ? text.slice(start) : text.slice(start, end + END.length);
}

/**
 * Parse a Codex apply_patch envelope. Lenient like Codex itself: a missing
 * `*** End Patch`, blank lines inside hunks (treated as empty context) and
 * `*** End of File` markers are accepted. Unknown lines are ignored.
 */
export function parseApplyPatch(text: string): PatchFileOp[] {
  const envelope = extractPatchEnvelope(text) ?? text;
  const lines = envelope.replace(/\r\n/g, '\n').split('\n');
  const ops: PatchFileOp[] = [];

  type Update = Extract<PatchFileOp, { kind: 'update' }>;
  let current: PatchFileOp | null = null;
  let addLines: string[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let hunkHasChange = false;

  const flushHunk = (): void => {
    if (current?.kind === 'update' && (oldLines.length > 0 || newLines.length > 0) && hunkHasChange) {
      (current as Update).hunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    }
    oldLines = [];
    newLines = [];
    hunkHasChange = false;
  };
  const flushFile = (): void => {
    if (!current) return;
    if (current.kind === 'add') {
      current.content = addLines.length > 0 ? `${addLines.join('\n')}\n` : '';
    } else {
      flushHunk();
    }
    ops.push(current);
    current = null;
    addLines = [];
  };

  for (const line of lines) {
    if (line.startsWith(BEGIN)) continue;
    if (line.startsWith(END)) {
      flushFile();
      break;
    }
    if (line.startsWith(ADD)) {
      flushFile();
      current = { kind: 'add', path: line.slice(ADD.length).trim(), content: '' };
      continue;
    }
    if (line.startsWith(DELETE)) {
      flushFile();
      ops.push({ kind: 'delete', path: line.slice(DELETE.length).trim() });
      continue;
    }
    if (line.startsWith(UPDATE)) {
      flushFile();
      current = { kind: 'update', path: line.slice(UPDATE.length).trim(), hunks: [] };
      continue;
    }
    if (!current) continue;

    if (current.kind === 'add') {
      if (line.startsWith('+')) addLines.push(line.slice(1));
      continue;
    }
    if (current.kind !== 'update') continue;
    if (line.startsWith(MOVE)) {
      current.movePath = line.slice(MOVE.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      continue;
    }
    if (line.startsWith(EOF_MARK)) continue;
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      hunkHasChange = true;
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      hunkHasChange = true;
    } else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line === '') {
      oldLines.push('');
      newLines.push('');
    }
  }
  flushFile();
  return ops.map(trimTrailingBlankContext);
}

/** Drop trailing empty context lines (artefacts of blank lines before `*** End Patch`). */
function trimTrailingBlankContext(op: PatchFileOp): PatchFileOp {
  if (op.kind !== 'update') return op;
  return {
    ...op,
    hunks: op.hunks.map((h) => {
      const o = h.oldText.split('\n');
      const n = h.newText.split('\n');
      while (o.length > 1 && n.length > 1 && o[o.length - 1] === '' && n[n.length - 1] === '') {
        o.pop();
        n.pop();
      }
      return { oldText: o.join('\n'), newText: n.join('\n') };
    }),
  };
}

/* ------------------------------------------------------------------------ */
/* Unified diff hunks                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Parse the hunks of a single-file unified diff (file headers optional).
 * `\ No newline at end of file` markers are ignored.
 */
export function parseUnifiedHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let oldLines: string[] | null = null;
  let newLines: string[] = [];
  const flush = (): void => {
    if (oldLines) hunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    oldLines = null;
    newLines = [];
  };
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      oldLines = [];
      continue;
    }
    if (!oldLines) continue; // file headers (---/+++/diff --git) before the first hunk
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  flush();
  return hunks;
}

/* ------------------------------------------------------------------------ */
/* Shell commands                                                           */
/* ------------------------------------------------------------------------ */

/** Result of {@link shellWriteTargets}. */
export interface ShellWrites {
  /** True when the command (probably) changes files on disk. */
  mutating: boolean;
  /** Paths the command writes to, as written in the command (may be relative). */
  targets: string[];
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_MUTATING = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade']);
const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** Remove heredoc bodies so their content is not mistaken for commands. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (m?.[2]) terminator = m[2];
  }
  return out.join('\n');
}

/** Prefix marking redirection operators, so a quoted '>' stays an ordinary word. */
const OP = '\u0000';

/**
 * Minimal shell tokenizer: splits into segments on ; && || | and newlines,
 * handles quotes and emits redirection operators as `OP`-prefixed tokens.
 */
function tokenizeSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let hasCur = false;
  let i = 0;
  const pushTok = (): void => {
    if (hasCur) tokens.push(cur);
    cur = '';
    hasCur = false;
  };
  const pushSeg = (): void => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  while (i < command.length) {
    const c = command[i] ?? '';
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end < 0 ? undefined : end);
      hasCur = true;
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        cur += command[j];
        j++;
      }
      hasCur = true;
      i = j + 1;
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[i + 1];
      hasCur = true;
      i += 2;
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      pushSeg();
      i += c === '&' || (c === '|' && command[i + 1] === '|') ? 2 : 1;
    } else if (c === ' ' || c === '\t') {
      pushTok();
      i++;
    } else if (c === '>' || (c === '<' && command[i + 1] !== '<') || (/[\d&]/.test(c) && command[i + 1] === '>' && !hasCur)) {
      // Emit redirection operators as standalone tokens: `>`, `>>`, `>|`, `2>`, `&>`, `<`.
      pushTok();
      let op = c;
      let j = i + 1;
      if (c !== '>' && c !== '<') op += command[j++] ?? ''; // fd prefix: `2>` / `&>`
      if (command[j] === '>' || command[j] === '|') op += command[j++] ?? '';
      tokens.push(OP + op);
      i = j;
    } else {
      cur += c;
      hasCur = true;
      i++;
    }
  }
  pushSeg();
  return segments;
}

const nonOptions = (args: string[]): string[] => args.filter((a) => !a.startsWith('-'));

/**
 * Best-effort guess at which files a shell command writes. Conservative by
 * design: reading commands (cat, grep, git diff, ...) are not mutating.
 * Command substitution, variables and globs are returned verbatim.
 */
export function shellWriteTargets(command: string): ShellWrites {
  const targets: string[] = [];
  let mutating = false;
  /** Directory set by a preceding `cd` in the same command line (may be relative). */
  let cdDir: string | null = null;
  const add = (...ps: string[]): void => {
    for (const raw of ps) {
      if (!raw) continue;
      const p = cdDir !== null && !path.isAbsolute(raw) && !raw.startsWith('~') ? path.posix.join(cdDir, raw) : raw; // shell paths: `/`, on every OS
      if (!targets.includes(p)) targets.push(p);
    }
  };

  for (const seg of tokenizeSegments(stripHeredocs(command))) {
    if (seg[0] === 'cd' || seg[0] === 'pushd') {
      const dir = seg[1];
      if (dir && dir !== '-') cdDir = cdDir !== null && !path.isAbsolute(dir) && !dir.startsWith('~') ? path.posix.join(cdDir, dir) : dir;
      continue;
    }
    // Redirections: `> f`, `>> f`, `1> f`, `&> f` (not `2>`, not `>&2`).
    const words: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i] ?? '';
      if (!t.startsWith(OP)) {
        words.push(t);
      } else if (/^(1|&)?>>?\|?$/.test(t.slice(1))) {
        const target = seg[i + 1];
        i++;
        if (target && !target.startsWith('&') && !NULL_SINKS.has(target)) {
          mutating = true;
          add(target);
        }
      } else {
        i++; // stderr or input redirect: skip its operand
      }
    }

    // Skip env assignments and wrappers (`FOO=1 sudo cmd`).
    while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0] ?? '') || ['sudo', 'env', 'command', 'xargs'].includes(words[0] ?? ''))) {
      words.shift();
    }
    const [cmd = '', ...args] = words;
    const base = path.basename(cmd);
    const files = nonOptions(args);

    switch (base) {
      case 'sed': {
        if (!args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place='))) break;
        mutating = true;
        // Positional operands, minus the operands of -e/-f and BSD's empty backup suffix (`sed -i '' ...`).
        const positional: string[] = [];
        let hasScriptFlag = false;
        for (let k = 0; k < args.length; k++) {
          const a = args[k] ?? '';
          if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
            hasScriptFlag = true;
            k++;
          } else if (!a.startsWith('-') && a !== '') {
            positional.push(a);
          }
        }
        add(...(hasScriptFlag ? positional : positional.slice(1)));
        break;
      }
      case 'perl':
        if (args.some((a) => /^-\w*i/.test(a))) {
          mutating = true;
          add(...files.slice(1));
        }
        break;
      case 'tee':
        mutating = true;
        add(...files);
        break;
      case 'mv':
        mutating = true;
        add(...files);
        break;
      case 'cp':
      case 'install':
        if (base === 'install' && !files.length) break;
        mutating = true;
        if (files.length) add(files[files.length - 1] ?? '');
        break;
      case 'rm':
      case 'unlink':
      case 'touch':
      case 'truncate':
        mutating = true;
        add(...files);
        break;
      case 'git': {
        const [sub, ...rest] = args;
        if (sub === 'mv' || sub === 'rm' || sub === 'restore') {
          mutating = true;
          add(...nonOptions(rest));
        } else if (sub === 'checkout' && rest.includes('--')) {
          mutating = true;
          add(...rest.slice(rest.indexOf('--') + 1));
        } else if (sub === 'apply' || sub === 'am' || sub === 'stash' || sub === 'reset' || sub === 'revert' || sub === 'cherry-pick' || sub === 'merge' || sub === 'pull') {
          mutating = true;
        }
        break;
      }
      case 'patch':
        mutating = true;
        break;
      case 'prettier':
        if (args.includes('--write') || args.includes('-w')) {
          mutating = true;
          add(...files);
        }
        break;
      case 'eslint':
      case 'biome':
        if (args.includes('--fix') || args.includes('--write') || args.includes('--apply')) {
          mutating = true;
          add(...files.filter((f) => !['format', 'check', 'lint'].includes(f)));
        }
        break;
      case 'npx':
      case 'pnpx':
      case 'bunx': {
        const inner = shellWriteTargets(args.join(' '));
        if (inner.mutating) {
          mutating = true;
          add(...inner.targets);
        }
        break;
      }
      default:
        if (PACKAGE_MANAGERS.has(base) && PM_MUTATING.has(args[0] ?? '')) {
          mutating = true;
          add('package.json');
        }
    }
  }
  return { mutating, targets };
}

/* ------------------------------------------------------------------------ */
/* JavaScript string literals (Codex "code mode" exec cells)                */
/* ------------------------------------------------------------------------ */

/**
 * Read a JS string literal (', " or `) starting at `src[start]`.
 * Returns null when it is not a literal or a template contains `${...}`.
 */
export function readJsString(src: string, start: number): { value: string; end: number } | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === quote) return { value: out, end: i + 1 };
    if (quote === '`' && c === '$' && src[i + 1] === '{') return null;
    if (c === '\\') {
      const n = src[i + 1] ?? '';
      i += 2;
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case '\n': break; // line continuation
        case 'x': {
          out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
          i += 2;
          break;
        }
        case 'u': {
          if (src[i] === '{') {
            const close = src.indexOf('}', i);
            out += String.fromCodePoint(parseInt(src.slice(i + 1, close), 16));
            i = close + 1;
          } else {
            out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
            i += 4;
          }
          break;
        }
        default: out += n;
      }
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

/** One `tools.<name>(...)` call found in a JS snippet. */
export interface JsToolCall {
  /** Offset of the call in the source (for ordering calls of different tools) */
  index: number;
  /** Raw source of the argument list */
  args: string;
}

/**
 * Find every `tools.<name>(...)` call in a JS snippet and return the raw
 * argument source of each, in order. String/template literals are skipped
 * while balancing parentheses.
 */
export function findJsToolCalls(src: string, name: string): JsToolCall[] {
  const out: JsToolCall[] = [];
  const re = new RegExp(`\\btools\\.${name.replace(/[.$]/g, '\\$&')}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    while (i < src.length && depth > 0) {
      const c = src[i] ?? '';
      if (c === '"' || c === "'" || c === '`') {
        const lit = skipLiteral(src, i);
        i = lit;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      i++;
    }
    out.push({ index: m.index, args: src.slice(open, Math.max(open, i - 1)) });
    re.lastIndex = i;
  }
  return out;
}

/** Index just past the literal that starts at `start` (handles escapes, nested `${}` roughly). */
function skipLiteral(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

/**
 * Read a string-valued property (`key: "..."`, `"key": '...'`) from the source
 * of a JS object literal, or the literal itself when `argSrc` is a bare string.
 */
export function jsStringArg(argSrc: string, keys: string[]): string | null {
  const trimmed = argSrc.trimStart();
  const offset = argSrc.length - trimmed.length;
  if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')) {
    return readJsString(argSrc, offset)?.value ?? null;
  }
  for (const key of keys) {
    const re = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`, 'g');
    const m = re.exec(argSrc);
    if (m) {
      const lit = readJsString(argSrc, m.index + m[0].length);
      if (lit) return lit.value;
    }
  }
  return null;
}
