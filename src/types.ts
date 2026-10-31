/**
 * why-diff core contracts. Every module codes against these types.
 * Keep this file dependency-free.
 */

/** Which agent harness produced a session. */
export type Harness = 'claude-code' | 'codex' | 'opencode';

/** A human prompt (one user turn) inside an agent session. */
export interface Prompt {
  /** Stable id: `${sessionId}:${index}` */
  id: string;
  sessionId: string;
  harness: Harness;
  /** 0-based index of the human prompt in the session */
  index: number;
  /** ISO timestamp */
  at: string;
  /** Plain text the human typed (attachments/system reminders stripped) */
  text: string;
}

/** What kind of file mutation a tool call performed. */
export type EditKind = 'edit' | 'write' | 'patch' | 'bash';

/**
 * One file mutation performed by the agent, normalised across harnesses.
 * A single tool call that touches several files yields several FileEdits.
 */
export interface FileEdit {
  /** Stable id: `${sessionId}:${toolUseId}:${n}` */
  id: string;
  sessionId: string;
  harness: Harness;
  /** Tool call id from the transcript (e.g. toolu_...) */
  toolUseId: string;
  /** Tool name as recorded (Edit, Write, MultiEdit, apply_patch, Bash, ...) */
  tool: string;
  kind: EditKind;
  /** Absolute path of the touched file (best effort for bash) */
  filePath: string;
  /** ISO timestamp of the tool call */
  at: string;
  /** Id of the human Prompt this call was made in response to */
  promptId: string;
  /** Text that was replaced (edit) or null (write/create) */
  oldText: string | null;
  /** Text that was written in its place; for write = whole file; for bash = null */
  newText: string | null;
  /** For bash: the command line */
  command?: string;
  /** The assistant's own short explanation right before/with the call, if any (<= 500 chars) */
  rationale?: string;
  /** True when the tool call failed / was rejected (should not be attributed) */
  failed?: boolean;
}

/**
 * A FileEdit without its text bodies (`oldText`, `newText`, `command`): what a
 * hunk carries about each edit that explains it. The full record, texts cut
 * to `EDIT_TEXT_CAP`, lives once in `Report.edits`, keyed by `id`.
 */
export type EditRef = Omit<FileEdit, 'oldText' | 'newText' | 'command'>;

/** A FileEdit as stored in `Report.edits`: `oldText`, `newText` and `command` are cut to `EDIT_TEXT_CAP`. */
export interface ReportEdit extends FileEdit {
  /** True when any text field was cut to fit the report */
  truncated?: boolean;
}

/** Characters kept per `oldText` / `newText` / `command` in `Report.edits`, and per diff line text. */
export const EDIT_TEXT_CAP = 2048;

/** A parsed agent session. */
export interface Session {
  id: string;
  harness: Harness;
  /** Working directory the session ran in */
  cwd: string;
  /** Source transcript path */
  path: string;
  startedAt: string;
  endedAt: string;
  title?: string;
  prompts: Prompt[];
  edits: FileEdit[];
}

/** One line inside a diff hunk. */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  /** Line number in old file (del/ctx) */
  oldNo?: number;
  /** Line number in new file (add/ctx) */
  newNo?: number;
  /** True when `text` was cut to `EDIT_TEXT_CAP` characters for the report (minified / data lines) */
  truncated?: boolean;
}

