/**
 * Team rules: `.why-diff.json` at the repo root (or a `"whyDiff"` key in package.json).
 *
 *   { "protected": ["migrations/**", ".github/**"], "ignore": ["generated/**"], "blockOn": ["protected-path", "ci-changed"] }
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { LabelKind } from './types.js';

export interface WhyDiffConfig {
  /** Globs of paths an agent edit must flag as `protected-path` */
  protected?: string[];
  /** Label kinds that make the guard block (replaces the built-in list) */
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

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${file}: cannot read (${(err as Error).message})`);
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

function validate(file: string, raw: unknown): WhyDiffConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
  const r = raw as Record<string, unknown>;
  const out: WhyDiffConfig = {};
  if (r.protected !== undefined) out.protected = stringList(file, 'protected', r.protected);
  if (r.ignore !== undefined) out.ignore = stringList(file, 'ignore', r.ignore);
  if (r.blockOn !== undefined) {
    const kinds = stringList(file, 'blockOn', r.blockOn);
    const bad = kinds.find((k) => !(LABEL_KINDS as readonly string[]).includes(k));
    if (bad !== undefined) throw new Error(`${file}: unknown label kind "${bad}" in "blockOn" (known: ${LABEL_KINDS.join(', ')})`);
    out.blockOn = kinds as LabelKind[];
  }
  return out;
}

/** Read the team config from the repo root. Throws an Error naming the file when it is unreadable or invalid. */
export async function loadConfig(repoRoot: string): Promise<WhyDiffConfig> {
  const file = path.join(repoRoot, CONFIG_FILE);
  const text = await readOptional(file);
  if (text !== undefined) return validate(CONFIG_FILE, parseJson(CONFIG_FILE, text));

  const pkgText = await readOptional(path.join(repoRoot, 'package.json'));
  if (pkgText === undefined) return {};
  let pkg: unknown;
  try { pkg = JSON.parse(pkgText); } catch { return {}; } // a broken package.json is not ours to report
  const section = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>).whyDiff : undefined;
  return section === undefined ? {} : validate('package.json "whyDiff"', section);
}

/**
 * Small glob matcher: `**` crosses directories, `*` and `?` stay inside a path
 * segment. Anchored to the repo root; a pattern without `/` matches the
 * basename anywhere (gitignore-like). A trailing `/` means "everything below".
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  const anywhere = !g.includes('/');
  if (g.startsWith('./')) g = g.slice(2);
  if (g.startsWith('/')) g = g.slice(1);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
}

/** The first glob that matches `file` (repo-relative, any separator), or undefined. */
export function matchGlobs(globs: readonly string[] | undefined, file: string): string | undefined {
  if (!globs?.length) return undefined;
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.find((g) => g.trim() && globToRegExp(g).test(p));
}
