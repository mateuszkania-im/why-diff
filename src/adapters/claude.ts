/**
 * SessionAdapter for Claude Code transcripts.
 *
 * Layout on disk (Claude Code >= 1.x, verified against v2.1.x):
 *
 *   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl            main transcript
 *   ~/.claude/projects/<encoded cwd>/<sessionId>/subagents/
 *       agent-<id>.jsonl                                           subagent transcript
 *       agent-<id>.meta.json  { toolUseId, agentType, ... }        link to the Agent call
 *
 * `<encoded cwd>` is the working directory with `/` and `.` replaced by `-`;
 * the encoding is lossy, so discovery peeks at each file's `cwd` field instead
 * of trusting directory names.
 *
 * Each line is one JSON object. We read: `user` lines (human prompts and
 * tool results), `assistant` lines (text + tool_use blocks), `ai-title` /
 * `summary` lines (session title). Everything else (file-history-snapshot,
 * attachment, system, api-request-*, ...) is skipped. Files are streamed line
 * by line so multi-hundred-MB transcripts do not need to fit in memory.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { DiscoverOptions, EditKind, FileEdit, Harness, Prompt, Session, SessionAdapter } from '../types.js';
import { fileMentions, filePathNeedles } from './scan.js';
import { detectBashMutations } from './bash-mutations.js';

// ---------------------------------------------------------------------------
// Transcript line shapes (only the fields we read; everything is optional
// because the format drifted across versions)
// ---------------------------------------------------------------------------

interface TextBlock {
  type: 'text';
  text?: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type?: string };

interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  agentId?: string;
  /** Turn id shared by the human prompt line and everything produced in that turn. */
  promptId?: string;
  origin?: { kind?: string };
  promptSource?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  toolUseResult?: unknown;
  aiTitle?: string;
  summary?: string;
}

interface EditToolResult {
  filePath?: string;
  oldString?: string;
  newString?: string;
  originalFile?: string | null;
  /** MultiEdit: file content before all of its edits. */
  originalFileContents?: string;
  type?: 'create' | 'update';
  content?: string;
  userModified?: boolean;
  replaceAll?: boolean;
  /** jsdiff-style hunks of the change, full lines prefixed with ' ', '-' or '+'. */
  structuredPatch?: unknown;
}

/** Before/after text of an edited region, as whole lines. */
interface RegionTexts {
  oldText: string;
  newText: string;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  result: EditToolResult | undefined;
}

interface PendingCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  at: string;
  promptId: string;
  rationale: string | undefined;
  cwd: string;
}

interface SubagentMeta {
  toolUseId?: string;
}

export type ClaudeDiscoverOptions = DiscoverOptions;

const HARNESS: Harness = 'claude-code';
const RATIONALE_MAX = 500;
const PEEK_LINES = 60;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);
const SKIP_MIN_LINE = 64 * 1024;
const TOOL_USE_ID = Buffer.from('"tool_use_id":"');

/** Tools whose result can turn into FileEdits (see emitEdits). */
function mayEdit(name: string): boolean {
  return EDIT_TOOLS.has(name) || /write_file|create_file$/i.test(name);
}
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** `promptSource` values that mean "a person (or the SDK caller) wrote this". */
const HUMAN_SOURCES = new Set(['typed', 'queued', 'sdk', 'human']);
/** `promptSource` values injected by the harness itself (hooks, cron, task notifications). */
const NON_HUMAN_SOURCES = new Set(['system', 'hook', 'scheduled', 'cron', 'automation']);
const NON_HUMAN_PREFIXES = [
  '<command-',
  '<local-command',
  '<task-notification',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook>',
  'Caveat:',
  '[Request interrupted',
];
/** Slash commands that configure the session rather than ask for work. */
const SESSION_COMMANDS = new Set(['clear', 'compact', 'model', 'config', 'login', 'logout', 'resume', 'cost', 'status', 'help', 'exit', 'permissions', 'memory', 'rename', 'add-dir', 'effort', 'output-style', 'theme']);
const REJECTION_PATTERNS = [
  /^<tool_use_error>/,
  /String to replace not found/i,
  /has been modified since (it was )?(last )?read/i,
  /File has not been read yet/i,
  /The user doesn't want to proceed/i,
  /tool use was rejected/i,
  /permission (was )?denied/i,
  /Request interrupted by user/i,
  /cannot be edited/i,
  /No changes to make/i,
];

