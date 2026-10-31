/**
 * Helpers shared by the report renderers. Pure functions, no I/O.
 */
import { FILE_LEVEL_LABELS, type AttributedHunk, type Hunk, type Label, type Prompt, type Report } from '../types.js';

export interface HunkCounts {
  added: number;
  removed: number;
}

export function hunkCounts(h: Hunk): HunkCounts {
  let added = 0;
  let removed = 0;
  for (const l of h.lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** "L12-31" style range, using the new file (old file for deletions). */
export function lineRange(h: Hunk, dash = '-'): string {
  const start = h.status === 'deleted' ? h.oldStart : h.newStart;
  const len = h.status === 'deleted' ? h.oldLines : h.newLines;
  if (len <= 1) return `L${start}`;
  return `L${start}${dash}${start + len - 1}`;
}

/** Hunks grouped by the prompt that produced them, prompts in chronological order. */
export interface PromptGroup {
  prompt: Prompt;
  hunks: AttributedHunk[];
}

export interface Grouped {
  groups: PromptGroup[];
  unattributed: AttributedHunk[];
}

export function groupByPrompt(report: Report): Grouped {
  const byId = new Map<string, PromptGroup>();
  const prompts = [...report.prompts].sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  for (const p of prompts) byId.set(p.id, { prompt: p, hunks: [] });
  const unattributed: AttributedHunk[] = [];
  for (const h of report.hunks) {
    const pid = h.prompt?.id;
    if (!pid) {
      unattributed.push(h);
      continue;
    }
    let g = byId.get(pid);
    if (!g) {
      // Prompt referenced by a hunk but missing from report.prompts: still show it.
      g = { prompt: h.prompt as Prompt, hunks: [] };
      byId.set(pid, g);
    }
    g.hunks.push(h);
  }
  return { groups: [...byId.values()], unattributed };
}

const SEVERITY_ORDER: Record<Label['severity'], number> = { risk: 0, warn: 1, info: 2 };

export function sortLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.kind.localeCompare(b.kind));
}

export interface RiskItem {
  /** First hunk (diff order) carrying the label */
  hunk: AttributedHunk;
  /** Every flagged hunk the row stands for: one for line-level labels, each flagged segment of the file for file-level ones */
  hunks: AttributedHunk[];
  /** Highest severity among the merged labels; details joined with "; " */
  label: Label;
  /** True for file-level labels (see FILE_LEVEL_LABELS), reported once per file */
  fileLevel: boolean;
}

/**
 * All risk/warn labels across the report, risks first, in diff order.
 * File-level labels (a test file changed, a lockfile, CI) are reported once
 * per file, however many segments the file was split into; line-level labels
 * (a skip added, an assertion removed, a secret) stay one row per hunk.
 */
export function collectRisks(report: Report, minSeverity: 'risk' | 'warn' = 'warn'): RiskItem[] {
  const keep = (l: Label): boolean => l.severity === 'risk' || (minSeverity === 'warn' && l.severity === 'warn');
  interface Row extends RiskItem {
    details: string[];
  }
  const rows: Row[] = [];
  const byFile = new Map<string, Row>();
  for (const h of report.hunks) {
    for (const l of h.labels) {
      if (!keep(l)) continue;
      if (!FILE_LEVEL_LABELS.has(l.kind)) {
        rows.push({ hunk: h, hunks: [h], label: l, fileLevel: false, details: [l.detail] });
        continue;
      }
      const key = `${h.hunk.file}\0${l.kind}`;
      const row = byFile.get(key);
      if (!row) {
        const fresh: Row = { hunk: h, hunks: [h], label: { ...l }, fileLevel: true, details: [l.detail] };
        byFile.set(key, fresh);
        rows.push(fresh);
        continue;
      }
      row.hunks.push(h);
      if (SEVERITY_ORDER[l.severity] < SEVERITY_ORDER[row.label.severity]) {
        row.label = { ...l };
        row.details.unshift(l.detail);
      } else if (!row.details.includes(l.detail)) {
        row.details.push(l.detail);
      }
    }
  }
  return rows
    .map(({ details, ...item }): RiskItem => ({ ...item, label: { ...item.label, detail: [...new Set(details)].join('; ') } }))
    .sort((a, b) => SEVERITY_ORDER[a.label.severity] - SEVERITY_ORDER[b.label.severity]);
}

