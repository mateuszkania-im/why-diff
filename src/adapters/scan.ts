/**
 * Cheap byte-level prefilters shared by the adapters' discovery code.
 */
import { createReadStream } from 'node:fs';

/** Byte scan: does the file contain any of `needles` (no JSON parsing, 1 MiB chunks)? */
export async function fileMentions(file: string, needles: string[]): Promise<boolean> {
  const bufs = needles.map((n) => Buffer.from(n, 'utf8')).filter((b) => b.length > 0);
  if (bufs.length === 0) return false;
  const keep = Math.max(...bufs.map((b) => b.length)) - 1;
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  let tail: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const hay = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (bufs.some((b) => hay.includes(b))) return true;
      tail = hay.subarray(Math.max(0, hay.length - keep));
    }
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
  return false;
}

/**
 * Needles that mean "this transcript edited a file under `root`" for a JSON
 * transcript: the `file_path` argument of Claude Code's Edit/Write/MultiEdit
 * calls, written as compact JSON (`"file_path":"/abs/root/...`). Backslashes
 * in Windows roots are escaped the way JSON.stringify writes them.
 */
export function filePathNeedles(roots: string[], sep: string): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    // A Windows root may be written `C:\\x` or `C:/x`, with either drive-letter case.
    const forms = DRIVE_PATH.test(root)
      ? [root.replace(/\//g, '\\'), root.replace(/\\/g, '/')].flatMap((r) => [r.charAt(0).toUpperCase() + r.slice(1), r.charAt(0).toLowerCase() + r.slice(1)])
      : [root];
    for (const r of forms) {
      const s = DRIVE_PATH.test(r) ? (r.includes('\\') ? '\\' : '/') : sep;
      out.add(`"file_path":${JSON.stringify(r.endsWith(s) ? r : r + s).slice(0, -1)}`);
    }
  }
  return [...out];
}

/** A Windows drive path (`C:\\x`, `c:/x`). */
export const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** Drive path in a comparable form: forward slashes, no trailing slash, lower case (Windows paths are case-insensitive). */
export function driveKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Is `p` the directory `root` or inside it? Drive paths compare case-insensitively and accept
 * both slash styles; POSIX paths compare exactly.
 */
export function pathWithin(root: string, p: string): boolean {
  if (DRIVE_PATH.test(root) || DRIVE_PATH.test(p)) {
    const r = driveKey(root);
    const c = driveKey(p);
    return c === r || c.startsWith(`${r}/`);
  }
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root;
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}
