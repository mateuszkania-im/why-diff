/**
 * `why-diff session-start`: a Claude Code SessionStart hook that records which commit HEAD pointed
 * at when the session started, outside the repository (the agent can rewrite `.git`, including the
 * reflogs the guard would otherwise read the base from). The guard trusts the record only when its
 * file last changed before the session's first tool call: rewriting it changes its ctime.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repoRoot } from './git.js';

/** What `session-start` writes, one file per session. */
export interface BaseRecord {
  session_id: string;
  /** Repository root, as `git rev-parse --show-toplevel` prints it */
  root: string;
  /** HEAD's commit at session start; null on an unborn branch */
  head: string | null;
  /** When the record was written (ISO) */
  at: string;
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

/**
 * Write the base record for a SessionStart payload (`{session_id, cwd, source}`). Never throws: a
 * session must start whatever happens here. Only the first SessionStart of a session writes (a
 * resume or compaction keeps the record of the real start), and a resumed session that has none
 * gets none (it would be dated after the session's earlier tool calls).
 *
 * Returns the hook's stdout when the session has a record: SessionStart JSON whose
 * `additionalContext` carries {@link recordMarker}, so the transcript proves the record existed and
 * the guard can block when it later goes missing. Otherwise undefined (print nothing).
 */
export async function recordSessionStart(payload: { session_id?: unknown; cwd?: unknown; source?: unknown }): Promise<string | undefined> {
  const id = payload.session_id;
  if (typeof id !== 'string' || !id) return undefined;
  await writeRecord(id, payload);
  try {
    const data = JSON.parse(await readFile(recordPath(id), 'utf8')) as BaseRecord;
    if (data.session_id !== id) return undefined;
  } catch {
    return undefined;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${recordMarker(id)} (why-diff recorded the commit this session starts from)` } });
}

async function writeRecord(id: string, payload: { cwd?: unknown; source?: unknown }): Promise<void> {
  try {
    const cwd = payload.cwd;
    if (typeof cwd !== 'string' || !cwd) return;
    if (payload.source === 'resume' || payload.source === 'compact') return;
    const root = await repoRoot(cwd);
    const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')) || null;
    const record: BaseRecord = { session_id: id, root, head, at: new Date().toISOString() };
    const file = recordPath(id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const fh = await open(file, 'wx', 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await fh.close();
    }
  } catch {
    // Not a repository, an existing record, an unwritable data dir: nothing to record.
  }
}
