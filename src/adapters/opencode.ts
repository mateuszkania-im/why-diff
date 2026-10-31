/**
 * OpenCode (sst/opencode, now anomalyco/opencode) session adapter.
 *
 * NOT VERIFIED AGAINST LOCAL DATA: OpenCode is not installed on the machine
 * this adapter was written on. It is implemented from the OpenCode source:
 *
 * - JSON file storage (v0.x to v1.1, `packages/opencode/src/storage/storage.ts`):
 *     `<data>/storage/session/<projectID>/<sessionID>.json`   Session.Info
 *     `<data>/storage/message/<sessionID>/<messageID>.json`   MessageV2.Info
 *     `<data>/storage/part/<messageID>/<partID>.json`         MessageV2.Part
 *   (the pre-1.0 layout `storage/session/{info,message,part}/...` is accepted too)
 * - SQLite storage (v1.2 and later, `packages/opencode/src/session/session.sql.ts`,
 *   still present in v1.18): `<data>/opencode.db` with tables
 *     `session(id, directory, title, parent_id, time_created, time_updated, ...)`
 *     `message(id, session_id, time_created, data JSON)`
 *     `part(id, message_id, session_id, time_created, data JSON)`
 *   where `data` is the same MessageV2 object minus its ids. A DB session is
 *   addressed as `<path to opencode.db>#<sessionID>`.
 *
 * `<data>` is `$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`
 * (OpenCode uses xdg-basedir on every platform).
 *
 * Relevant MessageV2 shapes (from `session/message-v2.ts`):
 *   message: `{id, sessionID, role: 'user'|'assistant', time: {created, completed?}}`
 *   text part: `{type: 'text', text, synthetic?, ignored?}`; reasoning: `{type: 'reasoning', text}`
 *   tool part: `{type: 'tool', callID, tool, state: {status: pending|running|completed|error,
 *              input, output?, error?, time: {start, end?}}}`
 * Tool inputs: `edit {filePath, oldString, newString, replaceAll?}`, `write {filePath, content}`,
 * `multiedit {filePath, edits: [{filePath, oldString, newString}]}`, `patch` / `apply_patch
 * {patchText}` (Codex envelope format), `bash {command, workdir?}`.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DiscoverOptions, FileEdit, Prompt, Session, SessionAdapter } from '../types.js';
import {
  arr,
  clip,
  isRecord,
  num,
  parseApplyPatch,
  patchOpsToEdits,
  rec,
  resolvePath,
  shellWriteTargets,
  str,
  tryParseJson,
  type EditBody,
  type JsonRecord,
} from './patch.js';

/* ------------------------------------------------------------------------ */
/* Locations                                                                */
/* ------------------------------------------------------------------------ */

/**
 * OpenCode data directory. An explicit `home` (used by tests) wins; otherwise
 * `$XDG_DATA_HOME/opencode`, then `~/.local/share/opencode`.
 */
export function opencodeDataDir(home?: string): string {
  if (home) return path.join(home, '.local', 'share', 'opencode');
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(os.homedir(), '.local', 'share', 'opencode');
}

const DB_REF = /^(.*\.db)#([^#/\\]+)$/;

/* ------------------------------------------------------------------------ */
/* Normalised raw model (shared by the JSON and SQLite backends)            */
/* ------------------------------------------------------------------------ */

interface RawMessage {
  id: string;
  role: string;
  /** epoch ms */
  created: number;
  parts: JsonRecord[];
}

interface RawSession {
  id: string;
  directory: string;
  title?: string;
  parentId?: string;
  created: number;
  updated: number;
  messages: RawMessage[];
}

/* ------------------------------------------------------------------------ */
/* JSON file backend                                                        */
/* ------------------------------------------------------------------------ */

