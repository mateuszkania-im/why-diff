/**
 * Codex CLI / Codex Desktop session adapter.
 *
 * Transcripts live in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 * (CODEX_HOME defaults to `~/.codex`). Every line is `{timestamp, type, payload}`:
 *
 * - `session_meta`   first line: `{id, cwd, timestamp, cli_version, originator, ...}`
 * - `turn_context`   per turn: `{turn_id, cwd, ...}`
 * - `response_item`  model I/O, `payload.type` is one of
 *     - `message` (role user | assistant | developer), content `input_text` / `output_text`
 *     - `reasoning` (`summary[].text`, usually encrypted otherwise)
 *     - `custom_tool_call` `{call_id, name, input}`: `apply_patch` (freeform patch
 *       text) or `exec` ("code mode": a JavaScript cell calling
 *       `tools.apply_patch("...")`, `tools.exec_command({cmd})`, ...)
 *     - `function_call` `{call_id, name, arguments}`: `exec_command {cmd, workdir}`,
 *       `shell {command: [...], workdir}`, `shell_command`, `apply_patch {input}`
 *     - `local_shell_call` `{call_id, action: {command, working_directory}}`
 *     - `*_output` `{call_id, output}`
 * - `event_msg`      UI events; we use
 *     - `item_completed` with `item.type` `FileChange` (`changes: {absPath: {type:
 *       add|delete|update, content | unified_diff, move_path}}`, `status`) and
 *       `CommandExecution` (`command`, `exit_code`, `status`). In classic mode
 *       `item.id` equals the tool `call_id`; in code mode it is `exec-<uuid>`.
 *     - `patch_apply_end` `{call_id, success}` (older CLI versions)
 *
 * Verified against real rollouts written by Codex Desktop 0.116 to 0.162
 * (classic `apply_patch` + `exec_command`, and the newer code-mode `exec` cell).
 * `shell` / `local_shell_call` / `patch_apply_end` follow the open-source
 * codex-rs protocol and are handled defensively.
 */

import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DiscoverOptions, FileEdit, Prompt, Session, SessionAdapter } from '../types.js';
import { DRIVE_PATH, fileMentions, pathWithin } from './scan.js';
import {
  arr,
  clip,
  extractPatchEnvelope,
  findJsToolCalls,
  isRecord,
  jsStringArg,
  num,
  parseApplyPatch,
  parseUnifiedHunks,
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
/* Locations & discovery                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Codex data directory. An explicit `home` (used by tests) wins; otherwise
 * `$CODEX_HOME`, then `~/.codex`.
 */
export function codexHome(home?: string): string {
  if (home) return path.join(home, '.codex');
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** Stream a JSONL file, yielding parsed object lines (malformed lines are skipped). */
async function* readJsonl(file: string): AsyncGenerator<JsonRecord> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const value = tryParseJson(line);
      if (isRecord(value)) yield value;
    }
  } finally {
    rl.close();
  }
}

/** Header of a rollout file. */
export interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
}

