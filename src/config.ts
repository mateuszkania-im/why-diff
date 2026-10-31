/**
 * Team rules: `.why-diff.json` at the repo root (or a `"whyDiff"` key in package.json).
 *
 *   { "protected": ["migrations/**", ".github/**"], "ignore": ["generated/**"], "blockOn": ["protected-path", "ci-changed"] }
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { git } from './git.js';
import type { LabelKind } from './types.js';

export interface WhyDiffConfig {
  /** Globs of paths an agent edit must flag as `protected-path` */
  protected?: string[];
  /** Label kinds that make the guard block in addition to the built-in list (it can add, never remove) */
  blockOn?: LabelKind[];
  /** Globs of paths dropped from the report entirely */
  ignore?: string[];
}

export const CONFIG_FILE = '.why-diff.json';

export const LABEL_KINDS: readonly LabelKind[] = [
  'test-modified', 'test-skip-added', 'tests-disabled', 'assertion-removed', 'snapshot-updated', 'dependency-added',
  'lockfile', 'config-changed', 'ci-changed', 'lint-suppressed', 'type-any-added', 'secret-like', 'unattributed',
  'out-of-scope', 'bash-edit', 'protected-path',
];

export const MAX_GLOB_LENGTH = 512;

/** Read a file from the working tree (rev undefined) or from `rev` via git; undefined when absent. */
async function readOptional(root: string, rel: string, rev?: string): Promise<string | undefined> {
  if (rev !== undefined) {
    if (rev.startsWith('-')) return undefined;
    try {
      return await git(root, ['show', `${rev}:${rel}`], { trim: false });
    } catch {
      return undefined;
    }
  }
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${rel}: cannot read (${(err as Error).message})`);
  }
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
}

function stringList(file: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${file}: "${key}" must be an array of strings`);
  return value as string[];
}

function globList(file: string, key: string, value: unknown): string[] {
  const list = stringList(file, key, value);
  for (const g of list) {
    if (g.length > MAX_GLOB_LENGTH) throw new Error(`${file}: pattern in "${key}" is too long (${g.length} > ${MAX_GLOB_LENGTH} characters)`);
    const bad = /[{[!]/.exec(g);
    if (bad) throw new Error(`${file}: unsupported glob syntax "${bad[0]}" in "${key}" pattern "${g}" (only *, ** and ? are supported)`);
  }
  return list;
}

function validate(file: string, raw: unknown): WhyDiffConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
  const r = raw as Record<string, unknown>;
  const out: WhyDiffConfig = {};
  if (r.protected !== undefined) out.protected = globList(file, 'protected', r.protected);
  if (r.ignore !== undefined) out.ignore = globList(file, 'ignore', r.ignore);
  if (r.blockOn !== undefined) {
    const kinds = stringList(file, 'blockOn', r.blockOn);
    const bad = kinds.find((k) => !(LABEL_KINDS as readonly string[]).includes(k));
    if (bad !== undefined) throw new Error(`${file}: unknown label kind "${bad}" in "blockOn" (known: ${LABEL_KINDS.join(', ')})`);
    out.blockOn = kinds as LabelKind[];
  }
  return out;
}

/** The raw, unvalidated config section at `rev` (or the working tree) and the file it came from. */
async function readRaw(root: string, rev?: string): Promise<{ file: string; raw: unknown } | undefined> {
  const text = await readOptional(root, CONFIG_FILE, rev);
  if (text !== undefined) return { file: CONFIG_FILE, raw: parseJson(CONFIG_FILE, text) };
  const pkgText = await readOptional(root, 'package.json', rev);
  if (pkgText === undefined) return undefined;
  let pkg: unknown;
  try { pkg = JSON.parse(pkgText); } catch { return undefined; } // a broken package.json is not ours to report
  const section = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>).whyDiff : undefined;
  return section === undefined ? undefined : { file: 'package.json "whyDiff"', raw: section };
}

/**
 * Read the team config from the repo root. With `rev`, the config is read from
 * that revision (the policy a change is judged by must not be editable by the
 * change itself); it falls back to the working tree only when `rev` has no
 * config at all. Throws an Error naming the file when it is unreadable or invalid.
 */
export async function loadConfig(repoRoot: string, rev?: string): Promise<WhyDiffConfig> {
  let found = rev !== undefined ? await readRaw(repoRoot, rev) : undefined;
  if (!found) found = await readRaw(repoRoot);
  return found ? validate(found.file, found.raw) : {};
}

/** True when the team rules differ between two revisions (undefined = working tree). Never throws. */
export async function configChanged(repoRoot: string, baseRev: string | undefined, headRev: string | undefined): Promise<boolean> {
  const side = async (rev?: string): Promise<string> => {
    try { return JSON.stringify((await readRaw(repoRoot, rev))?.raw ?? null); } catch { return 'invalid'; }
  };
  return (await side(baseRev)) !== (await side(headRev));
}

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** Linear-time wildcard match of one path segment: `*` any run, `?` one character. */
function segmentMatch(pat: string, text: string): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === text[t])) { p++; t++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/** Match pattern segments (`**` = zero or more segments) against path segments, greedy two-pointer, no regex. */
function segmentsMatch(pat: string[], segs: string[]): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < segs.length) {
    if (p < pat.length && pat[p] !== '**' && segmentMatch(pat[p]!, segs[t]!)) { p++; t++; }
    else if (p < pat.length && pat[p] === '**') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '**') p++;
  return p === pat.length;
}

interface Compiled { glob: string; test: (segs: string[]) => boolean }

function compileOne(glob: string): Compiled | undefined {
  let g = glob.trim().replace(/\\/g, '/');
  if (!g) return undefined;
  if (CASE_INSENSITIVE) g = g.toLowerCase();
  if (g.length > MAX_GLOB_LENGTH) throw new Error(`glob "${glob.slice(0, 40)}..." is too long (max ${MAX_GLOB_LENGTH})`);
  if (g.startsWith('./')) g = g.slice(2);
  if (!g.replace(/\//g, '')) return undefined;
  if (!g.includes('/')) {
    // A bare name matches a file or a directory of that name anywhere.
    return { glob, test: (segs) => segs.some((s) => segmentMatch(g, s)) };
  }
  if (g.startsWith('/')) g = g.slice(1);
  if (g.endsWith('/')) g += '**';
  const pat = g.split('/').filter((x, i, a) => x !== '' || i === a.length); // drop empty segments from `//`
  return { glob, test: (segs) => segmentsMatch(pat, segs) };
}

/**
 * Compile globs once. Supported: `**` (zero or more directories), `*` and `?`
 * inside one path segment. Anchored at the repo root; a pattern without `/`
 * matches a file or directory of that name anywhere (so `migrations` covers
 * `migrations/**`). Matching is case-insensitive on macOS and Windows.
 * Returns the first matching glob for a repo-relative path, else undefined.
 */
export function compileGlobs(globs: readonly string[] | undefined): (file: string) => string | undefined {
  const compiled = (globs ?? []).map(compileOne).filter((c): c is Compiled => c !== undefined);
  if (!compiled.length) return () => undefined;
  return (file) => {
    let p = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (CASE_INSENSITIVE) p = p.toLowerCase();
    const segs = p.split('/').filter(Boolean);
    return compiled.find((c) => c.test(segs))?.glob;
  };
}

/** One-shot convenience over {@link compileGlobs}. */
export function matchGlobs(globs: readonly string[] | undefined, file: string): string | undefined {
  return compileGlobs(globs)(file);
}
