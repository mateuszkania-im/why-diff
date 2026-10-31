/**
 * Terminal renderer: compact, colour-aware CLI output.
 *
 * Every emitted line is guaranteed to fit `width` visible columns; colour is
 * applied only after truncation so ANSI sequences are never cut in half.
 */
import pc from 'picocolors';
import type { AttributedHunk, Harness, IntentVerdict, Label, MatchStrength, Report } from '../types.js';
import {
  collectRisks,
  describeSessions,
  groupByPrompt,
  headline,
  hunkCounts,
  lineRange,
  NO_SESSIONS_HINT,
  plural,
  RISK_SCAN_NOTE,
  riskRef,
  shortDate,
  shortDateTime,
  shortSession,
  shortTime,
  sortLabels,
  truncate,
} from './shared.js';

export interface TerminalOptions {
  /** Force colour on/off. Default: auto (respects NO_COLOR, FORCE_COLOR, TTY). */
  color?: boolean;
  /** Visible columns. Default: process.stdout.columns or 80, never below 40. */
  width?: number;
  /** Show rationale quotes and label details under each hunk, and the full risk list. */
  verbose?: boolean;
}

type Style = (s: string) => string;
type Seg = readonly [text: string, style?: Style];

const MIN_WIDTH = 40;
const WIDE_LAYOUT = 100;

export function detectColor(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout?.isTTY)): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

export function detectWidth(): number {
  const cols = process.stdout?.columns;
  return Math.max(MIN_WIDTH, cols && cols > 0 ? cols : 80);
}

/** Visible width in code points (ANSI-free input expected). */
const vlen = (s: string): number => [...s].length;

const GLYPH = {
  risk: '✖',
  warn: '▲',
  info: '○',
  prompt: '❯',
  requested: '✓',
  implied: '≈',
  unrequested: '✗',
  unclear: '?',
  none: '–',
  tests: '⚠',
} as const;