/**
 * Encode a working directory the way Claude Code names project folders: every
 * character outside `[A-Za-z0-9-]` becomes `-`, so `/x/f01-cart__r1` is
 * `-x-f01-cart--r1`. The encoding is lossy; discovery confirms via `cwd`.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/** Resolve the Claude projects directory for a home. */
export function projectsDir(home = os.homedir()): string {
  return path.join(home, '.claude', 'projects');
}

/** Adapter that discovers and parses Claude Code sessions. */
export class ClaudeCodeAdapter implements SessionAdapter {
  readonly harness = HARNESS;

  /**
   * Transcripts whose `cwd` lies inside `repoRoot` and whose activity overlaps
   * [since, until]. Candidate folders are prefiltered by the encoded root (so
   * `/repo`, `/repo/sub` and in-repo worktrees qualify), then confirmed by
   * reading the first lines' `cwd`. Sorted by first timestamp.
   *
   * With `scanAll`, every other project folder is scanned too: transcripts
   * modified in the window are byte-searched for `"file_path":"<root>/`
   * (an Edit/Write of a file in the repo) and only the hits are returned.
   */
  async discover(repoRoot: string, opts: ClaudeDiscoverOptions = {}): Promise<string[]> {
    const base = projectsDir(opts.home);
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const roots = await rootVariants(repoRoot);
    const prefixes = roots.map(encodeProjectDir);
    const needles = filePathNeedles(roots, path.sep);
    const found: Array<{ path: string; startedAt: number }> = [];

    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const inRepo = prefixes.some((p) => d.name === p || d.name.startsWith(`${p}-`));
      // Sessions started in a parent folder (a multi-repo workspace, ~/code) edit
      // the repo by absolute path. They qualify only if they mention the repo root.
      const parent = !inRepo && prefixes.some((p) => p.startsWith(`${d.name}-`));
      // Anything else (a sibling folder, an unrelated project) only with --scan-all.
      const elsewhere = !inRepo && !parent;
      if (elsewhere && !opts.scanAll) continue;
      const dir = path.join(base, d.name);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(file)).mtimeMs;
        } catch {
          continue;
        }
        if (opts.since && mtimeMs < opts.since.getTime()) continue;
        if (elsewhere && !(await fileMentions(file, needles))) continue;
        const peek = await peekTranscript(file);
        if (!peek.cwd) continue;
        if (parent) {
          if (!(await isAncestor(peek.cwd, roots)) || !(await fileMentions(file, roots))) continue;
        } else if (!elsewhere && !(await isInside(roots, peek.cwd))) continue;
        const startedAt = peek.timestamp ? Date.parse(peek.timestamp) : mtimeMs;
        if (opts.until && startedAt > opts.until.getTime()) continue;
        found.push({ path: file, startedAt });
      }
    }
    found.sort((a, b) => a.startedAt - b.startedAt || a.path.localeCompare(b.path));
    return found.map((f) => f.path);
  }

  /** Parse a main transcript plus its subagent transcripts into a Session. */
  async parse(transcriptPath: string): Promise<Session> {
    const sessionIdFromName = path.basename(transcriptPath, '.jsonl');
    const builder = new SessionBuilder(sessionIdFromName);
    await forEachLine(transcriptPath, (line) => builder.consume(line, null), (raw) => builder.canSkip(raw));

    const subagentsDir = path.join(path.dirname(transcriptPath), sessionIdFromName, 'subagents');
    for (const file of await listSubagentFiles(subagentsDir)) {
      const meta = await readMeta(file.replace(/\.jsonl$/, '.meta.json'));
      const promptId = await builder.resolveSubagentPrompt(file, meta?.toolUseId);
      await forEachLine(file, (line) => builder.consume(line, promptId), (raw) => builder.canSkip(raw));
    }

    const fileStat = await stat(transcriptPath).catch(() => null);
    return builder.build(transcriptPath, fileStat?.mtime ?? new Date());
  }
}

