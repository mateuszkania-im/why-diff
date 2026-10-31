#!/usr/bin/env node
/**
 * Score a why-diff intent eval run and write evals/RESULTS.md.
 *
 *   node evals/score.mjs [results.json] [RESULTS.md]
 *
 * Accepts promptfoo's `-o results.json` output (rows under `.results.results`)
 * or a plain array of { id, lang, tags, label, predicted, reason } rows.
 * Reports accuracy, per-class precision/recall/F1, the confusion matrix, the
 * "flag" view (unrequested vs everything else) and every miss.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERDICTS = ['requested', 'implied', 'unrequested', 'unclear'];
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** Normalise promptfoo rows (or our own rows) into { id, lang, tags, label, predicted, reason }. */
export function toRows(json) {
  const raw = Array.isArray(json) ? json : (json?.results?.results ?? json?.results ?? []);
  return raw.map((r) => {
    if ('predicted' in r) return r;
    const vars = r.vars ?? r.testCase?.vars ?? {};
    const out = typeof r.response?.output === 'string' ? r.response.output.trim().toLowerCase() : '';
    return {
      id: vars.id,
      lang: vars.lang,
      tags: String(vars.tags ?? '').split(',').filter(Boolean),
      label: vars.label,
      predicted: VERDICTS.includes(out) ? out : 'error',
      reason: r.response?.metadata?.reason ?? r.error ?? r.response?.error ?? '',
      provider: r.provider?.label ?? r.provider?.id ?? '',
    };
  });
}

export function score(rows) {
  const labels = [...VERDICTS, ...(rows.some((r) => r.predicted === 'error') ? ['error'] : [])];
  const matrix = Object.fromEntries(VERDICTS.map((g) => [g, Object.fromEntries(labels.map((p) => [p, 0]))]));
  for (const r of rows) matrix[r.label][r.predicted]++;
  const correct = rows.filter((r) => r.label === r.predicted).length;
  const perClass = VERDICTS.map((c) => {
    const tp = matrix[c][c];
    const predicted = VERDICTS.reduce((s, g) => s + matrix[g][c], 0);
    const gold = labels.reduce((s, p) => s + matrix[c][p], 0);
    const precision = predicted ? tp / predicted : 0;
    const recall = gold ? tp / gold : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { cls: c, support: gold, predicted, precision, recall, f1 };
  });
  // Binary "would why-diff flag this hunk?" view: unrequested vs the rest.
  const flag = (v) => v === 'unrequested';
  const tp = rows.filter((r) => flag(r.label) && flag(r.predicted)).length;
  const fp = rows.filter((r) => !flag(r.label) && flag(r.predicted)).length;
  const fn = rows.filter((r) => flag(r.label) && !flag(r.predicted)).length;
  const byLang = {};
  for (const r of rows) {
    const l = (byLang[r.lang] ??= { n: 0, ok: 0 });
    l.n++;
    if (r.label === r.predicted) l.ok++;
  }
  return {
    n: rows.length,
    accuracy: rows.length ? correct / rows.length : 0,
    macroF1: perClass.reduce((s, c) => s + c.f1, 0) / perClass.length,
    perClass,
    labels,
    matrix,
    flag: { precision: tp + fp ? tp / (tp + fp) : 0, recall: tp + fn ? tp / (tp + fn) : 0, tp, fp, fn },
    byLang,
    errors: rows.filter((r) => r.predicted === 'error').length,
    misses: rows.filter((r) => r.label !== r.predicted),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

export function toMarkdown(s, meta = {}) {
  const out = [];
  out.push('# Intent classifier eval results', '');
  if (meta.provider) out.push(`Provider: \`${meta.provider}\`  `);
  out.push(`Cases: ${s.n} (hand-labelled, evals/dataset.jsonl)  `, `Run: ${meta.date ?? new Date().toISOString()}`, '');
  out.push('## Headline', '');
  out.push('| Metric | Value |', '|---|---|');
  out.push(`| Accuracy (4-way) | **${pct(s.accuracy)}** |`);
  out.push(`| Macro F1 | ${s.macroF1.toFixed(3)} |`);
  out.push(`| Flag precision (unrequested) | ${pct(s.flag.precision)} |`);
  out.push(`| Flag recall (unrequested) | ${pct(s.flag.recall)} |`);
  if (s.errors) out.push(`| Errors (no output) | ${s.errors} |`);
  out.push('');
  out.push('## Per class', '', '| Class | Support | Predicted | Precision | Recall | F1 |', '|---|---:|---:|---:|---:|---:|');
  for (const c of s.perClass) {
    out.push(`| ${c.cls} | ${c.support} | ${c.predicted} | ${pct(c.precision)} | ${pct(c.recall)} | ${c.f1.toFixed(3)} |`);
  }
  out.push('', '## Confusion matrix (rows = gold, columns = predicted)', '');
  out.push(`| gold \\ pred | ${s.labels.join(' | ')} |`, `|---|${s.labels.map(() => '---:').join('|')}|`);
  for (const g of VERDICTS) out.push(`| **${g}** | ${s.labels.map((p) => (g === p ? `**${s.matrix[g][p]}**` : s.matrix[g][p])).join(' | ')} |`);
  out.push('', '## By language', '', '| Lang | Cases | Accuracy |', '|---|---:|---:|');
  for (const [lang, v] of Object.entries(s.byLang).sort()) out.push(`| ${lang} | ${v.n} | ${pct(v.ok / v.n)} |`);
  out.push('', `## Misses (${s.misses.length})`, '', '| Case | Tags | Gold | Predicted | Model reason |', '|---|---|---|---|---|');
  for (const m of s.misses.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    out.push(`| ${m.id} | ${cell(m.tags.join(', '))} | ${m.label} | ${m.predicted} | ${cell(m.reason)} |`);
  }
  out.push(
    '',
    '## How to rerun',
    '',
    '```sh',
    '# one model call per case, 4 in parallel; uses the local `claude` login (no API key)',
    'npx promptfoo@0.120.19 eval -c evals/promptfooconfig.yaml -o evals/results.json --no-cache',
    'node evals/score.mjs            # reads evals/results.json, writes evals/RESULTS.md',
    '```',
    '',
    'Each case is classified in its own call (batch size 1) so one case\'s prompts never leak into another\'s context. The model is not deterministic through the CLI; expect a few points of run-to-run variance.',
    '',
  );
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = process.argv[2] ?? here('./results.json');
  const output = process.argv[3] ?? here('./RESULTS.md');
  const json = JSON.parse(readFileSync(input, 'utf8'));
  const rows = toRows(json);
  if (rows.length === 0) throw new Error(`no result rows found in ${input}`);
  const s = score(rows);
  const provider = [...new Set(rows.map((r) => r.provider).filter(Boolean))].join(', ');
  writeFileSync(output, toMarkdown(s, { provider, date: json?.results?.timestamp ?? json?.timestamp }));
  console.log(`accuracy ${pct(s.accuracy)}  macroF1 ${s.macroF1.toFixed(3)}  flag P ${pct(s.flag.precision)} R ${pct(s.flag.recall)}  (${s.n} cases) -> ${output}`);
}