export function renderTerminal(report: Report, opts: TerminalOptions = {}): string {
  const color = opts.color ?? detectColor();
  const width = Math.max(MIN_WIDTH, opts.width ?? detectWidth());
  const verbose = opts.verbose ?? false;
  const c = pc.createColors(color);
  const wide = width >= WIDE_LAYOUT;

  const bold: Style = c.bold;
  const dim: Style = c.dim;
  const id: Style = (s) => s;
  const sevStyle: Record<Label['severity'], Style> = { risk: c.red, warn: c.yellow, info: c.dim };
  const verdictStyle: Record<IntentVerdict['verdict'] | 'none', Style> = {
    requested: c.green,
    implied: c.cyan,
    unrequested: c.red,
    unclear: c.yellow,
    none: c.dim,
  };
  const harnessStyle: Record<Harness, Style> = { 'claude-code': c.magenta, codex: c.cyan, opencode: c.blue };
  const matchStyle: Record<MatchStrength, Style> = { exact: c.dim, partial: c.yellow, 'file-only': c.yellow, none: c.red };

  const out: string[] = [];
  /** Emit one line made of segments, truncated to `width` before styling. */
  const line = (...segs: Seg[]): void => {
    out.push(fit(trimTrailing(segs), width));
  };
  const blank = (): void => {
    out.push('');
  };

  const h = headline(report);
  const s = report.summary;
  const scan = report.mode === 'risk-scan';

  // ---- Title -------------------------------------------------------------
  {
    const left: Seg[] = [
      [scan ? 'why-diff risk scan' : 'why-diff', bold],
      ['  ', id],
      [report.repo.name, bold],
      ['  ', id],
      [report.range, c.cyan],
    ];
    const rightParts = [report.repo.branch, shortDate(report.generatedAt)].filter((x): x is string => Boolean(x));
    const right = rightParts.join(' · ');
    const leftLen = segLen(left);
    if (right && leftLen + 2 + vlen(right) <= width) {
      line(...left, [' '.repeat(width - leftLen - vlen(right)), id], [right, dim]);
    } else {
      line(...left);
    }
  }
  blank();

  // ---- Headline ----------------------------------------------------------
  if (scan) {
    for (const row of wrapWords(RISK_SCAN_NOTE, width - 2)) line(['  ', id], [row, c.yellow]);
    const meta: string[] = [
      `${plural(s.hunks, 'hunk')} in ${plural(s.files, 'file')}`,
      `+${s.addedLines} −${s.removedLines}`,
      h.touchedTests ? `tests touched ${GLYPH.tests}` : 'tests untouched',
    ];
    for (const row of wrapParts(meta.map((m): Seg[] => [[m, dim]]), width - 2)) line(['  ', id], ...row);
  } else {
    const pctStyle: Style = h.tracedPct >= 90 ? c.green : h.tracedPct >= 60 ? c.yellow : c.red;
    const parts: Seg[][] = [];
    parts.push(h.noAddedLines
      ? [['no added lines', dim]]
      : [[`${h.tracedPct}%`, (t) => bold(pctStyle(t))], [' of added lines trace to a prompt', id]]);
    if (h.intentRan) {
      const n = h.unrequestedHunks;
      parts.push(
        n === 0
          ? [['nothing unrequested', c.green]]
          : [[String(n), (t) => bold(c.red(t))], [` ${n === 1 ? 'hunk' : 'hunks'} nobody asked for`, c.red]],
      );
    }
    parts.push(h.touchedTests ? [[`tests touched ${GLYPH.tests}`, (t) => bold(c.yellow(t))]] : [['tests untouched', dim]]);
    if (h.unattributedHunks > 0) {
      parts.push([[String(h.unattributedHunks), (t) => bold(c.yellow(t))], [` unattributed ${h.unattributedHunks === 1 ? 'hunk' : 'hunks'}`, c.yellow]]);
    }
    for (const row of wrapParts(parts, width - 2)) line(['  ', id], ...row);

    const meta: string[] = [
      `${plural(s.hunks, 'hunk')} in ${plural(s.files, 'file')}`,
      `+${s.addedLines} −${s.removedLines}`,
      describeSessions(report),
    ];
    if (s.sessions > 0) meta.push(plural(s.prompts, 'prompt'));
    if (h.classifierModel) meta.push(`intent by ${h.classifierModel}`);
    for (const row of wrapParts(meta.map((m): Seg[] => [[m, dim]]), width - 2)) line(['  ', id], ...row);
    if (s.sessions === 0 && s.hunks > 0) line(['  ', id], [NO_SESSIONS_HINT, c.yellow]);
  }

  // ---- Risks -------------------------------------------------------------
  blank();
  const risks = collectRisks(report, 'warn');
  if (risks.length === 0) {
    line(['RISKS', bold], ['  none', dim]);
  } else {
    line(['RISKS', bold], [` (${risks.length})`, dim]);
    const cap = verbose ? risks.length : 8;
    const fileCol = Math.min(Math.max(...risks.map((r) => vlen(riskRef(r)))), Math.floor(width * 0.45));
    const kindCol = Math.max(...risks.map((r) => vlen(r.label.kind)));
    for (const r of risks.slice(0, cap)) {
      const sev = sevStyle[r.label.severity];
      if (wide) {
        line(
          ['  ', id],
          [GLYPH[r.label.severity], sev],
          [' ', id],
          [pad(tailTrunc(riskRef(r), fileCol), fileCol), id],
          ['  ', id],
          [pad(r.label.kind, kindCol), sev],
          ['  ', id],
          [r.label.detail, dim],
        );
      } else {
        line(['  ', id], [GLYPH[r.label.severity], sev], [' ', id], [r.label.kind, sev], ['  ', id], [riskRef(r), id]);
        line(['      ', id], [r.label.detail, dim]);
      }
    }
    if (risks.length > cap) line(['  ', id], [`… ${risks.length - cap} more (use --verbose)`, dim]);
  }

  // ---- Prompts -----------------------------------------------------------
  const { groups, unattributed } = groupByPrompt(report);
  const allHunks = report.hunks;
  const fileCol = Math.min(Math.max(10, ...allHunks.map((a) => vlen(fileRef(a)))), Math.floor(width * 0.42));
  const countCol = Math.max(5, ...allHunks.map((a) => vlen(countsText(a))));
  const matchCol = Math.max(...allHunks.map((a) => vlen(matchText(a))));
  const verdictCol = Math.max(...allHunks.map((a) => vlen(verdictText(a))));

  const hunkRow = (a: AttributedHunk): void => {
    const labels = sortLabels(a.labels);
    const verdict = a.intent?.verdict ?? 'none';
    const { added, removed } = hunkCounts(a.hunk);
    const counts: Seg[] = [
      [`+${added}`, c.green],
      [removed > 0 ? ` −${removed}` : '', c.red],
    ];
    const countsPad = countCol - vlen(countsText(a));
    const labelSegs: Seg[] = [];
    for (const l of labels) {
      labelSegs.push([' ', id], [GLYPH[l.severity], sevStyle[l.severity]], [' ' + l.kind, sevStyle[l.severity]]);
    }
    if (wide) {
      line(
        ['    ', id],
        [pad(tailTrunc(fileRef(a), fileCol), fileCol), id],
        ['  ', id],
        ...counts,
        [' '.repeat(countsPad), id],
        ['  ', id],
        [pad(matchText(a), matchCol), matchStyle[a.match]],
        ['  ', id],
        [pad(verdictText(a), verdictCol), verdictStyle[verdict]],
        [' ', id],
        ...labelSegs,
      );
    } else {
      line(['    ', id], [fileRef(a), id], ['  ', id], ...counts);
      const extra: Seg[] = [['      ', id], [matchText(a), matchStyle[a.match]], [' · ', dim], [verdictText(a), verdictStyle[verdict]]];
      if (labelSegs.length > 0) extra.push([' ·', dim]);
      line(...extra, ...labelSegs);
    }
    if (verbose) {
      const last = a.edits[a.edits.length - 1];
      const command = last ? report.edits?.[last.id]?.command : undefined;
      if (last?.rationale) line(['      ', id], [`“${truncate(last.rationale, width)}”`, (t) => dim(c.italic(t))]);
      if (command) line(['      ', id], ['$ ' + command, dim]);
      for (const l of labels) line(['        ', id], [GLYPH[l.severity] + ' ' + l.kind + ': ', sevStyle[l.severity]], [l.detail, dim]);
      if (a.intent?.reason) line(['      ', id], [`${GLYPH[verdict]} ${a.intent.reason}`, dim]);
    }
  };

  if (scan) {
    blank();
    line(['CHANGES', bold], [` (${allHunks.length})`, dim]);
    for (const a of allHunks) hunkRow(a);
  } else {
    blank();
    line(['PROMPTS', bold], [` (${groups.length})`, dim]);
    for (const g of groups) {
      const { prompt } = g;
      let added = 0;
      let removed = 0;
      for (const a of g.hunks) {
        const n = hunkCounts(a.hunk);
        added += n.added;
        removed += n.removed;
      }
      const hs = harnessStyle[prompt.harness] ?? id;
      blank();
      line([GLYPH.prompt + ' ', hs], ['“', dim], [truncate(prompt.text, Math.max(20, width - 6)), bold], ['”', dim]);
      const metaSegs: Seg[] = [
        ['  ', id],
        [prompt.harness, hs],
        [' · ', dim],
        [shortTime(prompt.at), dim],
        [' · ', dim],
        [`session ${shortSession(prompt.sessionId)}`, dim],
        [' · ', dim],
        [g.hunks.length === 0 ? 'no hunks in this diff' : plural(g.hunks.length, 'hunk'), g.hunks.length === 0 ? dim : id],
      ];
      if (g.hunks.length > 0) metaSegs.push([' · ', dim], [`+${added}`, c.green], [removed > 0 ? ` −${removed}` : '', c.red]);
      line(...metaSegs);
      for (const a of g.hunks) hunkRow(a);
    }

    // ---- Unattributed ------------------------------------------------------
    blank();
    if (unattributed.length === 0) {
      line(['UNATTRIBUTED', bold], ['  none, every hunk traces to a prompt', dim]);
    } else {
      line(['UNATTRIBUTED', bold], [` (${unattributed.length})`, dim], ['  no agent edit explains these', dim]);
      for (const a of unattributed) hunkRow(a);
    }
  }

  // ---- Footer ------------------------------------------------------------
  blank();
  line([`why-diff v${report.version} · generated ${shortDateTime(report.generatedAt)}`, dim]);

  return out.join('\n') + '\n';
}

