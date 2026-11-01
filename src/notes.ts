/**
 * Provenance as git notes (`refs/notes/why-diff`): the author records which prompt produced each
 * hunk (`why-diff notes`), pushes the notes ref, and a reviewer or CI without the transcripts reads
 * it back. A note is untrusted input: its shape is validated, its size capped, its text sanitised,
 * and it never sets labels (those are always computed from the diff).
 */
import { spawn } from 'node:child_process';
import { git, hardenedInvocation, mergeBase, type DiffTarget } from './git.js';
import { redactSecrets } from './redact.js';
import { stripControls } from './report/shared.js';
import type { AttributedHunk, Harness, LabelKind, MatchStrength, Prompt, Report, Session } from './types.js';

export const NOTES_REF = 'refs/notes/why-diff';
/** Notes bigger than this are ignored when read, and refused when written. */
export const NOTE_MAX_BYTES = 1_000_000;
/** Characters of prompt text kept in a note. */
export const NOTE_PROMPT_CHARS = 1500;
/** Commits of a range whose notes are read, newest first. */
const MAX_NOTED_COMMITS = 50;
const MAX_RANGE_COMMITS = 2000;
const MAX_HUNKS = 20_000;
/** Noted hunks read across all notes of a range (newest notes first). */
export const MAX_NOTED_HUNKS = 50_000;
const MAX_PATH = 4096;
/** `IntentVerdict.model` for a verdict that came from a note, not from an intent check run here. */
export const NOTE_MODEL = 'git-notes';

export interface NotePrompt {
  id: string;
  sessionId: string;
  harness: Harness;
  index: number;
  at: string;
  text: string;
}

export interface NoteHunk {
  file: string;
  newStart: number;
  newLines: number;
  match: MatchStrength;
  coverage: number;
  verdict?: Verdict;
  /** Label kinds the author's report had: information only, never used for decisions */
  labels: string[];
  promptId?: string;
}

export interface ProvenanceNote {
  whyDiffNote: 1;
  /** why-diff version that wrote it */
  tool: string;
  generatedAt: string;
  range: string;
  prompts: NotePrompt[];
  hunks: NoteHunk[];
}

type Verdict = 'requested' | 'implied' | 'unrequested' | 'unclear';
const HARNESSES: ReadonlySet<string> = new Set<Harness>(['claude-code', 'codex', 'opencode']);
const MATCHES: ReadonlySet<string> = new Set<MatchStrength>(['exact', 'partial', 'file-only', 'none']);
const VERDICTS: ReadonlySet<string> = new Set<Verdict>(['requested', 'implied', 'unrequested', 'unclear']);
const LABEL_KINDS: ReadonlySet<string> = new Set<LabelKind>([
  'test-modified', 'test-skip-added', 'tests-disabled', 'assertion-removed', 'snapshot-updated', 'dependency-added', 'lockfile',
  'config-changed', 'ci-changed', 'lint-suppressed', 'type-any-added', 'secret-like', 'unattributed', 'out-of-scope', 'bash-edit', 'protected-path', 'unreviewed',
]);

/** The compact provenance of a report (already secret-redacted by the pipeline). */
export function noteFromReport(report: Report): ProvenanceNote {
  const prompts = new Map<string, NotePrompt>();
  const hunks: NoteHunk[] = report.hunks.map((h) => {
    const out: NoteHunk = {
      file: h.hunk.file,
      newStart: h.hunk.newStart,
      newLines: h.hunk.newLines,
      match: h.match,
      coverage: h.coverage,
      labels: [...new Set(h.labels.map((l) => l.kind))],
    };
    if (h.intent) out.verdict = h.intent.verdict;
    if (h.prompt) {
      out.promptId = h.prompt.id;
      if (!prompts.has(h.prompt.id)) {
        const p = h.prompt;
        prompts.set(p.id, { id: p.id, sessionId: p.sessionId, harness: p.harness, index: p.index, at: p.at, text: cut(p.text, NOTE_PROMPT_CHARS) });
      }
    }
    return out;
  });
  return { whyDiffNote: 1, tool: report.version, generatedAt: report.generatedAt, range: report.range, prompts: [...prompts.values()], hunks };
}

