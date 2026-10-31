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
import { renderReport, isReportFormat, type ReportFormat } from './report/index.js';
import type { Harness } from './types.js';
import type { ClassifierKind } from './classify/index.js';

const HARNESSES: Harness[] = ['claude-code', 'codex', 'opencode'];

/** Injected at build time (scripts/build.mjs, tsup.config.ts); 'dev' under tsx. */
declare const __WHY_DIFF_VERSION__: string | undefined;
const VERSION = typeof __WHY_DIFF_VERSION__ === 'string' ? __WHY_DIFF_VERSION__ : 'dev';

const program = new Command();

program
  .name('why-diff')
  .version(VERSION, '-V, --version')
  .description('Trace every hunk of an AI agent\'s diff back to the prompt and tool call that wrote it.')
  .argument('[range]', 'git range (e.g. main...HEAD) or commit; default: branch vs main plus working tree')
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
  .option('-q, --quiet', 'no progress output')
  .action(async (range: string | undefined, o: Record<string, unknown>) => {
    const progress = (msg: string) => { if (!o.quiet) process.stderr.write(pc.dim(`· ${msg}\n`)); };
    const format: ReportFormat = o.html ? 'html' : (o.format as ReportFormat | undefined) ?? (o.out && String(o.out).endsWith('.html') ? 'html' : 'terminal');
    if (!isReportFormat(format)) throw new Error(`unknown format ${format}`);

    const harnesses = o.harness ? (String(o.harness).split(',').map((s) => s.trim()).filter(Boolean) as Harness[]) : undefined;
    const unknownHarness = harnesses?.find((h) => !HARNESSES.includes(h));
    if (unknownHarness) throw new Error(`unknown harness "${unknownHarness}" (use ${HARNESSES.join(', ')})`);

    const classify: ClassifierKind = o.classify === false || o.classify === undefined ? 'none' : o.classify === true ? 'auto' : (o.classify as ClassifierKind);
    const report = await buildReport({
      range,
      workingTree: Boolean(o.workingTree),
      harnesses,
      sessionFiles: o.session as string[] | undefined,
      since: o.since ? new Date(String(o.since)) : undefined,
      scanAll: Boolean(o.scanAll),
      classify,
      model: o.model as string | undefined,
      onProgress: progress,
    });

    const out = renderReport(report, format, { verbose: Boolean(o.verbose) });
    let outFile = o.out as string | undefined;
    if (format === 'html' && !outFile) outFile = path.join(report.repo.root, '.why-diff', 'report.html');

    if (outFile) {
      await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
      await writeFile(outFile, out);
      progress(`wrote ${path.relative(process.cwd(), path.resolve(outFile)) || outFile}`);
      if (format === 'html' && o.open !== false && process.stdout.isTTY) openFile(path.resolve(outFile));
      if (format === 'html') process.stdout.write(renderReport(report, 'terminal', {}) + '\n');
    } else {
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    }

    if (o.failOn) {
      const s = report.summary;
      const checks = String(o.failOn).split(',').map((x) => x.trim());
      const failed = checks.filter((c) =>
        (c === 'risk' && report.hunks.some((h) => h.labels.some((l) => l.severity === 'risk'))) ||
        (c === 'unrequested' && (s.intent?.unrequested ?? 0) > 0) ||
        (c === 'tests' && s.touchedTests) ||
        (c === 'unattributed' && s.unattributedLines > 0));
      if (failed.length) {
        process.stderr.write(pc.red(`why-diff: failing on ${failed.join(', ')}\n`));
        process.exitCode = 1;
      }
    }
  });

/**
 * `why-diff guard` — Claude Code Stop hook.
 * Reads the hook payload from stdin, checks ONLY the current session's edits in the working tree,
 * and blocks the agent from finishing (exit 2) if it touched tests in a risky way without the user seeing it.
 */
program
  .command('guard')
  .description('Claude Code Stop hook: block the agent from finishing if it skipped, weakened or deleted tests')
  .option('--on <kinds>', 'labels that block (comma list)', 'test-skip-added,assertion-removed,secret-like,ci-changed')
  .action(async (o: { on: string }) => {
    const raw = await readStdin();
    let payload: { transcript_path?: string; stop_hook_active?: boolean; cwd?: string } = {};
    try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { /* not a hook payload */ }
    if (payload.stop_hook_active) return; // already blocked once this turn: let the agent explain and stop
    const blocking = new Set(o.on.split(',').map((s) => s.trim()));
    let report;
    try {
      report = await buildReport({
        cwd: payload.cwd ?? process.cwd(),
        workingTree: true,
        sessionFiles: payload.transcript_path ? [payload.transcript_path] : undefined,
        harnesses: ['claude-code'],
      });
    } catch {
      return; // never break the user's session because of why-diff itself (e.g. not a git repo)
    }
    const hits = report.hunks.flatMap((h) =>
      h.match === 'none' ? [] : h.labels.filter((l) => blocking.has(l.kind)).map((l) => `- ${h.hunk.file}:${h.hunk.newStart} ${l.kind}: ${l.detail}`));
    if (!hits.length) return;
    process.stderr.write(
      `why-diff guard: your changes in this session include risky edits:\n${hits.join('\n')}\n\n` +
      'Before finishing: if you skipped, weakened or removed tests (or changed CI/secrets), either revert that change ' +
      'or tell the user explicitly what you changed and why, so they can decide. Do not hide it.\n');
    process.exitCode = 2;
  });

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