// ---- helpers -------------------------------------------------------------

function segLen(segs: readonly Seg[]): number {
  let n = 0;
  for (const [t] of segs) n += vlen(t);
  return n;
}

/** Truncate segments to `width` visible columns, then apply styles. */
function fit(segs: readonly Seg[], width: number): string {
  const total = segLen(segs);
  if (total <= width) return segs.map(([t, st]) => (t && st ? st(t) : t)).join('');
  let budget = width - 1; // leave room for the ellipsis
  const parts: string[] = [];
  for (const [t, st] of segs) {
    if (budget <= 0) break;
    const chars = [...t];
    const take = chars.length <= budget ? t : chars.slice(0, budget).join('');
    budget -= vlen(take);
    if (take) parts.push(st ? st(take) : take);
  }
  return parts.join('') + '…';
}

/** Break plain text into rows of at most `width` columns at spaces. */
function wrapWords(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    if (row && vlen(row) + 1 + vlen(word) > width) {
      rows.push(row);
      row = word;
    } else {
      row = row ? `${row} ${word}` : word;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Lay out segment groups separated by " · ", wrapping to new rows when they would overflow. */
function wrapParts(parts: Seg[][], width: number): Seg[][] {
  const rows: Seg[][] = [];
  let row: Seg[] = [];
  let len = 0;
  for (const p of parts) {
    const l = segLen(p);
    if (row.length > 0 && len + 3 + l > width) {
      rows.push(row);
      row = [];
      len = 0;
    }
    if (row.length > 0) {
      row.push([' · ', (t) => t]);
      len += 3;
    }
    row.push(...p);
    len += l;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Drop whitespace-only trailing segments and trailing spaces of the last text segment. */
function trimTrailing(segs: readonly Seg[]): Seg[] {
  const out = [...segs];
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!last) break;
    const trimmed = last[0].trimEnd();
    if (trimmed === '') {
      out.pop();
      continue;
    }
    if (trimmed !== last[0]) out[out.length - 1] = [trimmed, last[1]];
    break;
  }
  return out;
}

function pad(s: string, w: number): string {
  const l = vlen(s);
  return l >= w ? s : s + ' '.repeat(w - l);
}

/** Keep the tail of a path-like string: "…/formatDate.test.ts:L8-17". */
function tailTrunc(s: string, w: number): string {
  const chars = [...s];
  if (chars.length <= w) return s;
  return '…' + chars.slice(chars.length - (w - 1)).join('');
}

function fileRef(a: AttributedHunk): string {
  return `${a.hunk.file}:${lineRange(a.hunk)}`;
}

function countsText(a: AttributedHunk): string {
  const { added, removed } = hunkCounts(a.hunk);
  return `+${added}${removed > 0 ? ` −${removed}` : ''}`;
}

function matchText(a: AttributedHunk): string {
  if (a.match === 'partial') return `partial ${Math.round(a.coverage * 100)}%`;
  return a.match;
}

function verdictText(a: AttributedHunk): string {
  const v = a.intent?.verdict;
  if (!v) return `${GLYPH.none} no verdict`;
  return `${GLYPH[v]} ${v}`;
}