/** Store `note` on `rev` (default HEAD), replacing any earlier why-diff note there. Returns the commit sha. */
export async function writeNote(root: string, note: ProvenanceNote, rev = 'HEAD'): Promise<string> {
  const body = JSON.stringify(note);
  if (Buffer.byteLength(body) > NOTE_MAX_BYTES) {
    throw new Error(`the provenance note would be ${Buffer.byteLength(body)} bytes, over the ${NOTE_MAX_BYTES}-byte limit readers accept; narrow it with --since or --session`);
  }
  const sha = await git(root, ['rev-parse', '--verify', `${rev}^{commit}`]);
  try {
    await gitWithInput(root, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', '-', sha], body);
  } catch (err) {
    // A note is a commit on the notes ref, so git needs an author identity.
    if (/Please tell me who you are|Author identity unknown|auto-detection is disabled|empty ident/i.test((err as Error).message)) {
      throw new Error('git has no author identity for the notes commit; set one with git config user.name "Your Name" and git config user.email you@example.com, then run why-diff notes again');
    }
    throw err;
  }
  return sha;
}

/**
 * Validate and sanitise a note. Null when it is not a why-diff note at all; invalid hunks and
 * prompts inside a valid note are dropped one by one.
 */
export function parseNote(text: string): ProvenanceNote | null {
  if (text.length > NOTE_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.whyDiffNote !== 1 || !Array.isArray(raw.hunks) || !Array.isArray(raw.prompts)) return null;
  const prompts: NotePrompt[] = [];
  const ids = new Set<string>();
  for (const p of raw.prompts.slice(0, MAX_HUNKS)) {
    if (!isRecord(p)) continue;
    const { id, sessionId, harness, index, at, text: t } = p;
    if (typeof id !== 'string' || typeof sessionId !== 'string' || typeof harness !== 'string' || !HARNESSES.has(harness)) continue;
    if (typeof t !== 'string' || typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    if (!Number.isInteger(index) || (index as number) < 0) continue;
    const cleanId = safeId(id);
    if (!cleanId || ids.has(cleanId)) continue;
    const session = safeId(sessionId);
    if (!session) continue;
    ids.add(cleanId);
    prompts.push({ id: cleanId, sessionId: session, harness: harness as Harness, index: index as number, at: new Date(Date.parse(at)).toISOString(), text: sanitise(t) });
  }
  const hunks: NoteHunk[] = [];
  for (const h of raw.hunks.slice(0, MAX_HUNKS)) {
    if (!isRecord(h)) continue;
    const { file, newStart, newLines, match, coverage, verdict, labels, promptId } = h;
    if (typeof file !== 'string' || !file || file.length > MAX_PATH || /[\0-\x1f\x7f]/.test(file)) continue;
    if (!Number.isInteger(newStart) || (newStart as number) < 0 || !Number.isInteger(newLines) || (newLines as number) < 0) continue;
    if (typeof match !== 'string' || !MATCHES.has(match)) continue;
    const out: NoteHunk = {
      file,
      newStart: newStart as number,
      newLines: newLines as number,
      match: match as MatchStrength,
      coverage: typeof coverage === 'number' && Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : 0,
      labels: Array.isArray(labels) ? [...new Set(labels.filter((l): l is string => typeof l === 'string' && LABEL_KINDS.has(l)))] : [],
    };
    if (typeof verdict === 'string' && VERDICTS.has(verdict)) out.verdict = verdict as Verdict;
    if (typeof promptId === 'string' && ids.has(safeId(promptId) ?? '')) out.promptId = safeId(promptId);
    hunks.push(out);
  }
  return {
    whyDiffNote: 1,
    tool: typeof raw.tool === 'string' ? sanitise(raw.tool).slice(0, 40) : '',
    generatedAt: typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)) ? new Date(Date.parse(raw.generatedAt)).toISOString() : new Date(0).toISOString(),
    range: typeof raw.range === 'string' ? sanitise(raw.range).slice(0, 200) : '',
    prompts,
    hunks,
  };
}

/**
 * Notes on the commits of `target` (newest first), read from the local `refs/notes/why-diff`
 * (fetching it is the caller's job). Notes over {@link NOTE_MAX_BYTES} or not valid are skipped.
 * Plain working-tree targets have no commits of their own and get none.
 */
export async function readNotes(root: string, target: DiffTarget): Promise<ProvenanceNote[]> {
  const range = await commitRange(root, target);
  if (!range) return [];
  let listing: string;
  try {
    listing = await git(root, ['notes', `--ref=${NOTES_REF}`, 'list']);
  } catch {
    return []; // no notes ref
  }
  const blobByCommit = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64})$/.exec(line.trim());
    if (m) blobByCommit.set(m[2]!, m[1]!);
  }
  if (!blobByCommit.size) return [];
  const commits = (await git(root, ['rev-list', `--max-count=${MAX_RANGE_COMMITS}`, ...range]).catch(() => '')).split('\n').filter(Boolean);
  const out: ProvenanceNote[] = [];
  for (const c of commits) {
    if (out.length >= MAX_NOTED_COMMITS) break;
    const blob = blobByCommit.get(c);
    if (!blob) continue;
    try {
      const size = Number(await git(root, ['cat-file', '-s', blob]));
      if (!(size <= NOTE_MAX_BYTES)) continue;
      const note = parseNote(await git(root, ['cat-file', 'blob', blob], { trim: false }));
      if (note) out.push(note);
    } catch {
      // unreadable blob: skip
    }
  }
  return out;
}

/**
 * Give hunks that a note covers (same file, overlapping new-side line range) that note's prompt,
 * match and verdict, marked `source: 'notes'`. The newest note with an overlapping hunk wins.
 * Labels are left alone. Returns the hunks plus the prompts and pseudo-sessions now referenced.
 */