/** Read only the `session_meta` line (the first line) of a rollout file. */
export async function readCodexMeta(file: string): Promise<CodexSessionMeta | null> {
  for await (const line of readJsonl(file)) {
    if (line.type !== 'session_meta') return null;
    const p = rec(line, 'payload');
    const id = str(p, 'id') ?? str(p, 'session_id');
    const cwd = str(p, 'cwd');
    if (!id || !cwd) return null;
    return { id, cwd, timestamp: str(p, 'timestamp') ?? str(line, 'timestamp') ?? '' };
  }
  return null;
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` is `root` or lives below it. */
export function isInside(root: string, child: string): boolean {
  if (DRIVE_PATH.test(root) || DRIVE_PATH.test(child)) return pathWithin(root, child);
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

const DAY_MS = 86_400_000;

/**
 * Find rollouts whose `cwd` is inside `repoRoot` and whose lifetime
 * [session_meta.timestamp, file mtime] overlaps [since, until].
 * Dated folders newer than `until` (+1 day for time zones) are pruned.
 * Compressed archives (`archived_sessions/*.jsonl.zst`) are not read.
 *
 * With `scanAll`, rollouts started elsewhere are kept when their bytes
 * mention a path under the repo root (an apply_patch or shell command on an
 * absolute path).
 */
async function discover(
  repoRoot: string,
  opts: DiscoverOptions = {},
): Promise<string[]> {
  const root = path.join(codexHome(opts.home), 'sessions');
  const repo = await realpathSafe(repoRoot);
  const repos = [repo, ...(await Promise.all((opts.extraRoots ?? []).map(realpathSafe)))];
  const needles = [...new Set([...repos, path.resolve(repoRoot), ...(opts.extraRoots ?? []).map((r) => path.resolve(r))])].map((r) => `${r}/`);
  const found: string[] = [];

  for (const y of (await listDir(root)).filter((d) => /^\d{4}$/.test(d))) {
    for (const m of (await listDir(path.join(root, y))).filter((d) => /^\d{2}$/.test(d))) {
      for (const d of (await listDir(path.join(root, y, m))).filter((x) => /^\d{2}$/.test(x))) {
        const folderDay = Date.UTC(Number(y), Number(m) - 1, Number(d));
        if (opts.until && folderDay > opts.until.getTime() + DAY_MS) continue;
        const dayDir = path.join(root, y, m, d);
        for (const name of await listDir(dayDir)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const file = path.join(dayDir, name);
          const st = await stat(file).catch(() => null);
          if (!st) continue;
          if (opts.since && st.mtime < opts.since) continue;
          const meta = await readCodexMeta(file);
          if (!meta) continue;
          if (opts.until && meta.timestamp && new Date(meta.timestamp) > opts.until) continue;
          const cwdReal = await realpathSafe(meta.cwd);
          if (!repos.some((r) => isInside(r, cwdReal)) && !(opts.scanAll && (await fileMentions(file, needles)))) continue;
          found.push(file);
        }
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------------ */
/* Human prompt extraction                                                  */
/* ------------------------------------------------------------------------ */

/** Text blocks Codex injects into user messages (never typed by the human). */
const INJECTED_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<user_instructions>',
  '<INSTRUCTIONS>',
  '<external_',
  '<image',
  '</image>',
  '<turn_aborted>',
  '<recommended_plugins>',
  '<send_user_message_question_reply>',
  '<user_shell_command>',
  '<subagent_notification>',
  '<skill>',
];

/** Headers of the attachment preamble; the human's text follows `## My request...:`. */
const ATTACHMENT_HEADERS = ['# Files mentioned by the user:', '# Files pasted by the user:', '# Context from my IDE setup:'];
const MY_REQUEST = /^## My request(?: for Codex)?:[ \t]*\n?/m;

/**
 * Reduce one user `message` payload's content to what the human typed:
 * environment context, AGENTS.md / instruction blocks, image wrappers and
 * attachment listings are removed. Returns '' for purely injected messages.
 */
export function extractHumanText(content: unknown[]): string {
  const kept: string[] = [];
  for (const item of content) {
    if (str(item, 'type') !== 'input_text' && str(item, 'type') !== 'text') continue;
    const raw = str(item, 'text') ?? '';
    const t = raw.trim();
    if (!t) continue;
    if (INJECTED_PREFIXES.some((p) => t.startsWith(p))) continue;
    // A message that is one single XML-ish block is harness context.
    if (/^<([A-Za-z_][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/.test(t)) continue;
    // Desktop/IDE preambles (attachments, in-app browser state, ...) end with
    // `## My request for Codex:` followed by what the human typed.
    const m = MY_REQUEST.exec(t);
    if (m) {
      kept.push(t.slice(m.index + m[0].length).trim());
      continue;
    }
    if (ATTACHMENT_HEADERS.some((h) => t.startsWith(h))) continue;
    kept.push(t);
  }
  return kept.filter(Boolean).join('\n').trim();
}

/* ------------------------------------------------------------------------ */
/* Tool output helpers                                                      */
/* ------------------------------------------------------------------------ */

/** Flatten a `*_output` payload into text + exit code (when recorded). */
function readOutput(output: unknown): { text: string; exitCode?: number } {
  if (typeof output === 'string') {
    const parsed = tryParseJson(output);
    if (isRecord(parsed) && typeof parsed.output === 'string') {
      return { text: parsed.output, exitCode: num(rec(parsed, 'metadata'), 'exit_code') };
    }
    const m = /Process exited with code (\d+)|Exit code: (\d+)/.exec(output);
    const code = m ? Number(m[1] ?? m[2]) : undefined;
    return { text: output, exitCode: code };
  }
  if (Array.isArray(output)) {
    return { text: output.map((o) => str(o, 'text') ?? '').join('\n') };
  }
  if (isRecord(output)) return readOutput(str(output, 'content') ?? str(output, 'output') ?? '');
  return { text: '' };
}

function patchFailed(text: string, exitCode?: number): boolean {
  if (exitCode !== undefined && exitCode !== 0) return true;
  if (/^\s*Success\b/m.test(text)) return false;
  return /verification failed|rejected|declined|failed to|invalid (hunk|patch)|\berror\b|aborted/i.test(text);
}

/** A shell command "failed" for attribution only when it never ran. */
function shellRejected(text: string): boolean {
  return /\b(rejected|declined)\b by (the )?user|sandbox (denied|error)|aborted by user/i.test(text);
}

/** `["/bin/zsh", "-lc", "script"]` -> "script"; other argv arrays are joined. */
function argvToCommand(argv: unknown[]): string {
  const parts = argv.filter((a): a is string => typeof a === 'string');
  const shellIdx = parts.findIndex((p) => p === '-lc' || p === '-c');
  if (shellIdx >= 0 && parts[shellIdx + 1] !== undefined) return parts.slice(shellIdx + 1).join(' ');
  return parts.join(' ');
}

/* ------------------------------------------------------------------------ */
/* Parser                                                                   */
/* ------------------------------------------------------------------------ */

/** One tool invocation that produced (or may produce) edits, kept for failure reconciliation. */
interface Invocation {
  callId: string;
  kind: 'patch' | 'shell';
  edits: FileEdit[];
  /** patch: absolute source paths of the ops, for matching FileChange items */
  paths: string[];
  /** shell: the command line, for matching CommandExecution items */
  command?: string;
  resolved: boolean;
  /** True when issued from a code-mode `exec` cell (outputs are async). */
  inCell: boolean;
}

const SHELL_TOOLS = new Set(['shell', 'container.exec', 'local_shell', 'shell_command', 'exec_command']);

class CodexParser {
  private sessionId: string;
  private cwd = '';
  private startedAt = '';
  private endedAt = '';
  private lineAt = '';
  private readonly prompts: Prompt[] = [];
  private readonly edits: FileEdit[] = [];
  private readonly turnPrompt = new Map<string, number>();
  private readonly editCounter = new Map<string, number>();
  private readonly invocations: Invocation[] = [];
  private readonly byCallId = new Map<string, Invocation[]>();
  private rationale: string | undefined;

  constructor(private readonly file: string) {
    // Fallback id from the filename (rollout-<ts>-<uuid>.jsonl).
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
    this.sessionId = m?.[1] ?? path.basename(file, '.jsonl');
  }

  async run(): Promise<Session> {
    for await (const line of readJsonl(this.file)) {
      const ts = str(line, 'timestamp');
      if (ts) {
        this.lineAt = ts;
        if (!this.startedAt) this.startedAt = ts;
        this.endedAt = ts;
      }
      const payload = rec(line, 'payload');
      if (!payload) continue;
      switch (str(line, 'type')) {
        case 'session_meta':
          this.onMeta(payload);
          break;
        case 'turn_context':
          if (str(payload, 'cwd')) this.cwd = str(payload, 'cwd') ?? this.cwd;
          break;
        case 'response_item':
          this.onResponseItem(payload);
          break;
        case 'event_msg':
          this.onEvent(payload);
          break;
        default:
          break;
      }
    }
    const first = this.prompts[0]?.text.split('\n')[0];
    return {
      id: this.sessionId,
      harness: 'codex',
      cwd: this.cwd,
      path: this.file,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      ...(first ? { title: clip(first, 80) } : {}),
      prompts: this.prompts,
      edits: this.edits,
    };
  }

  /* -- record handlers ---------------------------------------------------- */

  private onMeta(p: JsonRecord): void {
    this.sessionId = str(p, 'id') ?? str(p, 'session_id') ?? this.sessionId;
    this.cwd = str(p, 'cwd') ?? this.cwd;
    const ts = str(p, 'timestamp');
    if (ts) this.startedAt = ts;
  }

  private onResponseItem(p: JsonRecord): void {
    const type = str(p, 'type');
    const turnId = str(rec(p, 'internal_chat_message_metadata_passthrough'), 'turn_id');

    if (type === 'message') {
      const role = str(p, 'role');
      if (role === 'user') this.onUserMessage(arr(p, 'content'), turnId);
      else if (role === 'assistant') {
        const text = arr(p, 'content')
          .map((c) => str(c, 'text') ?? '')
          .join('\n')
          .trim();
        if (text) this.rationale = clip(text);
      }
      return;
    }
    if (type === 'reasoning') {
      const summary = arr(p, 'summary')
        .map((s) => str(s, 'text') ?? '')
        .join('\n')
        .trim();
      if (summary) this.rationale = clip(summary);
      return;
    }

    const callId = str(p, 'call_id') ?? str(p, 'id') ?? '';
    const name = str(p, 'name') ?? '';

    if (type === 'custom_tool_call') {
      const input = str(p, 'input') ?? '';
      if (name === 'apply_patch') this.addPatch(callId, 'apply_patch', input, this.cwd, turnId, false);
      else if (name === 'exec') this.onCodeCell(callId, input, turnId);
      return;
    }

    if (type === 'function_call') {
      const args = tryParseJson(str(p, 'arguments') ?? '');
      if (name === 'apply_patch') {
        const patch = str(args, 'input') ?? str(args, 'patch') ?? '';
        this.addPatch(callId, name, patch, str(args, 'workdir') ?? this.cwd, turnId, false);
      } else if (SHELL_TOOLS.has(name)) {
        const cmdValue = isRecord(args) ? (args.cmd ?? args.command) : undefined;
        const command = Array.isArray(cmdValue) ? argvToCommand(cmdValue) : typeof cmdValue === 'string' ? cmdValue : '';
        this.addShell(callId, name, command, str(args, 'workdir') ?? str(args, 'cwd') ?? this.cwd, turnId, false);
      }
      return;
    }

    if (type === 'local_shell_call') {
      const action = rec(p, 'action');
      const command = argvToCommand(arr(action, 'command'));
      this.addShell(callId, 'local_shell', command, str(action, 'working_directory') ?? this.cwd, turnId, false);
      return;
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      this.onOutput(callId, p.output);
    }
  }

  private onUserMessage(content: unknown[], turnId: string | undefined): void {
    const text = extractHumanText(content);
    if (!text) return;
    const index = this.prompts.length;
    this.prompts.push({
      id: `${this.sessionId}:${index}`,
      sessionId: this.sessionId,
      harness: 'codex',
      index,
      at: this.lineAt,
      text,
    });
    if (turnId) this.turnPrompt.set(turnId, index);
    this.rationale = undefined;
  }

  /** Code mode: one `exec` call runs a JS cell that may call several tools. */
  private onCodeCell(callId: string, js: string, turnId: string | undefined): void {
    const calls = [
      ...findJsToolCalls(js, 'apply_patch').map((c) => ({ ...c, tool: 'apply_patch' })),
      ...findJsToolCalls(js, 'exec_command').map((c) => ({ ...c, tool: 'exec_command' })),
      ...findJsToolCalls(js, 'shell_command').map((c) => ({ ...c, tool: 'shell_command' })),
    ].sort((a, b) => a.index - b.index);

    for (const c of calls) {
      if (c.tool === 'apply_patch') {
        const patch = jsStringArg(c.args, ['input', 'patch']);
        if (patch) this.addPatch(callId, 'apply_patch', patch, this.cwd, turnId, true);
      } else {
        const command = jsStringArg(c.args, ['cmd', 'command']);
        const workdir = jsStringArg(c.args, ['workdir', 'cwd']) ?? this.cwd;
        if (command) this.addShell(callId, c.tool, command, resolvePath(this.cwd || '/', workdir), turnId, true);
      }
    }
  }

  private onOutput(callId: string, output: unknown): void {
    const invs = (this.byCallId.get(callId) ?? []).filter((i) => !i.inCell);
    if (invs.length === 0) return;
    const { text, exitCode } = readOutput(output);
    for (const inv of invs) {
      const failed = inv.kind === 'patch' ? patchFailed(text, exitCode) : shellRejected(text);
      if (failed) this.markFailed(inv);
    }
  }

  private onEvent(p: JsonRecord): void {
    const type = str(p, 'type');
    if (type === 'patch_apply_end') {
      const callId = str(p, 'call_id') ?? '';
      if (p.success === false) for (const inv of this.byCallId.get(callId) ?? []) this.markFailed(inv);
      return;
    }
    if (type !== 'item_completed') return;
    const item = rec(p, 'item');
    const turnId = str(p, 'turn_id');
    if (str(item, 'type') === 'FileChange' && item) this.onFileChange(item, turnId);
    else if (str(item, 'type') === 'CommandExecution' && item) this.onCommandExecution(item, turnId);
  }

  /** Reconcile an applied patch with the invocation that issued it, or synthesise edits. */
  private onFileChange(item: JsonRecord, turnId: string | undefined): void {
    const id = str(item, 'id') ?? '';
    const changes = rec(item, 'changes') ?? {};
    const paths = Object.keys(changes).map((k) => path.resolve(k));
    const failed = str(item, 'status') !== undefined && str(item, 'status') !== 'completed';

    const pending = this.invocations.filter((i) => i.kind === 'patch' && !i.resolved);
    const inv =
      pending.find((i) => i.callId === id) ??
      pending.find((i) => sameSet(i.paths, paths)) ??
      pending.find((i) => i.inCell && i.paths.some((x) => paths.includes(x)));
    if (inv) {
      inv.resolved = true;
      if (failed) this.markFailed(inv);
      return;
    }

    // Not issued by a call we could parse (e.g. a patch held in a JS variable).
    const bodies: EditBody[] = [];
    for (const [file, change] of Object.entries(changes)) bodies.push(...fileChangeToEdits(file, change));
    const edits = this.emit(bodies, { toolUseId: id, tool: 'apply_patch', turnId });
    if (failed) for (const e of edits) e.failed = true;
  }

  private onCommandExecution(item: JsonRecord, turnId: string | undefined): void {
    const id = str(item, 'id') ?? '';
    const cmdValue = item.command;
    const command = Array.isArray(cmdValue) ? argvToCommand(cmdValue) : typeof cmdValue === 'string' ? cmdValue : '';
    const status = str(item, 'status');
    const neverRan = status === 'declined' || (status === 'failed' && num(item, 'exit_code') === undefined);

    const pending = this.invocations.filter((i) => i.kind === 'shell' && !i.resolved);
    const inv = pending.find((i) => i.callId === id) ?? pending.find((i) => i.command === command);
    if (inv) {
      inv.resolved = true;
      if (neverRan) this.markFailed(inv);
      return;
    }
    // Unknown origin: record it only if it mutates files.
    const cwdUrl = str(item, 'cwd') ?? '';
    const cwd = cwdUrl.startsWith('file://') ? decodeURI(cwdUrl.slice('file://'.length)) : cwdUrl || this.cwd;
    const before = this.edits.length;
    if (extractPatchEnvelope(command) && /\bapply_patch\b/.test(command)) return; // reported via FileChange
    this.addShell(id, 'exec_command', command, cwd, turnId, false);
    if (neverRan) for (const e of this.edits.slice(before)) e.failed = true;
    const inv2 = this.byCallId.get(id)?.at(-1);
    if (inv2) inv2.resolved = true;
  }

  /* -- edit construction -------------------------------------------------- */

  private addPatch(callId: string, tool: string, patchText: string, baseDir: string, turnId: string | undefined, inCell: boolean): void {
    const ops = parseApplyPatch(patchText);
    if (ops.length === 0) return;
    const base = baseDir || this.cwd || '/';
    const edits = this.emit(patchOpsToEdits(ops, base), { toolUseId: callId, tool, turnId });
    this.track({
      callId,
      kind: 'patch',
      edits,
      paths: ops.map((o) => resolvePath(base, o.path)),
      resolved: false,
      inCell,
    });
  }

  private addShell(callId: string, tool: string, command: string, workdir: string, turnId: string | undefined, inCell: boolean): void {
    if (!command) return;
    const base = workdir || this.cwd || '/';
    // `apply_patch <<'EOF' ... EOF` through the shell is a patch, not a bash edit.
    if (/\bapply_patch\b/.test(command) && extractPatchEnvelope(command)) {
      this.addPatch(callId, 'apply_patch', command, base, turnId, inCell);
      const inv = this.invocations.at(-1);
      if (inv && inv.callId === callId) inv.command = command;
      return;
    }
    const { mutating, targets } = shellWriteTargets(command);
    if (!mutating) return;
    const files = targets.length ? targets.map((t) => resolvePath(base, t)) : [path.resolve(base)];
    const bodies: EditBody[] = files.map((filePath) => ({ kind: 'bash', filePath, oldText: null, newText: null }));
    const edits = this.emit(bodies, { toolUseId: callId, tool, turnId, command });
    this.track({ callId, kind: 'shell', edits, paths: files, command, resolved: false, inCell });
  }

  private emit(bodies: EditBody[], ctx: { toolUseId: string; tool: string; turnId?: string; command?: string }): FileEdit[] {
    const out: FileEdit[] = [];
    for (const body of bodies) {
      const n = this.editCounter.get(ctx.toolUseId) ?? 0;
      this.editCounter.set(ctx.toolUseId, n + 1);
      const edit: FileEdit = {
        id: `${this.sessionId}:${ctx.toolUseId}:${n}`,
        sessionId: this.sessionId,
        harness: 'codex',
        toolUseId: ctx.toolUseId,
        tool: ctx.tool,
        kind: body.kind,
        filePath: body.filePath,
        at: this.lineAt,
        promptId: this.promptIdFor(ctx.turnId),
        oldText: body.oldText,
        newText: body.newText,
        ...(ctx.command !== undefined ? { command: ctx.command } : {}),
        ...(this.rationale ? { rationale: this.rationale } : {}),
      };
      out.push(edit);
      this.edits.push(edit);
    }
    return out;
  }

  private track(inv: Invocation): void {
    this.invocations.push(inv);
    const list = this.byCallId.get(inv.callId) ?? [];
    list.push(inv);
    this.byCallId.set(inv.callId, list);
  }

  private markFailed(inv: Invocation): void {
    inv.resolved = true;
    for (const e of inv.edits) e.failed = true;
  }

  /** Prompt that started the given turn, else the latest prompt ('' if none yet). */
  private promptIdFor(turnId: string | undefined): string {
    const idx = (turnId !== undefined ? this.turnPrompt.get(turnId) : undefined) ?? this.prompts.length - 1;
    return idx >= 0 ? `${this.sessionId}:${idx}` : '';
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * Convert one entry of a FileChange `changes` map into edit bodies. Supports
 * the internally tagged form (`{type: 'update', unified_diff}`) written by
 * current Codex and the externally tagged form (`{update: {unified_diff}}`).
 */
function fileChangeToEdits(file: string, change: unknown): EditBody[] {
  const tagged = str(change, 'type');
  const kind = tagged ?? (isRecord(change) ? Object.keys(change)[0] : undefined);
  const body = tagged ? change : rec(change, kind ?? '');
  const filePath = path.resolve(file);
  if (kind === 'add') {
    return [{ kind: 'write', filePath, oldText: null, newText: str(body, 'content') ?? '' }];
  }
  if (kind === 'delete') return [{ kind: 'write', filePath, oldText: null, newText: '' }];
  if (kind === 'update') {
    const target = str(body, 'move_path') ? path.resolve(str(body, 'move_path') ?? file) : filePath;
    const hunks = parseUnifiedHunks(str(body, 'unified_diff') ?? '');
    if (hunks.length === 0) return [{ kind: 'patch', filePath: target, oldText: '', newText: '' }];
    return hunks.map((h) => ({ kind: 'patch', filePath: target, oldText: h.oldText, newText: h.newText }));
  }
  return [];
}

/** Parse one Codex rollout file into a normalised Session. */
export async function parseCodexSession(file: string): Promise<Session> {
  return new CodexParser(file).run();
}

/** Session adapter for Codex CLI / Codex Desktop rollouts. */
export const codexAdapter: SessionAdapter = {
  harness: 'codex',
  discover,
  parse: parseCodexSession,
};

export { discover as discoverCodexSessions };
