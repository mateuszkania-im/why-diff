import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AttributedHunk, Prompt, Report } from '../src/types.js';
import { SECTION_END, SECTION_START, sectionBudget, upsertSection } from '../src/pr.js';
import { renderHtml, renderJson, renderMarkdown, renderReport, renderTerminal, isReportFormat } from '../src/report/index.js';
import { detectColor } from '../src/report/terminal.js';
import { collectRisks, describeSessions, groupByPrompt, headline, reportHash, riskRef, truncate } from '../src/report/shared.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample: Report = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-report.json'), 'utf8'));

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, '');
const vlen = (s: string) => [...s].length;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A nasty payload that must never reach the page unescaped. */
const XSS = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';

function withHostileContent(): Report {
  const r = clone(sample);
  const p = r.prompts[0] as Prompt;
  p.text = `add a toggle ${XSS} please | and a pipe`;
  const h = r.hunks[0] as AttributedHunk;
  h.hunk.file = `components/${XSS}.tsx`;
  h.hunk.lines.push({ type: 'add', text: `const s = "${XSS}"; //   line sep`, newNo: 999 });
  if (h.edits[0]) h.edits[0].rationale = `because ${XSS}`;
  h.labels.push({ kind: 'secret-like', severity: 'risk', detail: `looks like ${XSS} | with pipe` });
  return r;
}

function bigReport(n: number): Report {
  const r = clone(sample);
  const base = r.hunks;
  const hunks: AttributedHunk[] = [];
  for (let i = 0; i < n; i++) {
    const src = clone(base[i % base.length] as AttributedHunk);
    src.hunk.id = `h${i + 1}`;
    src.hunk.file = `src/generated/module-${i}/${src.hunk.file}`;
    hunks.push(src);
  }
  r.hunks = hunks;
  r.summary.hunks = n;
  return r;
}

describe('fixture', () => {
  it('is internally consistent', () => {
    const s = sample.summary;
    expect(sample.hunks).toHaveLength(s.hunks);
    expect(new Set(sample.hunks.map((h) => h.hunk.file)).size).toBe(s.files);
    let added = 0;
    for (const h of sample.hunks) added += h.hunk.lines.filter((l) => l.type === 'add').length;
    expect(added).toBe(s.addedLines);
    expect(s.agentLines + s.unattributedLines).toBe(s.addedLines);
    expect(s.touchedTests).toBe(true);
    expect(sample.sessions.map((x) => x.harness).sort()).toEqual(['claude-code', 'codex']);
    expect(sample.hunks.some((h) => h.labels.some((l) => l.kind === 'test-skip-added'))).toBe(true);
    expect(sample.hunks.some((h) => h.labels.some((l) => l.kind === 'assertion-removed'))).toBe(true);
    expect(sample.hunks.some((h) => !h.prompt && h.match === 'none')).toBe(true);
    expect(sample.hunks.some((h) => h.edits.some((e) => e.kind === 'bash'))).toBe(true);
  });

  it('stores every edit once in a table that hunks reference by id, without text bodies on the refs', () => {
    let refs = 0;
    for (const h of sample.hunks) {
      expect(h.edits.map((e) => e.id)).toEqual(h.editIds);
      refs += h.editIds.length;
      for (const id of h.editIds) expect(sample.edits[id]?.id).toBe(id);
      for (const e of h.edits) {
        expect(e).not.toHaveProperty('oldText');
        expect(e).not.toHaveProperty('newText');
      }
    }
    expect(Object.keys(sample.edits).length).toBeGreaterThan(0);
    expect(Object.keys(sample.edits).length).toBeLessThanOrEqual(refs);
    expect(sample.summary.sessionsFound).toBe(2);
  });
});

