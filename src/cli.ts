#!/usr/bin/env node
/**
 * why-diff CLI.
 *
 *   npx why-diff                      # branch + working tree, terminal report
 *   npx why-diff main...HEAD --html   # interactive review page
 *   npx why-diff --classify           # + LLM intent check (uses your local Claude Code)
 */
import { Command, Option } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { buildReport } from './pipeline.js';
import { redactReport } from './redact.js';
import { renderReport, isReportFormat, type ReportFormat } from './report/index.js';
import type { Harness, LabelKind } from './types.js';
import { runGuard, type GuardPayload } from './guard.js';
import type { ClassifierKind } from './classify/index.js';
import { ghRunner, PR_BODY_LIMIT, readPrBody, sectionBudget, upsertSection, writePrBody } from './pr.js';

const HARNESSES: Harness[] = ['claude-code', 'codex', 'opencode'];
const CLASSIFIERS: ClassifierKind[] = ['auto', 'claude-cli', 'anthropic', 'openai'];
const FAIL_ON = ['risk', 'unrequested', 'tests', 'unattributed'];

/** Injected at build time (scripts/build.mjs, tsup.config.ts); 'dev' under tsx. */
declare const __WHY_DIFF_VERSION__: string | undefined;
const VERSION = typeof __WHY_DIFF_VERSION__ === 'string' ? __WHY_DIFF_VERSION__ : 'dev';

const program = new Command();