/** Shared default instance. */
export const claudeCodeAdapter = new ClaudeCodeAdapter();

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

/**
 * Accumulates prompts and edits while lines stream past. `consume` is called
 * for main-transcript lines with `sidechainPromptId = null`, and for subagent
 * lines with the prompt id their edits should be attributed to.
 */
class SessionBuilder {
  private sessionId: string;
  private cwd = '';
  private firstTs: string | undefined;
  private lastTs: string | undefined;
  private title: string | undefined;
  private summaryTitle: string | undefined;
  private readonly prompts: Prompt[] = [];
  private readonly edits: FileEdit[] = [];
  private readonly pending = new Map<string, PendingCall>();
  private readonly pendingOrder: string[] = [];
  /** Transcript `promptId` (turn id) -> our Prompt.id */
  private readonly promptByTurn = new Map<string, string>();
  /** Agent/Task tool_use id -> Prompt.id it was launched under */
  private readonly agentCallPrompt = new Map<string, string>();
  private currentPromptId: string | undefined;
  /** Text of the most recent assistant message in the current turn (rationale fallback). */
  private lastAssistantText = '';

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  consume(line: TranscriptLine, sidechainPromptId: string | null): void {
    this.trackMeta(line);
    switch (line.type) {
      case 'ai-title':
        if (typeof line.aiTitle === 'string' && line.aiTitle.trim()) this.title = line.aiTitle.trim();
        return;
      case 'summary':
        if (typeof line.summary === 'string' && line.summary.trim()) this.summaryTitle = line.summary.trim();
        return;
      case 'user':
        this.consumeUser(line, sidechainPromptId);
        return;
      case 'assistant':
        this.consumeAssistant(line, sidechainPromptId);
        return;
      default:
        return;
    }
  }

  /**
   * Which prompt a subagent transcript belongs to: the Agent call's prompt
   * (via meta.json toolUseId), else the turn id on its first line, else the
   * last prompt that started before the subagent did.
   */
  async resolveSubagentPrompt(file: string, toolUseId: string | undefined): Promise<string> {
    if (toolUseId) {
      const viaAgentCall = this.agentCallPrompt.get(toolUseId);
      if (viaAgentCall) return viaAgentCall;
    }
    const peek = await peekTranscript(file);
    if (peek.promptId) {
      const viaTurn = this.promptByTurn.get(peek.promptId);
      if (viaTurn) return viaTurn;
    }
    if (peek.timestamp) {
      const t = Date.parse(peek.timestamp);
      let best: Prompt | undefined;
      for (const p of this.prompts) if (Date.parse(p.at) <= t) best = p;
      if (best) return best.id;
    }
    return this.currentPromptId ?? this.unknownPromptId();
  }

  /**
   * A big tool-result line (screenshots, file dumps, web pages) only matters
   * when it answers a call that may have changed files. Checked on the raw
   * text so the line is never JSON-parsed; this is most of the parse time on
   * sessions that drive a browser or read large files.
   */
  canSkip(raw: Buffer): boolean {
    if (raw.length < SKIP_MIN_LINE || !raw.includes('"tool_result"') || !raw.includes('"type":"user"')) return false;
    let any = false;
    for (let at = raw.indexOf(TOOL_USE_ID); at !== -1; at = raw.indexOf(TOOL_USE_ID, at + 1)) {
      const from = at + TOOL_USE_ID.length;
      const to = raw.indexOf(0x22 /* " */, from);
      if (to === -1) return false;
      any = true;
      if (this.pending.has(raw.toString('latin1', from, to))) return false;
    }
    return any;
  }

