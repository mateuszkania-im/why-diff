/**
 * Tiny on-disk verdict cache in `<repo>/.why-diff/cache.json`, so re-running
 * why-diff on the same diff does not bill the model again. Keys are
 * sha256(classifier + linked prompt + rationale + rendered hunk).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AttributedHunk, IntentVerdict } from '../types.js';
import { VERDICTS, isRecord, renderHunkDiff } from './prompt.js';

const CACHE_VERSION = 1;
/** Oldest entries are dropped beyond this many. */
const MAX_ENTRIES = 5000;

interface CacheEntry extends IntentVerdict {
  /** ISO time the verdict was stored */
  at: string;
}

export function cachePath(repoRoot: string): string {
  return join(repoRoot, '.why-diff', 'cache.json');
}

/** Stable cache key for one hunk as seen by one classifier. */
export function cacheKey(classifierName: string, h: AttributedHunk): string {
  const rationale = h.edits.map((e) => e.rationale ?? '').join('\n');
  return createHash('sha256')
    .update(JSON.stringify([classifierName, h.prompt?.text ?? '', rationale, h.hunk.file, renderHunkDiff(h.hunk)]))
    .digest('hex');
}

export class VerdictCache {
  private dirty = false;

  private constructor(
    private readonly path: string,
    private readonly entries: Map<string, CacheEntry>,
  ) {}

  /** Load the cache; a missing or corrupt file yields an empty cache. */
  static async load(path: string): Promise<VerdictCache> {
    const entries = new Map<string, CacheEntry>();
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (isRecord(raw) && raw.version === CACHE_VERSION && isRecord(raw.entries)) {
        for (const [k, v] of Object.entries(raw.entries)) if (isEntry(v)) entries.set(k, v);
      }
    } catch {
      // no cache yet
    }
    return new VerdictCache(path, entries);
  }

  get(key: string): IntentVerdict | undefined {
    const e = this.entries.get(key);
    return e && { verdict: e.verdict, reason: e.reason, model: e.model };
  }

  set(key: string, v: IntentVerdict): void {
    this.entries.delete(key); // re-insert so insertion order tracks recency
    this.entries.set(key, { ...v, at: new Date().toISOString() });
    this.dirty = true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Persist atomically (write temp file, then rename). No-op when unchanged. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const all = [...this.entries];
    const kept = all.slice(Math.max(0, all.length - MAX_ENTRIES));
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(kept) }) + '\n');
    await rename(tmp, this.path);
    this.dirty = false;
  }
}

function isEntry(v: unknown): v is CacheEntry {
  return (
    isRecord(v) &&
    typeof v.verdict === 'string' &&
    (VERDICTS as readonly string[]).includes(v.verdict) &&
    typeof v.reason === 'string' &&
    typeof v.model === 'string' &&
    typeof v.at === 'string'
  );
}