program
  .name('why-diff')
  // Options after a subcommand name belong to that subcommand (`why-diff pr -q`).
  .enablePositionalOptions()
  .version(VERSION, '-V, --version')
  .description('Trace every hunk of an AI agent\'s diff back to the prompt and tool call that wrote it.')
  .argument('[range]', 'git range (e.g. main...HEAD) or commit; default: branch vs main plus working tree')
  .argument('[paths...]', 'limit to these paths (give them after --, e.g. why-diff -- src)')
  .option('--base <ref>', 'branch or ref to compare against (default: auto-detected, incl. CI pull request targets)')
  .option('-w, --working-tree', 'only uncommitted changes vs HEAD')
  .addOption(new Option('-f, --format <format>', 'output format').choices(['terminal', 'md', 'html', 'json']))
  .option('--html', 'shortcut for --format html (writes .why-diff/report.html and opens it)')
  .option('-o, --out <file>', 'write output to a file instead of stdout')
  .option('--no-open', 'do not open the HTML report in a browser')
  .option('-c, --classify [backend]', 'LLM intent check: auto | claude-cli | anthropic | openai', false)
  .option('-m, --model <model>', 'model for the intent check (default: haiku)')
  .option('--harness <list>', 'comma list of harnesses: claude-code,codex,opencode')
  .option('-s, --session <files...>', 'explicit transcript file(s) instead of auto-discovery')
  .option('--since <date>', 'only consider sessions after this date (ISO)')
  .option('--scan-all', 'also scan transcripts started outside the repo (sibling folders, workspace roots) that edited files in it; slower')
  .option('-v, --verbose', 'show rationale, commands and label details')
  .option('--fail-on <what>', 'exit 1 if: risk | unrequested | tests | unattributed (comma list) — for CI and hooks')
  .option('--redact-prompts', 'omit prompt text and agent rationales from the output (secrets are always masked)')
  .option('-q, --quiet', 'no progress output')
  .action(async (rangeArg: string | undefined, pathArgs: string[], o: Record<string, unknown>) => {
    const progress = (msg: string) => { if (!o.quiet) process.stderr.write(pc.dim(`· ${msg}\n`)); };
    const format: ReportFormat = o.html ? 'html' : (o.format as ReportFormat | undefined) ?? (o.out && String(o.out).endsWith('.html') ? 'html' : 'terminal');
    if (!isReportFormat(format)) throw new Error(`unknown format ${format}`);

    const harnesses = parseHarnesses(o.harness);

    // Everything after a literal `--` is a pathspec; the optional range must come before it.
    const dd = process.argv.indexOf('--');
    const paths = dd >= 0 ? process.argv.slice(dd + 1) : [];
    let range: string | undefined = rangeArg;
    if (paths.length) {
      if (pathArgs.length + (rangeArg === undefined ? 0 : 1) > paths.length) range = rangeArg;
      else range = undefined;
    } else if (pathArgs.length) {
      throw new Error('extra arguments: put paths after -- (why-diff [range] -- <paths>)');
    }

    let classify: ClassifierKind;
    if (o.classify === false || o.classify === undefined) classify = 'none';
    else if (o.classify === true) classify = 'auto';
    else if (CLASSIFIERS.includes(o.classify as ClassifierKind)) classify = o.classify as ClassifierKind;
    else if (range === undefined) { range = String(o.classify); classify = 'auto'; }
    else throw new Error(`unknown --classify backend "${String(o.classify)}" (use ${CLASSIFIERS.join(', ')})`);

    const failChecks = o.failOn ? String(o.failOn).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const badCheck = failChecks.find((c) => !FAIL_ON.includes(c));
    if (badCheck) throw new Error(`unknown --fail-on value "${badCheck}" (use ${FAIL_ON.join(', ')})`);
    if (failChecks.includes('unrequested') && classify === 'none') throw new Error('--fail-on unrequested needs --classify');

    const since = parseSince(o.since);
    const built = await buildReport({
      range,
      base: o.base as string | undefined,
      workingTree: Boolean(o.workingTree),
      harnesses,
      sessionFiles: o.session as string[] | undefined,
      since,
      paths: paths.length ? paths : undefined,
      scanAll: Boolean(o.scanAll),
      classify,
      model: o.model as string | undefined,
      onProgress: progress,
    });

    const report = o.redactPrompts ? redactReport(built, 'prompts') : built;
    const out = renderReport(report, format, { verbose: Boolean(o.verbose) });
    let outFile = o.out as string | undefined;
    if (format === 'html' && !outFile) outFile = path.join(report.repo.root, '.why-diff', 'report.html');

    if (outFile) {
      await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
      await writeFile(outFile, out);
      const outDir = path.dirname(path.resolve(outFile));
      if (path.basename(outDir) === '.why-diff') await writeFile(path.join(outDir, '.gitignore'), '*\n');
      progress(`wrote ${path.relative(process.cwd(), path.resolve(outFile)) || outFile}`);
      if (format === 'html' && o.open !== false && process.stdout.isTTY) openFile(path.resolve(outFile));
      if (format === 'html') process.stdout.write(renderReport(report, 'terminal', {}) + '\n');
    } else {
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    }

    if (failChecks.length) {
      const s = report.summary;
      if (failChecks.includes('unrequested') && report.hunks.length > 0 && !s.intent) {
        const why = report.mode === 'risk-scan'
          ? 'no agent transcripts, so there are no prompts to check against'
          : 'no LLM backend available: install Claude Code, or set ANTHROPIC_API_KEY / OPENAI_API_KEY';
        throw new Error(`--fail-on unrequested: the intent check did not run (${why})`);
      }
      if (failChecks.includes('unattributed') && report.mode === 'risk-scan') {
        process.stderr.write(pc.yellow('why-diff: --fail-on unattributed ignored: no agent transcripts here, so nothing can be attributed\n'));
      }
      const failed = failChecks.filter((c) =>
        (c === 'risk' && report.hunks.some((h) => h.labels.some((l) => l.severity === 'risk'))) ||
        (c === 'unrequested' && (s.intent?.unrequested ?? 0) > 0) ||
        (c === 'tests' && s.touchedTests) ||
        (c === 'unattributed' && report.mode !== 'risk-scan' && s.unattributedLines > 0));
      if (failed.length) {
        process.stderr.write(pc.red(`why-diff: failing on ${failed.join(', ')}\n`));
        process.exitCode = 1;
      }
    }
  });

/**
 * `why-diff pr`: write the report into the body of the current branch's open
 * pull request (between why-diff markers), so reviewers without the
 * transcripts see the provenance. Never pushes, never creates a PR.
 */