  build(transcriptPath: string, fallbackTime: Date): Session {
    // Calls that never got a result were interrupted, denied, or are still
    // running: do not let them explain hunks.
    for (const id of this.pendingOrder) {
      const call = this.pending.get(id);
      if (call) this.emitEdits(call, { isError: true, text: 'no tool_result recorded', result: undefined });
    }
    this.pending.clear();
    this.pendingOrder.length = 0;
    const fallbackIso = fallbackTime.toISOString();
    return {
      id: this.sessionId,
      harness: HARNESS,
      cwd: this.cwd,
      path: transcriptPath,
      startedAt: this.firstTs ?? fallbackIso,
      endedAt: this.lastTs ?? fallbackIso,
      ...(this.title ?? this.summaryTitle ? { title: this.title ?? this.summaryTitle } : {}),
      prompts: this.prompts,
      edits: this.edits,
    };
  }

  // -- line handlers --------------------------------------------------------

  private trackMeta(line: TranscriptLine): void {
    if (!this.cwd && typeof line.cwd === 'string' && line.cwd) this.cwd = line.cwd;
    if (typeof line.sessionId === 'string' && line.sessionId && !line.isSidechain && this.sessionId !== line.sessionId) {
      // Trust the transcript over the file name (e.g. a renamed/copied file).
      if (this.prompts.length === 0 && this.edits.length === 0) this.sessionId = line.sessionId;
    }
    if (typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp))) {
      if (!this.firstTs || line.timestamp < this.firstTs) this.firstTs = line.timestamp;
      if (!this.lastTs || line.timestamp > this.lastTs) this.lastTs = line.timestamp;
    }
  }

  private consumeUser(line: TranscriptLine, sidechainPromptId: string | null): void {
    const content = line.message?.content;
    const results = Array.isArray(content)
      ? content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
      : [];
    if (results.length > 0) {
      for (const r of results) {
        if (!r.tool_use_id) continue;
        this.resolveCall(r.tool_use_id, {
          isError: r.is_error === true,
          text: blockText(r.content),
          // toolUseResult is per line; only trust it when the line holds one result.
          result: results.length === 1 && isRecord(line.toolUseResult) ? (line.toolUseResult as EditToolResult) : undefined,
        });
      }
      return;
    }
    if (sidechainPromptId !== null || line.isSidechain) return; // subagent task prompt, not a human
    const text = humanPromptText(line);
    if (text === null) return;
    const index = this.prompts.length;
    const id = `${this.sessionId}:${index}`;
    this.prompts.push({
      id,
      sessionId: this.sessionId,
      harness: HARNESS,
      index,
      at: line.timestamp ?? this.lastTs ?? new Date(0).toISOString(),
      text,
    });
    if (line.promptId) this.promptByTurn.set(line.promptId, id);
    this.currentPromptId = id;
    this.lastAssistantText = '';
  }

  private consumeAssistant(line: TranscriptLine, sidechainPromptId: string | null): void {
    const content = line.message?.content;
    const blocks: ContentBlock[] = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : [];
    const textParts: string[] = [];
    let sawToolUse = false;
    for (const block of blocks) {
      if (block.type === 'text') {
        const t = (block as TextBlock).text;
        if (typeof t === 'string' && t.trim()) textParts.push(t.trim());
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const tool = block as ToolUseBlock;
      if (!tool.id || !tool.name) continue;
      sawToolUse = true;
      const promptId =
        sidechainPromptId ??
        (line.promptId ? this.promptByTurn.get(line.promptId) : undefined) ??
        this.currentPromptId ??
        this.unknownPromptId();
      if (AGENT_TOOLS.has(tool.name)) this.agentCallPrompt.set(tool.id, promptId);
      if (!mayEdit(tool.name)) continue; // only file-changing calls wait for their result
      const rationaleSource = textParts.length ? textParts.join('\n') : this.lastAssistantText;
      const call: PendingCall = {
        toolUseId: tool.id,
        name: tool.name,
        input: isRecord(tool.input) ? tool.input : {},
        at: line.timestamp ?? this.lastTs ?? new Date(0).toISOString(),
        promptId,
        rationale: rationaleSource ? truncate(rationaleSource, RATIONALE_MAX) : undefined,
        cwd: typeof line.cwd === 'string' && line.cwd ? line.cwd : this.cwd,
      };
      this.pending.set(tool.id, call);
      this.pendingOrder.push(tool.id);
    }
    if (textParts.length) this.lastAssistantText = textParts.join('\n');
    else if (!sawToolUse) this.lastAssistantText = '';
  }

  private resolveCall(toolUseId: string, outcome: ToolOutcome): void {
    const call = this.pending.get(toolUseId);
    if (!call) return; // result for a call we never saw (compaction, truncated file)
    this.pending.delete(toolUseId);
    const idx = this.pendingOrder.indexOf(toolUseId);
    if (idx !== -1) this.pendingOrder.splice(idx, 1);
    this.emitEdits(call, outcome);
  }

  // -- edit extraction -------------------------------------------------------

  private emitEdits(call: PendingCall, outcome: ToolOutcome): void {
    const failed = outcome.isError || (call.name !== 'Bash' && REJECTION_PATTERNS.some((re) => re.test(outcome.text)));
    const make = (n: number, kind: EditKind, filePath: string, oldText: string | null, newText: string | null, extra: Partial<FileEdit> = {}): FileEdit => ({
      id: `${this.sessionId}:${call.toolUseId}:${n}`,
      sessionId: this.sessionId,
      harness: HARNESS,
      toolUseId: call.toolUseId,
      tool: call.name,
      kind,
      filePath: absolutePath(filePath, call.cwd),
      at: call.at,
      promptId: call.promptId,
      oldText,
      newText,
      ...(call.rationale ? { rationale: call.rationale } : {}),
      ...(failed ? { failed: true } : {}),
      ...extra,
    });

    const input = call.input;
    const result = outcome.result;
    switch (call.name) {
      case 'Edit': {
        const filePath = str(result?.filePath) ?? str(input.file_path);
        if (!filePath) return;
        const oldString = str(result?.oldString) ?? str(input.old_string) ?? '';
        const newString = str(result?.newString) ?? str(input.new_string) ?? '';
        const replaceAll = input.replace_all === true || result?.replaceAll === true;
        const region =
          textsFromStructuredPatch(result?.structuredPatch) ??
          stitchIntoOriginal(str(result?.originalFile), oldString, newString, replaceAll) ??
          { oldText: oldString, newText: newString };
        this.edits.push(make(0, 'edit', filePath, region.oldText, region.newText));
        return;
      }
      case 'MultiEdit': {
        const filePath = str(input.file_path);
        const list = Array.isArray(input.edits) ? input.edits : [];
        if (!filePath) return;
        // Stitch each sub-edit into the file as it stood before that sub-edit.
        let original = str(result?.originalFileContents);
        list.forEach((e, n) => {
          if (!isRecord(e)) return;
          const oldString = str(e.old_string) ?? '';
          const newString = str(e.new_string) ?? '';
          const replaceAll = e.replace_all === true;
          const region = stitchIntoOriginal(original, oldString, newString, replaceAll) ?? { oldText: oldString, newText: newString };
          if (original !== undefined) original = applyReplacement(original, oldString, newString, replaceAll);
          this.edits.push(make(n, 'edit', filePath, region.oldText, region.newText));
        });
        return;
      }
      case 'Write': {
        const filePath = str(result?.filePath) ?? str(input.file_path);
        if (!filePath) return;
        const content = str(input.content) ?? str(result?.content) ?? '';
        const previous = result?.type === 'update' && typeof result.originalFile === 'string' ? result.originalFile : null;
        this.edits.push(make(0, 'write', filePath, previous, content));
        return;
      }
      case 'NotebookEdit': {
        const filePath = str(input.notebook_path);
        if (!filePath) return;
        this.edits.push(make(0, 'edit', filePath, null, str(input.new_source) ?? ''));
        return;
      }
      case 'Bash': {
        const command = str(input.command);
        if (!command) return;
        detectBashMutations(command, call.cwd).forEach((m, n) => {
          this.edits.push(make(n, 'bash', m.path, null, m.content ?? null, { command }));
        });
        return;
      }
      default: {
        // Generic MCP file writers (e.g. mcp__filesystem__write_file).
        if (/write_file|create_file$/i.test(call.name)) {
          const filePath = str(input.path) ?? str(input.file_path);
          const content = str(input.content);
          if (filePath && content !== undefined) this.edits.push(make(0, 'write', filePath, null, content));
        }
      }
    }
  }

  private unknownPromptId(): string {
    return `${this.sessionId}:unknown`;
  }
}