/** "src/a.ts:L12-31" for a single hunk, "src/a.ts (7 hunks)" for an aggregated file-level row. */
export function riskRef(r: RiskItem, dash = '-'): string {
  if (r.hunks.length > 1) return `${r.hunk.hunk.file} (${plural(r.hunks.length, 'hunk')})`;
  return `${r.hunk.hunk.file}:${lineRange(r.hunk.hunk, dash)}`;
}

/** "6 sessions (claude-code)", or why there are none. */
export function describeSessions(report: Report): string {
  const s = report.summary;
  const found = s.sessionsFound ?? s.sessions;
  if (s.sessions > 0) {
    const harnesses = [...new Set(report.sessions.map((x) => x.harness))];
    return `${plural(s.sessions, 'session')}${harnesses.length ? ` (${harnesses.join(', ')})` : ''}`;
  }
  if (found > 0) return `no agent session contributed to this diff (${plural(found, 'session')} found in the window)`;
  return 'no agent sessions found';
}

/** One-line explanation printed under the heading of a risk scan. */
export const RISK_SCAN_NOTE = 'No agent transcripts here, so lines are not traced to prompts. The PR author can add provenance with `why-diff pr`.';

/** What to try when a report has no sessions. */
export const NO_SESSIONS_HINT = 'check the harness (--harness), the time window (--since), pass --session <file>, or use --scan-all for sessions run from another folder';

export function isRisky(h: AttributedHunk): boolean {
  return h.labels.some((l) => l.severity === 'risk') || h.intent?.verdict === 'unrequested';
}

/** Headline figures used by every renderer. */
export interface Headline {
  /** 0..100, share of added lines explained by an agent edit */
  tracedPct: number;
  /** true when the diff adds no lines, so tracedPct is meaningless */
  noAddedLines: boolean;
  unrequestedHunks: number;
  /** undefined when the intent classifier did not run */
  intentRan: boolean;
  unattributedHunks: number;
  /** Risk rows as `collectRisks` reports them (file-level labels once per file) */
  riskLabels: number;
  warnLabels: number;
  touchedTests: boolean;
  harnesses: string[];
  classifierModel?: string;
}

export function headline(report: Report): Headline {
  const s = report.summary;
  const tracedPct = s.addedLines > 0 ? Math.round((s.agentLines / s.addedLines) * 100) : 0;
  const intentRan = Boolean(s.intent) || report.hunks.some((h) => h.intent);
  const unrequestedHunks = s.intent?.unrequested ?? report.hunks.filter((h) => h.intent?.verdict === 'unrequested').length;
  const unattributedHunks = report.hunks.filter((h) => !h.prompt || h.match === 'none').length;
  let riskLabels = 0;
  let warnLabels = 0;
  for (const r of collectRisks(report, 'warn')) {
    if (r.label.severity === 'risk') riskLabels++;
    else warnLabels++;
  }
  const harnesses = [...new Set(report.sessions.map((x) => x.harness))];
  const classifierModel = report.hunks.find((h) => h.intent)?.intent?.model;
  const out: Headline = { tracedPct, noAddedLines: s.addedLines === 0, unrequestedHunks, intentRan, unattributedHunks, riskLabels, warnLabels, touchedTests: s.touchedTests, harnesses };
  if (classifierModel) out.classifierModel = classifierModel;
  return out;
}

/** Collapse whitespace and cut to `max` code points, appending an ellipsis. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  if (max <= ellipsis.length) return ellipsis.slice(0, Math.max(0, max));
  return chars.slice(0, max - ellipsis.length).join('').trimEnd() + ellipsis;
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${shortDate(iso)}, ${shortTime(iso)} UTC`;
}

export function shortSession(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** FNV-1a 32-bit over the stable parts of a report; used to key persisted review state. */
export function reportHash(report: Report): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  feed(report.repo.name);
  feed(report.range);
  for (const a of report.hunks) {
    feed(a.hunk.id);
    feed(a.hunk.file);
    feed(a.hunk.header);
    feed(String(a.hunk.lines.length));
  }
  return h.toString(16).padStart(8, '0');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export const VERDICT_ORDER = ['unrequested', 'unclear', 'implied', 'requested'] as const;
