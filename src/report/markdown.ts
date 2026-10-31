/**
 * Markdown renderer: GitHub-flavoured, for PR descriptions and comments.
 *
 * Risks come first, then a summary table, then one collapsible <details>
 * per prompt. Output is capped (default 60 000 chars) by progressively
 * dropping hunk rows, never by cutting mid-table.
 */
import type { AttributedHunk, Label, Report } from '../types.js';
import {
  collectRisks,
  describeSessions,
  escapeHtml,
  groupByPrompt,
  headline,
  hunkCounts,
  lineRange,
  NO_SESSIONS_HINT,
  plural,
  RISK_SCAN_NOTE,
  shortDateTime,
  shortSession,
  shortTime,
  sortLabels,
  truncate,
  type RiskItem,
} from './shared.js';

export interface MarkdownOptions {
  /** Maximum hunk rows across the whole document. Default 200. */
  maxHunks?: number;
  /** Hard character budget. Default 60 000 (GitHub comment limit is 65 536). */
  maxChars?: number;
  /** Maximum risk rows. Default 30. */
  maxRisks?: number;
  /** Heading level for the top section. Default 2 ("## Provenance"). */
  headingLevel?: 1 | 2 | 3;
}

const DEFAULT_MAX_CHARS = 60_000;

export function renderMarkdown(report: Report, opts: MarkdownOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let maxHunks = Math.max(0, opts.maxHunks ?? 200);
  let maxRisks = Math.max(0, opts.maxRisks ?? 30);
  let md = build(report, { ...opts, maxHunks, maxRisks });
  // Shrink until it fits: halve the row budgets, then drop them entirely.
  while (md.length > maxChars && (maxHunks > 0 || maxRisks > 0)) {
    maxHunks = maxHunks > 4 ? Math.floor(maxHunks / 2) : 0;
    maxRisks = maxRisks > 4 ? Math.floor(maxRisks / 2) : 0;
    md = build(report, { ...opts, maxHunks, maxRisks });
  }
  if (md.length > maxChars) {
    const note = '\n\n_Report truncated to fit the size limit._\n';
    md = md.slice(0, Math.max(0, maxChars - note.length)) + note;
  }
  return md;
}

interface BuildOpts extends MarkdownOptions {
  maxHunks: number;
  maxRisks: number;
}