export function applyNotes(hunks: AttributedHunk[], notes: ProvenanceNote[]): { hunks: AttributedHunk[]; prompts: Prompt[]; sessions: Session[]; applied: number } {
  // Per file, every noted hunk sorted by start line with a running maximum of end lines, so a diff
  // hunk finds its overlaps by binary search instead of a scan. Notes are read newest first, up to
  // MAX_NOTED_HUNKS hunks in all; among overlapping noted hunks the first in that order wins.
  const span = (start: number, lines: number): [number, number] => [start, start + Math.max(lines, 1) - 1];
  type Entry = { h: NoteHunk; note: ProvenanceNote; order: number; start: number; end: number };
  const byFile = new Map<string, Entry[]>();
  let order = 0;
  outer: for (const note of notes) {
    for (const h of note.hunks) {
      if (order >= MAX_NOTED_HUNKS) break outer;
      const [start, end] = span(h.newStart, h.newLines);
      const list = byFile.get(h.file) ?? [];
      list.push({ h, note, order: order++, start, end });
      byFile.set(h.file, list);
    }
  }
  const index = new Map<string, { entries: Entry[]; maxEnd: number[] }>();
  for (const [file, entries] of byFile) {
    entries.sort((a, b) => a.start - b.start || a.order - b.order);
    const maxEnd: number[] = [];
    let m = -Infinity;
    for (const e of entries) maxEnd.push((m = Math.max(m, e.end)));
    index.set(file, { entries, maxEnd });
  }
  const firstOverlap = (file: string, s: number, e: number): Entry | undefined => {
    const idx = index.get(file);
    if (!idx) return undefined;
    // entries[0..hi) start at or before e
    let lo = 0;
    let hi = idx.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (idx.entries[mid]!.start <= e) lo = mid + 1;
      else hi = mid;
    }
    let best: Entry | undefined;
    // walk back while some entry at or before i can still reach s
    for (let i = lo - 1; i >= 0 && idx.maxEnd[i]! >= s; i--) {
      const x = idx.entries[i]!;
      if (x.end >= s && (!best || x.order < best.order)) best = x;
    }
    return best;
  };
  const prompts = new Map<string, Prompt>();
  const sessions = new Map<string, Session>();
  let applied = 0;
  const out = hunks.map((a) => {
    const [s, e] = span(a.hunk.newStart, a.hunk.newLines);
    const hit = firstOverlap(a.hunk.file, s, e);
    if (!hit) return a;
    applied++;
    const next: AttributedHunk = { ...a, match: hit.h.match, coverage: hit.h.coverage, source: 'notes' };
    if (hit.h.verdict) next.intent = { verdict: hit.h.verdict, reason: 'from the author\'s why-diff git note', model: NOTE_MODEL };
    const np = hit.h.promptId ? hit.note.prompts.find((p) => p.id === hit.h.promptId) : undefined;
    if (np) {
      const prompt: Prompt = { id: np.id, sessionId: np.sessionId, harness: np.harness, index: np.index, at: np.at, text: np.text };
      next.prompt = prompt;
      prompts.set(prompt.id, prompt);
      const sess = sessions.get(np.sessionId);
      if (sess) {
        if (np.at < sess.startedAt) sess.startedAt = np.at;
        if (np.at > sess.endedAt) sess.endedAt = np.at;
      } else {
        sessions.set(np.sessionId, { id: np.sessionId, harness: np.harness, cwd: '', path: NOTES_REF, startedAt: np.at, endedAt: np.at, prompts: [], edits: [] });
      }
    }
    return next;
  });
  return { hunks: out, prompts: [...prompts.values()], sessions: [...sessions.values()], applied };
}

/** `rev-list` arguments for the commits a target's diff covers, or null when it covers none. */
async function commitRange(root: string, target: DiffTarget): Promise<string[] | null> {
  if (typeof target === 'string') {
    if (target.startsWith('-')) return null;
    const m = /^(.*?)\.\.\.?(.*)$/.exec(target);
    if (m) {
      const left = m[1] || 'HEAD';
      const right = m[2] || 'HEAD';
      if (left.startsWith('-') || right.startsWith('-')) return null;
      return [right, `^${left}`, '--'];
    }
    return ['HEAD', `^${target}`, '--']; // `<rev>`: rev against the working tree
  }
  if (target.baseRev) return target.baseRev.startsWith('-') ? null : ['HEAD', `^${target.baseRev}`, '--'];
  if (target.base) {
    const mb = await mergeBase(root, target.base, 'HEAD').catch(() => target.base!);
    return ['HEAD', `^${mb}`, '--'];
  }
  return null;
}

/**
 * The one write why-diff makes (`why-diff notes`, run by the user): with the hardened arguments (no
 * hooks, see {@link hardenedInvocation}), but the user's own environment and config, since the notes
 * commit needs their identity.
 */
function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', hardenedInvocation(args).args, { cwd, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`))));
    child.stdin.end(input);
  });
}

function sanitise(text: string): string {
  return redactSecrets(stripControls(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''));
}

/** An id from a note: printable, no spaces, at most 200 characters; null otherwise. */
function safeId(id: string): string | undefined {
  return /^[\w.:@+-]{1,200}$/.test(id) ? id : undefined;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