describe('collectRisks', () => {
  /** The formatDate test hunk split into three segments, each still a test-modified risk, only the first with the skip. */
  function splitTestFile(): { report: Report; file: string } {
    const r = clone(sample);
    const base = r.hunks.find((h) => h.hunk.id === 'h12') as AttributedHunk;
    const segments = [1, 2, 3].map((n) => {
      const seg = clone(base);
      seg.hunk.id = `h12.${n}`;
      if (n > 1) seg.labels = seg.labels.filter((l) => l.kind === 'test-modified');
      return seg;
    });
    r.hunks.splice(r.hunks.indexOf(base), 1, ...segments);
    return { report: r, file: base.hunk.file };
  }

  it('reports file-level labels once per file with the segment count, line-level labels per hunk', () => {
    const { report, file } = splitTestFile();
    const risks = collectRisks(report, 'warn');
    const testRows = risks.filter((x) => x.label.kind === 'test-modified' && x.hunk.hunk.file === file);
    expect(testRows).toHaveLength(1);
    expect(testRows[0]?.hunks.map((h) => h.hunk.id)).toEqual(['h12.1', 'h12.2', 'h12.3']);
    expect(testRows[0]?.fileLevel).toBe(true);
    expect(riskRef(testRows[0] as never)).toBe(`${file} (3 hunks)`);
    const skips = risks.filter((x) => x.label.kind === 'test-skip-added');
    expect(skips).toHaveLength(1);
    expect(skips[0]?.hunks).toHaveLength(1);
    expect(skips[0]?.fileLevel).toBe(false);
    // the same number of rows as before the split
    expect(risks).toHaveLength(collectRisks(sample, 'warn').length);
    expect(headline(report).riskLabels).toBe(headline(sample).riskLabels);
  });

  it('keeps the highest severity and merges distinct details of an aggregated row', () => {
    const r = clone(sample);
    const a = r.hunks.find((h) => h.hunk.id === 'h15') as AttributedHunk;
    const b = r.hunks.find((h) => h.hunk.id === 'h16') as AttributedHunk;
    a.labels = [{ kind: 'dependency-added', severity: 'warn', detail: 'New dependency: left-pad' }];
    b.labels = [{ kind: 'dependency-added', severity: 'risk', detail: 'New dependency: evil-pkg' }];
    const row = collectRisks(r, 'warn').find((x) => x.label.kind === 'dependency-added' && x.hunk.hunk.file === 'package-lock.json');
    expect(row?.label.severity).toBe('risk');
    expect(row?.label.detail).toBe('New dependency: evil-pkg; New dependency: left-pad');
    expect(row?.hunks).toHaveLength(2);
  });

  it('renders the aggregated row in markdown and terminal', () => {
    const { report, file } = splitTestFile();
    const md = renderMarkdown(report);
    expect(md).toContain(`| \`${file}\` (3 hunks) | \`test-modified\` |`);
    expect((md.match(/`test-modified`/g) ?? []).length).toBe(1); // one risk row, not three
    expect(md).toContain(`### Risks (${collectRisks(sample, 'warn').length})`);
    const term = renderTerminal(report, { color: false, width: 140 });
    expect(term).toContain(`${file} (3 hunks)`);
    expect(term).toContain(`RISKS (${collectRisks(sample, 'warn').length})`);
  });
});

describe('sessions wording', () => {
  it('explains an empty session list instead of printing "0 sessions ()"', () => {
    const r = clone(sample);
    r.sessions = [];
    r.summary.sessions = 0;
    r.summary.sessionsFound = 0;
    expect(describeSessions(r)).toBe('no agent sessions found');
    const term = renderTerminal(r, { color: false, width: 140 });
    expect(term).toContain('no agent sessions found');
    expect(term).not.toContain('0 sessions');
    expect(term).toContain('--scan-all');
    const md = renderMarkdown(r);
    expect(md).toContain('| Sessions | no agent sessions found; check the harness');
    expect(md).not.toContain('| Sessions | 0');
    r.summary.sessionsFound = 3;
    expect(describeSessions(r)).toBe('no agent session contributed to this diff (3 sessions found in the window)');
    expect(describeSessions(sample)).toBe('2 sessions (claude-code, codex)');
  });
});