function build(report: Report, o: BuildOpts): string {
  const H = '#'.repeat(o.headingLevel ?? 2);
  const sub = H + '#';
  const h = headline(report);
  const s = report.summary;
  const out: string[] = [];

  const scan = report.mode === 'risk-scan';
  if (scan) {
    out.push(`${H} why-diff risk scan`);
    out.push('');
    out.push(text(RISK_SCAN_NOTE));
    out.push('');
    const risky = h.riskLabels + h.warnLabels;
    out.push(`> ${risky === 0 ? 'no risks found' : `**${risky}** ${risky === 1 ? 'finding' : 'findings'}`} · ${h.touchedTests ? '**tests touched**' : 'tests untouched'}`);
    out.push('');
  } else {
    out.push(`${H} Provenance`);
    out.push('');
    const headlineBits = [h.noAddedLines ? 'no added lines' : `**${h.tracedPct}%** of added lines trace to a prompt`];
    if (h.intentRan) headlineBits.push(h.unrequestedHunks === 0 ? 'nothing unrequested' : `**${h.unrequestedHunks}** ${h.unrequestedHunks === 1 ? 'hunk' : 'hunks'} nobody asked for`);
    headlineBits.push(h.touchedTests ? '**tests touched**' : 'tests untouched');
    if (h.unattributedHunks > 0) headlineBits.push(`**${h.unattributedHunks}** unattributed ${h.unattributedHunks === 1 ? 'hunk' : 'hunks'}`);
    out.push(`> ${headlineBits.join(' · ')}`);
    out.push('');
  }

  // ---- Risks first -------------------------------------------------------
  const risks = collectRisks(report, 'warn');
  if (risks.length > 0) {
    out.push(`${sub} Risks (${risks.length})`);
    out.push('');
    out.push('| | File | Label | Detail |');
    out.push('|---|---|---|---|');
    for (const r of risks.slice(0, o.maxRisks)) {
      out.push(`| ${badge(r.label.severity)} | ${riskCell(r)} | \`${code(r.label.kind)}\` | ${cell(r.label.detail)} |`);
    }
    if (risks.length > o.maxRisks) out.push(`| | | | _… ${risks.length - o.maxRisks} more not shown_ |`);
    out.push('');
  }

  // ---- Summary table -----------------------------------------------------
  out.push(`${sub} Summary`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Diff | \`${code(report.range)}\` in \`${code(report.repo.name)}\`${report.repo.branch ? ` (\`${code(report.repo.branch)}\`)` : ''} |`);
  if (!scan) {
    out.push(`| Sessions | ${text(describeSessions(report))}${s.sessions === 0 ? `; ${text(NO_SESSIONS_HINT)}` : ''} |`);
    out.push(`| Prompts | ${s.prompts} |`);
  }
  out.push(`| Hunks | ${s.hunks} in ${plural(s.files, 'file')} (+${s.addedLines} −${s.removedLines}) |`);
  if (!scan) {
    out.push(`| Agent-traced lines | ${s.agentLines} of ${s.addedLines} added${h.noAddedLines ? '' : ` (${h.tracedPct}%)`} |`);
    out.push(`| Unattributed lines | ${s.unattributedLines}${h.unattributedHunks > 0 ? ` in ${plural(h.unattributedHunks, 'hunk')}` : ''} |`);
  }
  if (s.intent) {
    const i = s.intent;
    out.push(`| Intent | ${i.requested} requested · ${i.implied} implied · ${i.unrequested} unrequested · ${i.unclear} unclear${h.classifierModel ? ` (${code(h.classifierModel)})` : ''} |`);
  }
  out.push(`| Tests | ${s.touchedTests ? 'touched' : 'untouched'} |`);
  out.push('');

  // ---- Per prompt ----------------------------------------------------------
  const { groups, unattributed } = groupByPrompt(report);
  let budget = o.maxHunks;
  let hidden = 0;

  if (scan) {
    // No prompts to group by: one table of every hunk with its labels.
    out.push(`${sub} Changes (${report.hunks.length})`);
    out.push('');
    const shown = report.hunks.slice(0, Math.max(0, budget));
    hidden += report.hunks.length - shown.length;
    budget -= shown.length;
    if (shown.length > 0) out.push(...hunkTable(shown, false));
    out.push('');
  }

  if (!scan) out.push(`${sub} Prompts`, '');
  for (const g of scan ? [] : groups) {
    const p = g.prompt;
    let added = 0;
    let removed = 0;
    for (const a of g.hunks) {
      const n = hunkCounts(a.hunk);
      added += n.added;
      removed += n.removed;
    }
    const risky = g.hunks.filter((a) => a.labels.some((l) => l.severity === 'risk') || a.intent?.verdict === 'unrequested').length;
    const summaryBits = [
      `<b>${text(p.harness)}</b>`,
      text(shortTime(p.at)),
      `“${text(truncate(p.text, 90))}”`,
      g.hunks.length === 0 ? 'no hunks' : plural(g.hunks.length, 'hunk'),
    ];
    if (risky > 0) summaryBits.push(`<b>${risky} flagged</b>`);
    out.push('<details>');
    out.push(`<summary>${summaryBits.join(' · ')}</summary>`);
    out.push('');
    out.push(`> ${quote(p.text)}`);
    out.push('');
    out.push(`<sub>Session \`${code(shortSession(p.sessionId))}\` · ${escapeHtml(shortDateTime(p.at))}${g.hunks.length > 0 ? ` · +${added}${removed > 0 ? ` −${removed}` : ''}` : ''}</sub>`);
    out.push('');
    if (g.hunks.length > 0) {
      const shown = g.hunks.slice(0, Math.max(0, budget));
      hidden += g.hunks.length - shown.length;
      budget -= shown.length;
      if (shown.length > 0) out.push(...hunkTable(shown));
      if (shown.length < g.hunks.length) out.push(`_… ${g.hunks.length - shown.length} more ${g.hunks.length - shown.length === 1 ? 'hunk' : 'hunks'} not shown_`);
      out.push('');
    }
    out.push('</details>');
    out.push('');
  }

  // ---- Unattributed ------------------------------------------------------
  if (!scan && unattributed.length > 0) {
    out.push(`${sub} Unattributed (${unattributed.length})`);
    out.push('');
    out.push('No agent edit explains these hunks: a human change, a tool outside the recorded sessions, or a generated file.');
    out.push('');
    const shown = unattributed.slice(0, Math.max(0, budget));
    hidden += unattributed.length - shown.length;
    budget -= shown.length;
    if (shown.length > 0) out.push(...hunkTable(shown));
    if (shown.length < unattributed.length) out.push(`_… ${unattributed.length - shown.length} more not shown_`);
    out.push('');
  }

  if (hidden > 0) {
    out.push(`_${plural(hidden, 'hunk')} omitted to keep this comment short. Run \`why-diff --format html\` for the full report._`);
    out.push('');
  }

  out.push(`<sub>Generated by why-diff v${code(report.version)} · ${escapeHtml(shortDateTime(report.generatedAt))}</sub>`);
  return out.join('\n') + '\n';
}