program
  .command('pr')
  .description('put the report into the current branch\'s pull request body (gh pr edit); never pushes or creates a PR')
  .option('--base <ref>', 'branch or ref the PR targets (default: auto-detected)')
  .option('-c, --classify [backend]', 'LLM intent check: auto | claude-cli | anthropic | openai', false)
  .option('-m, --model <model>', 'model for the intent check (default: haiku)')
  .option('--harness <list>', 'comma list of harnesses: claude-code,codex,opencode')
  .option('-s, --session <files...>', 'explicit transcript file(s) instead of auto-discovery')
  .option('--since <date>', 'only consider sessions after this date (ISO)')
  .option('--scan-all', 'also scan transcripts started outside the repo that edited files in it; slower')
  .option('--redact-prompts', 'omit prompt text and agent rationales (secrets are always masked)')
  .option('--dry-run', 'print the new PR body instead of editing the PR')
  .option('-q, --quiet', 'no progress output')
  .action(async (o: Record<string, unknown>) => {
    const progress = (msg: string) => { if (!o.quiet) process.stderr.write(pc.dim(`· ${msg}\n`)); };
    let classify: ClassifierKind = 'none';
    if (o.classify === true) classify = 'auto';
    else if (o.classify) {
      if (!CLASSIFIERS.includes(o.classify as ClassifierKind)) throw new Error(`unknown --classify backend "${String(o.classify)}" (use ${CLASSIFIERS.join(', ')})`);
      classify = o.classify as ClassifierKind;
    }
    const harnesses = parseHarnesses(o.harness);
    const since = parseSince(o.since);
    const gh = ghRunner();
    const body = await readPrBody(gh);
    const budget = Math.min(60_000, sectionBudget(body));
    if (budget < 1000) throw new Error(`the pull request description is too long to add the why-diff section (GitHub allows ${PR_BODY_LIMIT} characters); shorten it and run again`);
    const built = await buildReport({
      base: o.base as string | undefined,
      harnesses,
      sessionFiles: o.session as string[] | undefined,
      since,
      scanAll: Boolean(o.scanAll),
      classify,
      model: o.model as string | undefined,
      onProgress: progress,
    });
    const report = o.redactPrompts ? redactReport(built, 'prompts') : built;
    const next = upsertSection(body, renderReport(report, 'md', { maxChars: budget }));
    if (next.length > PR_BODY_LIMIT) throw new Error(`the new pull request description would be ${next.length} characters, over GitHub's ${PR_BODY_LIMIT}; shorten it and run again`);
    if (o.dryRun) {
      process.stdout.write(next);
      return;
    }
    if (next === body) {
      progress('pull request body already up to date');
      return;
    }
    await writePrBody(gh, next);
    progress('updated the pull request body');
  });

/**
 * `why-diff guard` — Claude Code Stop hook.
 * Reads the hook payload from stdin, checks ONLY the current session's edits in the working tree,
 * and blocks the agent from finishing (exit 2) if it touched tests in a risky way without the user seeing it.
 */
program
  .command('guard')
  .description('Claude Code Stop hook: block the agent from finishing if it skipped, weakened or deleted tests')
  .option('--on <kinds>', 'labels that block (comma list; default: blockOn from .why-diff.json, else test-skip-added,tests-disabled,assertion-removed,secret-like,ci-changed,protected-path)')
  .action(async (o: { on?: string }) => {
    const raw = await readStdin();
    let payload: GuardPayload = {};
    try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { /* not a hook payload */ }
    const blocking = o.on === undefined ? undefined : (new Set(o.on.split(',').map((s) => s.trim()).filter(Boolean)) as Set<LabelKind>);
    const result = await runGuard(payload, { blocking });
    if (!result.block) return;
    process.stderr.write(result.message ?? '');
    process.exitCode = 2;
  });

function parseHarnesses(value: unknown): Harness[] | undefined {
  if (!value) return undefined;
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean) as Harness[];
  const unknown = list.find((h) => !HARNESSES.includes(h));
  if (unknown) throw new Error(`unknown harness "${unknown}" (use ${HARNESSES.join(', ')})`);
  return list;
}

function parseSince(value: unknown): Date | undefined {
  if (!value) return undefined;
  const since = new Date(String(value));
  if (Number.isNaN(since.getTime())) throw new Error(`invalid --since date "${String(value)}" (use ISO, e.g. 2026-10-31 or 2026-10-31T09:00)`);
  return since;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function openFile(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(pc.red(`why-diff: ${msg}\n`));
  process.exitCode = 2;
});
