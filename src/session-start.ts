/**
 * `why-diff session-start`: a Claude Code SessionStart hook that records which commit HEAD pointed
 * at when the session started, outside the repository (the agent can rewrite `.git`, including the
 * reflogs the guard would otherwise read the base from). The guard trusts the record only when its
 * file last changed before the session's first tool call: rewriting it changes its ctime.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repoRoot } from './git.js';

/** What `session-start` writes, one file per session. */
export interface BaseRecord {
  session_id: string;
  /** Repository root (`git rev-parse --show-toplevel`, resolved with realpath) */
  root: string;
  /** HEAD's commit at session start; null on an unborn branch */
  head: string | null;
  /** When the record was written (ISO) */
  at: string;
  /** The index at session start, as a tree (`git write-tree`); absent when it could not be written */
  indexTree?: string;
}

/** `$CLAUDE_PLUGIN_DATA` (set by Claude Code for plugin hooks), else `~/.cache/why-diff`. */
export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'why-diff');
}

/** The record file of a session: `<dataDir>/sessions/<sha256(session_id)>.json`. */
export function recordPath(sessionId: string): string {
  return path.join(dataDir(), 'sessions', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

/** The text the SessionStart hook adds to the transcript once a session has a record. */
export function recordMarker(sessionId: string): string {
  return `why-diff:base-record ${createHash('sha256').update(sessionId).digest('hex')}`;
}

/** The text the SessionStart hook adds to the transcript when the record could not be written. */
export function failedMarker(sessionId: string): string {
  return `why-diff:base-record-failed ${createHash('sha256').update(sessionId).digest('hex')}`;
}

/**
 * Write the base record for a SessionStart payload (`{session_id, cwd, source}`). Never throws: a
 * session must start whatever happens here. Only the first SessionStart of a session writes (a
 * resume or compaction keeps the record of the real start), and a resumed session that has none
 * gets none (it would be dated after the session's earlier tool calls).
 *
 * Returns the hook's stdout, SessionStart JSON for the transcript, or undefined (print nothing):
 * - in a repository at startup or `/clear` (any source but resume and compact), always a marker:
 *   {@link recordMarker} when the record is there, {@link failedMarker} when it could not be
 *   written (an unwritable data directory left by an earlier session), so the guard can block
 *   when the record later goes missing, or never existed;
 * - on resume or compaction, {@link recordMarker} when the session has a record;
 * - outside a repository, nothing.
 */
export async function recordSessionStart(payload: { session_id?: unknown; cwd?: unknown; source?: unknown }): Promise<string | undefined> {
  try {
    const id = payload.session_id;
    const cwd = payload.cwd;
    if (typeof id !== 'string' || !id || typeof cwd !== 'string' || !cwd) return undefined;
    let root: string;
    try {
      root = await repoRoot(cwd);
    } catch {
      return undefined; // not a repository: nothing to guard
    }
    // The form the guard compares against: git prints `C:/x` on Windows, realpath gives `C:\\x`.
    root = await realpath(root).catch(() => path.resolve(root));
    const fresh = payload.source !== 'resume' && payload.source !== 'compact';
    if (fresh) await writeRecord(id, root);
    const ok = await readFile(recordPath(id), 'utf8').then((t) => (JSON.parse(t) as BaseRecord).session_id === id, () => false);
    if (ok) return hookOutput(`${recordMarker(id)} (why-diff recorded the commit this session starts from)`);
    return fresh ? hookOutput(`${failedMarker(id)} (why-diff could not record the commit this session starts from; its Stop hook will block)`) : undefined;
  } catch {
    return undefined;
  }
}

function hookOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

async function writeRecord(id: string, root: string): Promise<void> {
  try {
    const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')) || null;
    // The index as a tree (fails during a merge with conflicts: then none), so staged changes from
    // before the session are not taken for the agent's.
    const indexTree = (await git(root, ['write-tree']).catch(() => '')) || undefined;
    const record: BaseRecord = { session_id: id, root, head, at: new Date().toISOString(), ...(indexTree && /^[0-9a-f]{40,64}$/.test(indexTree) ? { indexTree } : {}) };
    const file = recordPath(id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const fh = await open(file, 'wx', 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await fh.close();
    }
  } catch {
    // An existing record (kept), an unwritable data dir (the caller prints the failed marker).
  }
}