function hunkTable(hunks: AttributedHunk[], provenance = true): string[] {
  const rows = provenance
    ? ['| File | Lines | +/− | Match | Labels | Intent |', '|---|---|---|---|---|---|']
    : ['| File | Lines | +/− | Labels |', '|---|---|---|---|'];
  for (const a of hunks) {
    const { added, removed } = hunkCounts(a.hunk);
    const counts = `+${added}${removed > 0 ? ` −${removed}` : ''}`;
    const match = a.match === 'partial' ? `partial (${Math.round(a.coverage * 100)}%)` : a.match;
    const labels = sortLabels(a.labels)
      .map((l) => `${badge(l.severity)} ${code(l.kind)}`)
      .join('<br>');
    const intent = a.intent ? `${verdictBadge(a.intent.verdict)}` : '—';
    rows.push(provenance
      ? `| \`${code(a.hunk.file)}\` | ${lineRange(a.hunk, '–')} | ${counts} | ${match} | ${labels} | ${intent} |`
      : `| \`${code(a.hunk.file)}\` | ${lineRange(a.hunk, '–')} | ${counts} | ${labels || '—'} |`);
  }
  return rows;
}

function badge(sev: Label['severity']): string {
  return sev === 'risk' ? '**RISK**' : sev === 'warn' ? '**WARN**' : 'info';
}

function verdictBadge(v: NonNullable<AttributedHunk['intent']>['verdict']): string {
  switch (v) {
    case 'requested':
      return 'requested';
    case 'implied':
      return 'implied';
    case 'unrequested':
      return '**UNREQUESTED**';
    case 'unclear':
      return '_unclear_';
  }
}

/** File column of a risk row: line range for one hunk, segment count for a file-level label spanning several. */
function riskCell(r: RiskItem): string {
  if (r.hunks.length > 1) return `\`${code(r.hunk.hunk.file)}\` (${plural(r.hunks.length, 'hunk')})`;
  return `\`${code(r.hunk.hunk.file)}\` ${lineRange(r.hunk.hunk, '–')}`;
}

/**
 * Text inside an inline code span. Entities are shown literally inside code
 * spans, so instead of escaping we swap the few characters that could end
 * the span or open markup for look-alikes: backtick, pipe, < > and newlines.
 */
function code(s: string): string {
  return s.replace(/`/g, 'ˋ').replace(/\|/g, '∣').replace(/</g, '‹').replace(/>/g, '›').replace(/\r?\n/g, ' ');
}

/** Escape only what can open markup in Markdown text; quotes stay readable. */
function text(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Table cell text: escape pipes and HTML, collapse newlines. */
function cell(s: string): string {
  return text(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Blockquote body: escape HTML, keep line breaks as quote continuation. */
function quote(s: string): string {
  return text(s.trim()).split(/\r?\n/).join('\n> ');
}