// ---------------------------------------------------------------------------
// Human prompt detection
// ---------------------------------------------------------------------------

/**
 * Plain text of a human prompt, or null when the user line is not one
 * (tool results, hook/system injections, slash-command echoes, meta lines).
 */
export function humanPromptText(line: TranscriptLine): string | null {
  if (line.isSidechain || line.isMeta) return null;
  const raw = blockText(line.message?.content);
  if (line.origin?.kind !== undefined && line.origin.kind !== 'human') return null;
  if (line.promptSource !== undefined && NON_HUMAN_SOURCES.has(line.promptSource)) return null;
  const text = cleanPromptText(raw);
  if (!text) return null;
  const explicitlyHuman = line.origin?.kind === 'human' || (line.promptSource !== undefined && HUMAN_SOURCES.has(line.promptSource));
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    if (explicitlyHuman) return slashCommandText(text);
    // Built-in commands (`/goal <task>`) carry no origin in Claude Code 2.1.x. One
    // with arguments is an instruction the agent acts on, unless it only
    // configures the session (`/clear`, `/compact <focus>`, `/model x`).
    const name = /<command-name>\/?([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return args && !SESSION_COMMANDS.has(name) ? slashCommandText(text) : null;
  }
  if (!explicitlyHuman && NON_HUMAN_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text;
}

/** Strip system reminders and surrounding whitespace. */
export function cleanPromptText(raw: string): string {
  return raw.replace(SYSTEM_REMINDER, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** `<command-name>/foo</command-name><command-args>bar</command-args>` -> "/foo bar". */
function slashCommandText(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  return args ? `${name} ${args}` : name;
}

/** Concatenate the text blocks of a content value. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Whole-line reconstruction of Edit regions
// ---------------------------------------------------------------------------
//
// Edit's old_string/new_string usually start and end in the middle of a line
// (`"/**\n * Grand total: "`), while attribution matches whole lines. The tool
// result lets us recover the full lines of the edited region: Claude Code
// stores a jsdiff `structuredPatch` (full lines with ' ', '-', '+' prefixes)
// and the `originalFile`; MultiEdit stores `originalFileContents`.

/** Before/after lines from a `structuredPatch` (context in both, '-' in old, '+' in new); null when absent/empty. */
function textsFromStructuredPatch(patch: unknown): RegionTexts | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const oldParts: string[] = [];
  const newParts: string[] = [];
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const raw of hunk.lines) {
      if (typeof raw !== 'string' || raw.startsWith('\\')) continue; // "\ No newline at end of file"
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === ' ' || marker === '-') oldLines.push(text);
      if (marker === ' ' || marker === '+') newLines.push(text);
    }
    if (oldLines.length || newLines.length) {
      oldParts.push(oldLines.join('\n'));
      newParts.push(newLines.join('\n'));
    }
  }
  if (oldParts.length === 0) return null;
  return { oldText: oldParts.join('\n'), newText: newParts.join('\n') };
}

