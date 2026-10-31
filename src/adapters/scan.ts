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
  return roots.map((root) => `"file_path":${JSON.stringify(root.endsWith(sep) ? root : root + sep).slice(0, -1)}`);
}