/** One hunk of a unified git diff. */
export interface Hunk {
  /** Stable id within a report, e.g. `h12` */
  id: string;
  /** Repo-relative path (new path; old path for deletions) */
  file: string;
  oldFile?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

/** How confident the hunk->edit match is. */
export type MatchStrength = 'exact' | 'partial' | 'file-only' | 'none';

/** Deterministic labels attached to hunks. */
export type LabelKind =
  | 'test-modified'        // a test file changed
  | 'test-skip-added'      // .skip / .only / xit / @pytest.mark.skip / t.Skip added
  | 'tests-disabled'       // tests turned off: config excludes, swallowed failures, renamed or deleted test files
  | 'assertion-removed'    // expect/assert lines removed or weakened
  | 'snapshot-updated'     // snapshot file changed
  | 'dependency-added'     // new dependency in a manifest
  | 'lockfile'             // lockfile churn
  | 'config-changed'       // tsconfig/eslint/ci/build config changed
  | 'ci-changed'           // .github/workflows etc.
  | 'lint-suppressed'      // eslint-disable / @ts-ignore / @ts-expect-error / noqa added
  | 'type-any-added'       // `any` / `as unknown as` added in TS
  | 'secret-like'          // high-entropy / key-looking string added
  | 'unattributed'         // no agent edit explains this hunk (human or unknown tool)
  | 'out-of-scope'         // file never mentioned in prompts and not near other touched files (heuristic)
  | 'bash-edit'            // produced via shell command, low-confidence attribution
  | 'protected-path';      // agent edit under a path the team marked protected (.why-diff.json)

export interface Label {
  kind: LabelKind;
  severity: 'info' | 'warn' | 'risk';
  /** Short human explanation */
  detail: string;
}

/** Result of the optional LLM intent check. */
export interface IntentVerdict {
  verdict: 'requested' | 'implied' | 'unrequested' | 'unclear';
  /** <= 200 chars, why */
  reason: string;
  /** Model that produced it */
  model: string;
}

/** A hunk with its provenance. */
export interface AttributedHunk {
  hunk: Hunk;
  match: MatchStrength;
  /** Share of added lines explained by agent edits, 0..1 */
  coverage: number;
  /** Ids of the edits that explain this hunk (keys of `Report.edits`), oldest first */
  editIds: string[];
  /** The same edits without their text bodies, same order: tool, time, harness, rationale (command and texts are in `Report.edits`) */
  edits: EditRef[];
  /** The prompt the (latest) explaining edit answered */
  prompt?: Prompt;
  labels: Label[];
  intent?: IntentVerdict;
}

/** Aggregates for the report header. */
export interface Summary {
  hunks: number;
  files: number;
  addedLines: number;
  removedLines: number;
  /** Added lines explained by an agent edit */
  agentLines: number;
  /** Added lines with no agent explanation */
  unattributedLines: number;
  /** Hunks by intent verdict (only when classify ran) */
  intent?: Record<IntentVerdict['verdict'], number>;
  /**
   * Count by label kind. File-level kinds (see `FILE_LEVEL_LABELS`) count
   * distinct files, so a test file split into 30 segments is one
   * `test-modified`; line-level kinds count hunks.
   */
  labels: Partial<Record<LabelKind, number>>;
  /** True if any test-modified / test-skip-added / assertion-removed / tests-disabled */
  touchedTests: boolean;
  /** Sessions that contributed at least one edit or prompt to this diff */
  sessions: number;
  /** Sessions discovered and parsed in the window, including read-only ones */
  sessionsFound: number;
  /** Prompts that own at least one hunk */
  prompts: number;
}

/**
 * Labels that describe the file rather than the changed lines. Renderers
 * report them once per file (aggregating split segments); the others stay per hunk.
 */
export const FILE_LEVEL_LABELS: ReadonlySet<LabelKind> = new Set<LabelKind>([
  'test-modified',
  'snapshot-updated',
  'lockfile',
  'config-changed',
  'ci-changed',
  'out-of-scope',
  'dependency-added',
  'protected-path',
]);

export interface Report {
  /** JSON shape version; bumped on breaking changes */
  schemaVersion: 1;
  /** Tool version */
  version: string;
  generatedAt: string;
  repo: { root: string; name: string; branch?: string };
  /** What was diffed, e.g. "main...HEAD" or "working tree" */
  range: string;
  /**
   * `provenance`: agent sessions were found and hunks are traced to prompts.
   * `risk-scan`: no transcripts at all (a reviewer's machine, CI), so only the
   * deterministic labels apply and `unattributed` labels are dropped.
   */
  mode: 'provenance' | 'risk-scan';
  /** Sessions that contributed to this diff (see `Summary.sessionsFound` for the number discovered) */
  sessions: Pick<Session, 'id' | 'harness' | 'path' | 'startedAt' | 'endedAt' | 'title'>[];
  /** Prompts that own at least one hunk */
  prompts: Prompt[];
  /** Every edit some hunk references, once, keyed by id; texts cut to `EDIT_TEXT_CAP` */
  edits: Record<string, ReportEdit>;
  hunks: AttributedHunk[];
  summary: Summary;
}

export interface DiscoverOptions {
  since?: Date;
  until?: Date;
  /** Home directory to look under (tests) */
  home?: string;
  /**
   * Also consider transcripts whose cwd is outside the repo (a sibling folder,
   * a workspace root) when they mention a file under `repoRoot`. Costs a byte
   * scan of every transcript modified in the window.
   */
  scanAll?: boolean;
  /** Other checkouts of the same repo (git worktrees); sessions started there count like ones in the repo root. */
  extraRoots?: string[];
}

/** Adapter contract: find & parse sessions for a repo. */
export interface SessionAdapter {
  harness: Harness;
  /** Return transcript paths whose cwd is inside `repoRoot` and that overlap [since, until] */
  discover(repoRoot: string, opts?: DiscoverOptions): Promise<string[]>;
  parse(path: string): Promise<Session>;
}

/** Classifier contract (LLM backend is pluggable). */
export interface IntentClassifier {
  name: string;
  classify(input: { prompts: Prompt[]; hunks: AttributedHunk[] }): Promise<Map<string, IntentVerdict>>;
}