/**
 * Expand a substring replacement to whole lines of `original`: the text before
 * `oldString` on its first line and after it on its last line are kept on both
 * sides, so a mid-line boundary yields the real composite lines. Overlapping
 * occurrences (replace_all) are merged into one region. Null when the string
 * is not found or no original is known.
 */
function stitchIntoOriginal(original: string | undefined, oldString: string, newString: string, replaceAll: boolean): RegionTexts | null {
  if (original === undefined || oldString.length === 0) return null;
  const ranges: Array<[number, number]> = [];
  for (let p = original.indexOf(oldString); p !== -1; p = replaceAll ? original.indexOf(oldString, p + oldString.length) : -1) {
    const lineStart = original.lastIndexOf('\n', p - 1) + 1;
    const end = p + oldString.length;
    const nl = original.indexOf('\n', end);
    const lineEnd = nl === -1 ? original.length : nl;
    const last = ranges[ranges.length - 1];
    if (last && lineStart <= last[1]) last[1] = Math.max(last[1], lineEnd);
    else ranges.push([lineStart, lineEnd]);
  }
  if (ranges.length === 0) return null;
  const oldParts: string[] = [];
  const newParts: string[] = [];
  for (const [a, b] of ranges) {
    const region = original.slice(a, b);
    oldParts.push(region);
    newParts.push(applyReplacement(region, oldString, newString, replaceAll));
  }
  return { oldText: oldParts.join('\n'), newText: newParts.join('\n') };
}