async function readJson(file: string): Promise<unknown> {
  try {
    return tryParseJson(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Session info header as stored in `session/<projectID>/<id>.json`. */
function sessionHeader(info: unknown): Omit<RawSession, 'messages'> | null {
  const id = str(info, 'id');
  const directory = str(info, 'directory');
  if (!id || !directory) return null;
  const time = rec(info, 'time');
  const title = str(info, 'title');
  const parentId = str(info, 'parentID');
  return {
    id,
    directory,
    ...(title ? { title } : {}),
    ...(parentId ? { parentId } : {}),
    created: num(time, 'created') ?? 0,
    updated: num(time, 'updated') ?? num(time, 'created') ?? 0,
  };
}

/** All session info files under `storage/session/` (both layouts). */
async function jsonSessionFiles(storage: string): Promise<string[]> {
  const root = path.join(storage, 'session');
  const files: string[] = [];
  for (const sub of await listDirs(root)) {
    if (sub === 'message' || sub === 'part') continue; // pre-1.0 siblings of `info`
    for (const f of await listJson(path.join(root, sub))) files.push(path.join(root, sub, f));
  }
  return files;
}

/** The `storage` directory that contains a session info file. */
function storageRootOf(sessionFile: string): string {
  let dir = path.dirname(sessionFile);
  for (let i = 0; i < 4; i++) {
    if (path.basename(dir) === 'storage') return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(sessionFile), '..', '..');
}

async function loadJsonSession(file: string): Promise<RawSession> {
  const header = sessionHeader(await readJson(file));
  if (!header) throw new Error(`Not an OpenCode session file: ${file}`);
  const storage = storageRootOf(file);

  const msgDirs = [path.join(storage, 'message', header.id), path.join(storage, 'session', 'message', header.id)];
  const messages: RawMessage[] = [];
  for (const dir of msgDirs) {
    for (const f of await listJson(dir)) {
      const info = await readJson(path.join(dir, f));
      const id = str(info, 'id');
      if (!id) continue;
      const partDirs = [path.join(storage, 'part', id), path.join(storage, 'session', 'part', header.id, id)];
      const parts: JsonRecord[] = [];
      for (const pd of partDirs) {
        for (const pf of await listJson(pd)) {
          const part = await readJson(path.join(pd, pf));
          if (isRecord(part)) parts.push(part);
        }
      }
      messages.push({ id, role: str(info, 'role') ?? '', created: num(rec(info, 'time'), 'created') ?? 0, parts });
    }
  }
  messages.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  return { ...header, messages };
}

/* ------------------------------------------------------------------------ */
/* SQLite backend                                                           */
/* ------------------------------------------------------------------------ */

type SqliteModule = typeof import('node:sqlite');
let sqlitePromise: Promise<SqliteModule | null> | undefined;

/**
 * Load `node:sqlite` (Node >= 22.5) once, silencing its ExperimentalWarning.
 * Resolves to null on runtimes without it; DB sessions are then skipped.
 */
function loadSqlite(): Promise<SqliteModule | null> {
  sqlitePromise ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
      const message = typeof warning === 'string' ? warning : warning.message;
      if (message.includes('SQLite')) return;
      (original as (...args: unknown[]) => void).apply(this, [warning, ...rest]);
    } as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } catch {
      return null;
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqlitePromise;
}

/** Run `fn` against a read-only connection; returns null if the DB cannot be opened. */
async function withDb<T>(dbPath: string, fn: (db: InstanceType<SqliteModule['DatabaseSync']>) => T): Promise<T | null> {
  const sqlite = await loadSqlite();
  if (!sqlite || !existsSync(dbPath)) return null;
  let db: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function rowHeader(row: unknown): Omit<RawSession, 'messages'> | null {
  const id = str(row, 'id');
  const directory = str(row, 'directory');
  if (!id || !directory) return null;
  const title = str(row, 'title');
  const parentId = str(row, 'parent_id');
  const created = num(row, 'time_created') ?? 0;
  return {
    id,
    directory,
    ...(title ? { title } : {}),
    ...(parentId ? { parentId } : {}),
    created,
    updated: num(row, 'time_updated') ?? created,
  };
}

async function dbSessionHeaders(dbPath: string): Promise<Omit<RawSession, 'messages'>[]> {
  const rows = await withDb(dbPath, (db) =>
    db.prepare('SELECT id, directory, title, parent_id, time_created, time_updated FROM session').all(),
  );
  return (rows ?? []).map(rowHeader).filter((h): h is Omit<RawSession, 'messages'> => h !== null);
}

async function loadDbSession(dbPath: string, sessionId: string): Promise<RawSession> {
  const raw = await withDb(dbPath, (db): RawSession | null => {
    const header = rowHeader(
      db.prepare('SELECT id, directory, title, parent_id, time_created, time_updated FROM session WHERE id = ?').get(sessionId),
    );
    if (!header) return null;
    const msgRows = db
      .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId);
    const partRows = db.prepare('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id').all(sessionId);

    const partsByMessage = new Map<string, JsonRecord[]>();
    for (const row of partRows) {
      const data = tryParseJson(str(row, 'data') ?? '');
      const messageId = str(row, 'message_id');
      if (!isRecord(data) || !messageId) continue;
      const list = partsByMessage.get(messageId) ?? [];
      list.push({ ...data, id: str(row, 'id') ?? '', messageID: messageId, sessionID: sessionId });
      partsByMessage.set(messageId, list);
    }
    const messages: RawMessage[] = [];
    for (const row of msgRows) {
      const id = str(row, 'id');
      const data = tryParseJson(str(row, 'data') ?? '');
      if (!id || !isRecord(data)) continue;
      messages.push({
        id,
        role: str(data, 'role') ?? '',
        created: num(rec(data, 'time'), 'created') ?? num(row, 'time_created') ?? 0,
        parts: partsByMessage.get(id) ?? [],
      });
    }
    return { ...header, messages };
  });
  if (!raw) throw new Error(`OpenCode session ${sessionId} not found in ${dbPath}`);
  return raw;
}

/* ------------------------------------------------------------------------ */
/* Discovery                                                                */
/* ------------------------------------------------------------------------ */

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Sessions (JSON files and `opencode.db` rows) whose directory is inside
 * `repoRoot` and whose [created, updated] interval overlaps [since, until].
 * A session present in both stores (left over after OpenCode's JSON to SQLite
 * migration) is reported once, from the database.
 */
async function discover(
  repoRoot: string,
  opts: DiscoverOptions = {},
): Promise<string[]> {
  const dataDir = opencodeDataDir(opts.home);
  const repo = await realpathSafe(repoRoot);
  const keep = async (h: Omit<RawSession, 'messages'>): Promise<boolean> => {
    if (opts.since && h.updated < opts.since.getTime()) return false;
    if (opts.until && h.created > opts.until.getTime()) return false;
    return isInside(repo, await realpathSafe(h.directory));
  };

  const found: string[] = [];
  const seen = new Set<string>();
  const dbPath = path.join(dataDir, 'opencode.db');
  for (const h of await dbSessionHeaders(dbPath)) {
    seen.add(h.id);
    if (await keep(h)) found.push(`${dbPath}#${h.id}`);
  }
  for (const file of await jsonSessionFiles(path.join(dataDir, 'storage'))) {
    const h = sessionHeader(await readJson(file));
    if (!h || seen.has(h.id)) continue;
    seen.add(h.id);
    if (await keep(h)) found.push(file);
  }
  return found;
}

/* ------------------------------------------------------------------------ */
/* Normalisation                                                            */
/* ------------------------------------------------------------------------ */

const iso = (ms: number): string => new Date(ms).toISOString();

/** Edit bodies for one tool call; `command` is set for bash. */
export function opencodeToolEdits(tool: string, input: JsonRecord, baseDir: string): EditBody[] {
  const file = (p: string | undefined): string => resolvePath(baseDir, p ?? '');
  switch (tool) {
    case 'edit': {
      const filePath = str(input, 'filePath');
      if (!filePath) return [];
      return [{ kind: 'edit', filePath: file(filePath), oldText: str(input, 'oldString') ?? '', newText: str(input, 'newString') ?? '' }];
    }
    case 'write': {
      const filePath = str(input, 'filePath');
      if (!filePath) return [];
      return [{ kind: 'write', filePath: file(filePath), oldText: null, newText: str(input, 'content') ?? '' }];
    }
    case 'multiedit': {
      const outer = str(input, 'filePath');
      return arr(input, 'edits').flatMap((e): EditBody[] => {
        const filePath = str(e, 'filePath') ?? outer;
        if (!filePath) return [];
        return [{ kind: 'edit', filePath: file(filePath), oldText: str(e, 'oldString') ?? '', newText: str(e, 'newString') ?? '' }];
      });
    }
    case 'patch':
    case 'apply_patch': {
      const text = str(input, 'patchText') ?? str(input, 'patch') ?? '';
      return patchOpsToEdits(parseApplyPatch(text), baseDir);
    }
    case 'bash': {
      const command = str(input, 'command') ?? '';
      const { mutating, targets } = shellWriteTargets(command);
      if (!mutating) return [];
      const dir = resolvePath(baseDir, str(input, 'workdir') ?? '.');
      const files = targets.length ? targets.map((t) => resolvePath(dir, t)) : [dir];
      return files.map((filePath) => ({ kind: 'bash', filePath, oldText: null, newText: null }));
    }
    default:
      return [];
  }
}

/** What the human typed in a user message: non-synthetic, non-ignored text parts. */
export function opencodeHumanText(parts: JsonRecord[]): string {
  return parts
    .filter((p) => str(p, 'type') === 'text' && p.synthetic !== true && p.ignored !== true)
    .map((p) => (str(p, 'text') ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toSession(raw: RawSession, sourcePath: string): Session {
  const sessionId = raw.id;
  const prompts: Prompt[] = [];
  const edits: FileEdit[] = [];
  const counter = new Map<string, number>();
  let rationale: string | undefined;

  for (const msg of raw.messages) {
    if (msg.role === 'user') {
      const text = opencodeHumanText(msg.parts);
      if (!text) continue;
      const index = prompts.length;
      prompts.push({ id: `${sessionId}:${index}`, sessionId, harness: 'opencode', index, at: iso(msg.created), text });
      rationale = undefined;
      continue;
    }
    if (msg.role !== 'assistant') continue;

    for (const part of msg.parts) {
      const type = str(part, 'type');
      if (type === 'text' || type === 'reasoning') {
        const text = (str(part, 'text') ?? '').trim();
        if (text) rationale = clip(text);
        continue;
      }
      if (type !== 'tool') continue;
      const tool = str(part, 'tool') ?? '';
      const state = rec(part, 'state');
      const input = rec(state, 'input') ?? {};
      const bodies = opencodeToolEdits(tool, input, raw.directory);
      if (bodies.length === 0) continue;

      const toolUseId = str(part, 'callID') ?? str(part, 'id') ?? '';
      const status = str(state, 'status');
      const startedMs = num(rec(state, 'time'), 'start') ?? msg.created;
      const command = tool === 'bash' ? str(input, 'command') : undefined;
      for (const body of bodies) {
        const n = counter.get(toolUseId) ?? 0;
        counter.set(toolUseId, n + 1);
        edits.push({
          id: `${sessionId}:${toolUseId}:${n}`,
          sessionId,
          harness: 'opencode',
          toolUseId,
          tool,
          kind: body.kind,
          filePath: body.filePath,
          at: iso(startedMs),
          promptId: prompts.length ? `${sessionId}:${prompts.length - 1}` : '',
          oldText: body.oldText,
          newText: body.newText,
          ...(command !== undefined ? { command } : {}),
          ...(rationale ? { rationale } : {}),
          // `error` = the tool threw (nothing written); `pending` = never started.
          ...(status === 'error' || status === 'pending' ? { failed: true } : {}),
        });
      }
    }
  }

  return {
    id: sessionId,
    harness: 'opencode',
    cwd: raw.directory,
    path: sourcePath,
    startedAt: iso(raw.created),
    endedAt: iso(Math.max(raw.updated, raw.created)),
    ...(raw.title ? { title: raw.title } : {}),
    prompts,
    edits,
  };
}

/** Parse an OpenCode session: a `session/.../<id>.json` file or `<opencode.db>#<id>`. */
export async function parseOpencodeSession(ref: string): Promise<Session> {
  const m = DB_REF.exec(ref);
  const raw = m?.[1] && m[2] ? await loadDbSession(m[1], m[2]) : await loadJsonSession(ref);
  return toSession(raw, ref);
}

/** Session adapter for OpenCode (JSON storage and opencode.db). */
export const opencodeAdapter: SessionAdapter = {
  harness: 'opencode',
  discover,
  parse: parseOpencodeSession,
};

export { discover as discoverOpencodeSessions };