describe('shared', () => {
  it('computes the headline', () => {
    const h = headline(sample);
    expect(h.tracedPct).toBe(95);
    expect(h.unrequestedHunks).toBe(2);
    expect(h.unattributedHunks).toBe(1);
    expect(h.touchedTests).toBe(true);
    expect(h.intentRan).toBe(true);
    expect(h.harnesses).toEqual(['claude-code', 'codex']);
  });

  it('groups hunks by prompt in chronological order and separates unattributed', () => {
    const g = groupByPrompt(sample);
    expect(g.groups.map((x) => x.prompt.index)).toEqual([0, 1, 2, 0]);
    expect(g.groups.map((x) => x.hunks.length)).toEqual([7, 2, 1, 6]);
    expect(g.unattributed.map((x) => x.hunk.file)).toEqual(['components/Footer.tsx']);
  });

  it('hashes stably and changes with content', () => {
    const a = reportHash(sample);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(reportHash(clone(sample))).toBe(a);
    const r = clone(sample);
    (r.hunks[0] as AttributedHunk).hunk.header = '@@ -1 +1 @@ changed';
    expect(reportHash(r)).not.toBe(a);
  });

  it('truncates on code points with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a  b\n\tc', 10)).toBe('a b c');
    const t = truncate('x'.repeat(50), 12);
    expect(vlen(t)).toBe(12);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('renderTerminal', () => {
  it('prints headline numbers, prompts, hunks, risks and the unattributed group', () => {
    const out = renderTerminal(sample, { color: false, width: 120 });
    expect(out).toContain('why-diff');
    expect(out).toContain('acme-dashboard');
    expect(out).toContain('main...HEAD');
    expect(out).toContain('95% of added lines trace to a prompt');
    expect(out).toContain('2 hunks nobody asked for');
    expect(out).toContain('tests touched');
    expect(out).toContain('1 unattributed hunk');
    expect(out).toContain('RISKS (9)');
    expect(out).toContain('test-skip-added');
    expect(out).toContain('assertion-removed');
    expect(out).toContain('PROMPTS (4)');
    expect(out).toContain('add a dark mode toggle to the header');
    expect(out).toContain("Don't touch anything else.");
    expect(out).toContain('lib/__tests__/formatDate.test.ts:L8-16');
    expect(out).toContain('partial 78%');
    expect(out).toContain('unrequested');
    expect(out).toContain('UNATTRIBUTED (1)');
    expect(out).toContain('components/Footer.tsx:L18-21');
    expect(out).toContain('no verdict');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('emits no ANSI codes when color is off and does when on', () => {
    expect(renderTerminal(sample, { color: false, width: 120 })).not.toMatch(ANSI);
    const colored = renderTerminal(sample, { color: true, width: 120 });
    expect(colored).toMatch(ANSI);
    expect(strip(colored)).toBe(renderTerminal(sample, { color: false, width: 120 }));
  });

  it('respects NO_COLOR and FORCE_COLOR', () => {
    expect(detectColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(detectColor({ NO_COLOR: '' }, true)).toBe(true);
    expect(detectColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(detectColor({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(detectColor({ TERM: 'dumb' }, true)).toBe(false);
    expect(detectColor({}, false)).toBe(false);
  });

  it.each([40, 60, 79, 100, 140])('keeps every line within width %i', (width) => {
    for (const color of [false, true]) {
      const lines = renderTerminal(sample, { color, width, verbose: true }).split('\n');
      for (const l of lines) expect(vlen(strip(l))).toBeLessThanOrEqual(width);
    }
  });

  it('switches to a stacked layout on narrow terminals and truncates long prompts', () => {
    const out = renderTerminal(sample, { color: false, width: 60 });
    expect(out).toContain('add a dark mode toggle to the header.');
    expect(out).not.toContain('respect prefers-color-scheme on first load');
    expect(out).toContain('…');
    expect(out).toContain('exact · ✓ requested');
  });

  it('shows rationale, commands and label details in verbose mode only', () => {
    const terse = renderTerminal(sample, { color: false, width: 140 });
    const verbose = renderTerminal(sample, { color: false, width: 140, verbose: true });
    expect(terse).not.toContain('The DST test is flaky');
    expect(verbose).toContain('The DST test is flaky');
    expect(verbose).toContain('$ npm install posthog-js');
    expect(verbose).toContain("it.skip added to 'handles the DST boundary'");
    expect(terse).toContain('… 1 more (use --verbose)');
    expect(verbose).not.toContain('use --verbose');
  });

  it('handles a report without intent verdicts or hunks', () => {
    const r = clone(sample);
    for (const h of r.hunks) delete h.intent;
    delete r.summary.intent;
    const out = renderTerminal(r, { color: false, width: 100 });
    expect(out).not.toContain('nobody asked for');
    expect(out).toContain('no verdict');

    const empty: Report = { ...clone(sample), hunks: [], summary: { ...r.summary, hunks: 0, files: 0, addedLines: 0, removedLines: 0, agentLines: 0, unattributedLines: 0, labels: {}, touchedTests: false } };
    const e = renderTerminal(empty, { color: false, width: 100 });
    expect(e).toContain('no added lines');
    expect(e).not.toContain('100%');
    expect(e).toContain('RISKS  none');
    expect(e).toContain('no hunks in this diff');
  });

  it('passes hostile text through untouched (terminal needs no escaping)', () => {
    const out = renderTerminal(withHostileContent(), { color: false, width: 200, verbose: true });
    expect(out).toContain('<script>alert(1)</script>');
  });
});

describe('headline with no added lines', () => {
  it('headline does not claim 100% with no added lines', () => {
    const r = clone(sample);
    r.hunks = [];
    r.summary = { ...r.summary, hunks: 0, files: 0, addedLines: 0, removedLines: 0, agentLines: 0, unattributedLines: 0, labels: {}, touchedTests: false };
    const md = renderMarkdown(r);
    expect(md).toContain('no added lines');
    expect(md).not.toContain('100%');
    expect(renderTerminal(r, { color: false, width: 100 })).toContain('no added lines');
  });
});

describe('html with no added lines', () => {
  it('in-page tracedPct does not fall back to 100', async () => {
    const { renderHtml } = await import('../src/report/html.js');
    expect(renderHtml(sample)).not.toMatch(/\* 100\) : 100;/);
  });
});

describe('renderMarkdown', () => {
  it('has a Provenance section with risks first, a summary table and collapsible prompts', () => {
    const md = renderMarkdown(sample);
    expect(md.startsWith('## Provenance\n')).toBe(true);
    expect(md.indexOf('### Risks')).toBeLessThan(md.indexOf('### Summary'));
    expect(md.indexOf('### Summary')).toBeLessThan(md.indexOf('### Prompts'));
    expect(md).toContain('**95%** of added lines trace to a prompt');
    expect(md).toContain('| Agent-traced lines | 142 of 150 added (95%) |');
    expect(md).toContain('| Intent | 7 requested · 6 implied · 2 unrequested · 1 unclear');
    expect((md.match(/<details>/g) ?? []).length).toBe(4);
    expect((md.match(/<\/details>/g) ?? []).length).toBe(4);
    expect(md).toContain('<summary><b>claude-code</b> · 09:12 · “add a dark mode toggle');
    expect(md).toContain('| `lib/__tests__/formatDate.test.ts` | L8–16 | +2 −2 | exact | **RISK** assertion-removed<br>**RISK** test-skip-added<br>**WARN** test-modified | **UNREQUESTED** |');
    expect(md).toContain('### Unattributed (1)');
    expect(md).toContain('| `components/Footer.tsx` | L18–21 | +2 −2 | none | **WARN** unattributed | — |');
    expect(md).toContain('Generated by why-diff v0.1.0');
    expect(md).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji badges
  });

  it('escapes HTML and table pipes in user content', () => {
    const md = renderMarkdown(withHostileContent());
    // no raw tags anywhere: prose is entity-escaped, code spans use look-alike brackets
    expect(md).not.toMatch(/<(script|img)\b/);
    expect(md).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(md).toContain('‹script›alert(1)‹/script›');
    // a pipe inside a table cell is escaped so the row keeps its columns
    expect(md).toContain('\\| with pipe |');
    // prose outside tables keeps its pipe as-is
    expect(md).toContain('please | and a pipe');
    // file path with hostile chars rendered inside a code span, backticks neutralised
    expect(md).toMatch(/`components\/[^`]*\.tsx`/);
  });

  it('truncates per maxHunks with a note', () => {
    const md = renderMarkdown(sample, { maxHunks: 3 });
    const rows = md.split('\n').filter((l) => /^\| `/.test(l) && !l.startsWith('| `main'));
    expect(rows.length).toBe(3);
    expect(md).toContain('more hunks not shown');
    expect(md).toContain('14 hunks omitted');
  });

  it('stays under 60k characters for very large reports', () => {
    const big = bigReport(2500);
    const md = renderMarkdown(big);
    expect(md.length).toBeLessThan(60_000);
    expect(md).toContain('## Provenance');
    expect(md).toContain('</details>');
    expect(md).toContain('omitted to keep this comment short');
    const tiny = renderMarkdown(big, { maxChars: 4000 });
    expect(tiny.length).toBeLessThanOrEqual(4000);
  });
});

describe('renderMarkdown with many long prompts', () => {
  function promptHeavy(n: number, size: number): Report {
    const r = clone(sample);
    const base = r.prompts[0]!;
    r.prompts = Array.from({ length: n }, (_, i) => ({ ...base, id: `${base.sessionId}:${i}`, index: i, text: `prompt ${i}: ${'please refactor the parser and keep the tests green. '.repeat(Math.ceil(size / 52)).slice(0, size)}` }));
    return r;
  }
  const balanced = (md: string) => (md.match(/<details>/g) ?? []).length === (md.match(/<\/details>/g) ?? []).length;

  it('caps each quoted prompt and keeps <details> balanced within the size limit', () => {
    const md = renderMarkdown(promptHeavy(40, 3300));
    expect(md.length).toBeLessThanOrEqual(60_000);
    expect(balanced(md)).toBe(true);
    for (const q of md.split('\n').filter((l) => l.startsWith('> prompt '))) expect(q.length).toBeLessThanOrEqual(1503);
    for (const cap of [4000, 9000, 20_000]) {
      const small = renderMarkdown(promptHeavy(40, 3300), { maxChars: cap });
      expect(small.length).toBeLessThanOrEqual(cap);
      expect(balanced(small)).toBe(true);
    }
  });

  it('leaves the PR text after the end marker outside any open block', () => {
    const body = `Intro\n\n${SECTION_START}\nold\n${SECTION_END}\n\nUser notes after the section.\n`;
    const md = renderMarkdown(promptHeavy(40, 3300), { maxChars: Math.min(60_000, sectionBudget(body)) });
    const next = upsertSection(body, md);
    expect(next.length).toBeLessThanOrEqual(65_536);
    expect(next.endsWith(`${SECTION_END}\n\nUser notes after the section.\n`)).toBe(true);
    const section = next.slice(next.indexOf(SECTION_START), next.indexOf(SECTION_END));
    expect(balanced(section)).toBe(true);
  });
});

describe('control characters from prompts and file names', () => {
  const ESC = '\u001b';
  const NASTY = `${ESC}]8;;https://evil.example/${ESC}\\CLICK${ESC}]8;;${ESC}\\ ${ESC}[2J${ESC}[H\u009b31m\u0007bell‮evil⁦x⁩`;
  function hostile(): Report {
    const r = clone(sample);
    for (const p of r.prompts) p.text = `fix it ${NASTY}\tdone\nsecond line`;
    for (const h of r.hunks) {
      h.hunk.file = `src/esc${NASTY}.js`;
      if (h.prompt) h.prompt.text = `fix it ${NASTY}`;
      for (const e of h.edits) e.rationale = `because ${NASTY}`;
      h.labels.push({ kind: 'secret-like', severity: 'risk', detail: `detail ${NASTY}` });
    }
    r.repo.branch = `main${NASTY}`;
    r.repo.name = `repo${NASTY}`;
    return r;
  }
  const C0C1 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  const BIDI = /[‪-‮⁦-⁩]/;

  it('the terminal shows escapes as visible glyphs and drops nothing else', () => {
    for (const verbose of [false, true]) {
      const out = renderTerminal(hostile(), { color: false, width: 200, verbose });
      expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(out).not.toMatch(BIDI);
      expect(out).toContain('␛[2J');
    }
    const colored = renderTerminal(hostile(), { color: true, width: 200, verbose: true });
    expect(colored.replace(/\u001b\[[0-9;]*m/g, '')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('the HTML title carries no control or bidi characters', () => {
    const title = /<title>([^<]*)<\/title>/.exec(renderHtml(hostile()))?.[1] ?? '';
    expect(title).not.toMatch(C0C1);
    expect(title).not.toMatch(BIDI);
  });

  it('markdown and JSON keep the text but strip C0/C1 controls, keeping newlines and tabs', () => {
    const md = renderMarkdown(hostile());
    expect(md).not.toMatch(C0C1);
    expect(md).toContain('CLICK');
    const json = renderJson(hostile());
    const parsed = JSON.parse(json) as Report;
    expect(JSON.stringify(parsed)).not.toMatch(/\\u00(?:0[0-8bcef]|1[0-9a-f]|7f)/);
    expect(json).not.toMatch(/[\u0080-\u009f]/);
    expect(parsed.prompts[0]!.text).toContain('\tdone\nsecond line');
  });
});

describe('renderHtml', () => {
  const html = renderHtml(sample);

  it('is a complete, self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>acme-dashboard · main...HEAD · why-diff</title>');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('prefers-color-scheme');
    expect(html).toContain('localStorage');
    expect(html).toContain('<script id="why-diff-data" type="application/json">');
    expect(html).toMatch(/<header class="top"/);
    expect(html).toMatch(/<nav class="rail"/);
    expect(html).toMatch(/<main id="main"/);
    expect(html).toContain('<noscript>');
    expect(html).toContain('data-report-hash="' + reportHash(sample) + '"');
    // no external resources
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);
    expect(html).not.toMatch(/@import/);
  });

  it('is small enough', () => {
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(150 * 1024);
  });

  it('embeds the report JSON so it round-trips', () => {
    const m = html.match(/<script id="why-diff-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const payload = JSON.parse(m![1] as string) as { report: Report; hash: string };
    expect(payload.hash).toBe(reportHash(sample));
    expect(payload.report).toEqual(sample);
  });

  it('cannot be broken out of by hostile prompts, paths, code or labels', () => {
    const hostile = withHostileContent();
    const out = renderHtml(hostile);
    const m = out.match(/<script id="why-diff-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const json = m![1] as string;
    // nothing inside the data block can close it or open a tag
    expect(json).not.toMatch(/[<>]/);
    // and nothing from the payload leaks into the markup around it
    const rest = out.replace(json, '');
    expect(rest).not.toContain('alert(');
    expect(rest).not.toContain('onerror');
    // the only </script> closers are our own three script blocks
    expect((out.match(/<\/script>/g) ?? []).length).toBe(3);
    // line separators are escaped so the inline JSON stays on one logical line
    expect(out).not.toContain(' ');
    // and the embedded payload still decodes to the original text
    const payload = JSON.parse(json) as { report: Report };
    expect(payload.report.prompts[0]?.text).toContain(XSS);
    expect(payload.report.hunks[0]?.hunk.file).toContain(XSS);
  });

  it('never uses innerHTML in the client script', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string).join('\n');
    expect(scripts.length).toBeGreaterThan(1000);
    expect(scripts).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('ships client code that parses', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
    expect(scripts.length).toBe(2);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  it('includes keyboard help, filters and reviewed-state hooks', () => {
    for (const needle of ['Keyboard shortcuts', "'why-diff:reviewed:'", 'Risks only', 'Hide reviewed', 'aria-pressed', "role: 'progressbar'", 'prefers-reduced-motion']) {
      expect(html).toContain(needle);
    }
  });
});

describe('renderJson', () => {
  it('pretty prints and round-trips', () => {
    const out = renderJson(sample);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\n  "version": "0.1.0",\n');
    expect(JSON.parse(out)).toEqual(sample);
  });
});

describe('renderReport', () => {
  it('dispatches by format', () => {
    expect(renderReport(sample, 'terminal', { color: false, width: 100 })).toContain('PROMPTS');
    expect(renderReport(sample, 'md')).toContain('## Provenance');
    expect(renderReport(sample, 'html')).toContain('<!doctype html>');
    expect(JSON.parse(renderReport(sample, 'json'))).toEqual(sample);
  });

  it('rejects unknown formats', () => {
    expect(isReportFormat('md')).toBe(true);
    expect(isReportFormat('pdf')).toBe(false);
    expect(() => renderReport(sample, 'pdf' as never)).toThrow(/Unknown report format/);
  });
});

describe('zero-line hunks (pure rename of a test file)', () => {
  it('summarises and renders a tests-disabled hunk with no lines', async () => {
    const { summarize } = await import('../src/summary.js');
    const ah: AttributedHunk = {
      hunk: { id: 'h1', file: 'test/a.test.js.disabled', oldFile: 'test/a.test.js', status: 'renamed', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, header: 'rename test/a.test.js => test/a.test.js.disabled', lines: [] },
      match: 'none', coverage: 0, editIds: [], edits: [],
      labels: [{ kind: 'tests-disabled', severity: 'risk', detail: 'Renames test file a.test.js to a.test.js.disabled' }],
    };
    const r = clone(sample);
    r.hunks = [ah];
    r.summary = summarize([ah], []);
    expect(r.summary).toMatchObject({ hunks: 1, files: 1, addedLines: 0, removedLines: 0, touchedTests: true, labels: { 'tests-disabled': 1 } });
    expect(renderTerminal(r, { color: false, width: 100 })).toContain('a.test.js.disabled');
    expect(renderMarkdown(r)).toContain('a.test.js.disabled');
    expect(renderHtml(r)).toContain('tests-disabled');
  });
});

describe('risk-scan mode (no agent transcripts)', () => {
  function riskScan(): Report {
    const r = clone(sample);
    r.mode = 'risk-scan';
    r.sessions = [];
    r.prompts = [];
    r.edits = {};
    for (const h of r.hunks) {
      h.prompt = undefined;
      h.match = 'none';
      h.coverage = 0;
      h.editIds = [];
      h.edits = [];
      h.labels = h.labels.filter((l) => l.kind !== 'unattributed');
      delete h.intent;
    }
    r.summary = { ...r.summary, sessions: 0, sessionsFound: 0, prompts: 0, agentLines: 0, unattributedLines: r.summary.addedLines };
    delete r.summary.intent;
    delete r.summary.labels.unattributed;
    return r;
  }
  const NOTE = 'No agent transcripts here, so lines are not traced to prompts. The PR author can add provenance with `why-diff pr`.';

  it('markdown starts with the risk-scan heading and the note, without provenance sections', () => {
    const md = renderMarkdown(riskScan());
    expect(md.startsWith('## why-diff risk scan\n')).toBe(true);
    expect(md).toContain(NOTE);
    expect(md).not.toContain('## Provenance');
    expect(md).not.toContain('### Prompts');
    expect(md).not.toContain('### Unattributed');
    expect(md).not.toContain('trace to a prompt');
    expect(md).toContain('### Risks');
    expect(md).toContain('formatDate');
  });

  it('terminal shows the risk-scan heading and note instead of prompts', () => {
    const term = renderTerminal(riskScan(), { color: false, width: 160 });
    expect(term).toContain('why-diff risk scan');
    expect(term).toContain(NOTE);
    expect(term).not.toContain('PROMPTS');
    expect(term).not.toContain('UNATTRIBUTED');
    expect(term).not.toContain('trace to a prompt');
    expect(term).toContain('RISKS');
  });

  it('provenance reports keep the usual heading', () => {
    expect(renderMarkdown(sample).startsWith('## Provenance\n')).toBe(true);
  });
});