/** `text` with `oldString` replaced by `newString` (first occurrence, or all), with no `$` pattern expansion. */
function applyReplacement(text: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString.length === 0) return text;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Stream a JSONL file, calling `fn` for every parseable line. */
/**
 * Stream a JSONL file, calling `fn` for every parseable line. Lines are split
 * on raw bytes so `skip` can reject a big line before it is decoded to a
 * string, let alone parsed.
 */
async function forEachLine(file: string, fn: (line: TranscriptLine) => void, skip?: (raw: Buffer) => boolean): Promise<void> {
  const handle = (line: Buffer): void => {
    let end = line.length;
    if (end > 0 && line[end - 1] === 0x0d) end--; // CRLF
    if (end === 0 || line[0] !== 0x7b /* { */) return;
    const raw = end === line.length ? line : line.subarray(0, end);
    if (skip?.(raw)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (isRecord(parsed)) fn(parsed as TranscriptLine);
  };
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  let partial: Buffer[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1) {
          if (start < chunk.length) partial.push(chunk.subarray(start));
          break;
        }
        const piece = chunk.subarray(start, nl);
        handle(partial.length ? Buffer.concat([...partial, piece]) : piece);
        partial = [];
        start = nl + 1;
      }
    }
    if (partial.length) handle(Buffer.concat(partial));
  } finally {
    stream.destroy();
  }
}

interface Peek {
  cwd?: string;
  timestamp?: string;
  promptId?: string;
}

/** Read the first lines of a transcript for cwd / first timestamp / turn id. */
async function peekTranscript(file: string): Promise<Peek> {
  const peek: Peek = {};
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of rl) {
      if (++n > PEEK_LINES) break;
      if (!raw || raw[0] !== '{') continue;
      let o: unknown;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(o)) continue;
      if (!peek.cwd && typeof o.cwd === 'string' && o.cwd) peek.cwd = o.cwd;
      if (!peek.timestamp && typeof o.timestamp === 'string') peek.timestamp = o.timestamp;
      if (!peek.promptId && typeof o.promptId === 'string') peek.promptId = o.promptId;
      if (peek.cwd && peek.timestamp && peek.promptId) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return peek;
}

async function listSubagentFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readMeta(file: string): Promise<SubagentMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(parsed) ? { toolUseId: str(parsed.toolUseId) } : null;
  } catch {
    return null;
  }
}

/** The root as given plus its realpath (macOS `/var` -> `/private/var`). */
async function rootVariants(root: string): Promise<string[]> {
  const normalised = path.resolve(root);
  const variants = new Set<string>([normalised]);
  try {
    variants.add(await realpath(normalised));
  } catch {
    // root may not exist (tests with synthetic paths)
  }
  return [...variants];
}

async function isInside(roots: string[], cwd: string): Promise<boolean> {
  const candidates = new Set<string>([path.resolve(cwd)]);
  try {
    candidates.add(await realpath(cwd));
  } catch {
    // cwd no longer exists; compare the string only
  }
  for (const root of roots) {
    for (const c of candidates) {
      if (c === root || c.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
    }
  }
  return false;
}

/** True when `cwd` is a strict ancestor of one of `roots`. */
async function isAncestor(cwd: string, roots: string[]): Promise<boolean> {
  const candidates = new Set<string>([path.resolve(cwd)]);
  try {
    candidates.add(await realpath(cwd));
  } catch {
    // cwd no longer exists; compare the string only
  }
  for (const c of candidates) {
    const prefix = c.endsWith(path.sep) ? c : c + path.sep;
    if (roots.some((r) => r.startsWith(prefix))) return true;
  }
  return false;
}

function absolutePath(p: string, cwd: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return cwd ? path.resolve(cwd, p) : p;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
