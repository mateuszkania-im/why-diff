/**
 * The why-diff pipeline: git diff + agent transcripts -> attributed, labelled, (optionally) intent-checked report.
 */
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Harness, Report, Session, SessionAdapter } from './types.js';
import { getDiff, git, repoRoot as findRepoRoot, currentBranch, repoName, resolveDefaultTarget, commitTimes, isShallow, worktreeRoots, SHALLOW_HINT, type DiffTarget } from './git.js';
import { parseUnifiedDiff } from './diff-parse.js';
import { attribute } from './attribute.js';
import { labelHunks, needsFileText } from './labels.js';
import { contributingSessionIds, summarize } from './summary.js';
import { compactHunks, editTable } from './compact.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { redactReport } from './redact.js';
import { createClassifier, classifyHunks, summarizeIntent, type ClassifierKind } from './classify/index.js';

export const ADAPTERS: Record<Harness, SessionAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export interface BuildOptions {
  /** Directory inside the repo (default: process.cwd()) */
  cwd?: string;
  /** Git range like `main...HEAD`, a commit, or undefined for auto (branch + working tree) */
  range?: string;
  /** Base ref to compare the branch against (overrides CI/default-branch detection) */
  base?: string;
  /** Only the uncommitted working tree vs HEAD */
  workingTree?: boolean;
  /** With `workingTree`: diff against this exact revision instead of HEAD */
  baseRev?: string;
  /** Git pathspecs limiting the diff to these paths (tracked and untracked) */
  paths?: string[];
  /** Harnesses to read; default all */
  harnesses?: Harness[];
  /** Explicit transcript files (skips discovery) */
  sessionFiles?: string[];
  /** Override discovery window start */
  since?: Date;
  /** Home dir (tests) */
  home?: string;
  /**
   * Also scan transcripts whose cwd is outside the repo (a sibling folder, a
   * workspace root) for edits of files under the repo root. Reads every
   * transcript modified in the window, so it is opt-in.
   */
  scanAll?: boolean;
  /** LLM intent check backend; 'none' to skip */
  classify?: ClassifierKind;
  model?: string;
  /** Progress callback for the CLI */
  onProgress?: (msg: string) => void;
}

/** Injected by the standalone build (scripts/build.mjs); absent under tsx/vitest. */
declare const __WHY_DIFF_VERSION__: string | undefined;

async function readVersion(): Promise<string> {
  if (typeof __WHY_DIFF_VERSION__ === 'string') return __WHY_DIFF_VERSION__;
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const p of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
      try {
        const pkg = JSON.parse(await readFile(p, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'why-diff' && pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return '0.0.0';
}

/** Build a full provenance report for the repository containing `opts.cwd`. */
export async function buildReport(opts: BuildOptions = {}): Promise<Report> {
  const log = opts.onProgress ?? (() => {});
  const root = await findRepoRoot(opts.cwd ?? process.cwd());

  let target: DiffTarget;
  let rangeLabel: string;
  if (opts.workingTree) {
    target = { workingTree: true, includeUntracked: true, ...(opts.baseRev ? { baseRev: opts.baseRev } : {}) };
    rangeLabel = 'working tree';
  } else if (opts.range) {
    target = opts.range;
    rangeLabel = opts.range;
  } else {
    const resolved = await resolveDefaultTarget(root, process.env, opts.base);
    if (opts.base && !resolved.base) throw new Error(`cannot compare against --base ${opts.base}: ref not found or no commits beyond it`);
    if (!resolved.base && !resolved.onBase && (await isShallow(root))) throw new Error(SHALLOW_HINT);
    target = resolved.target;
    rangeLabel = resolved.label;
  }

  log(`diffing ${rangeLabel}`);
  const hunks = parseUnifiedDiff(await getDiff(root, target, { paths: opts.paths }));

  const window = await commitTimes(root, target).catch(() => undefined);
  const since = opts.since ?? (window ? new Date(new Date(window.since).getTime() - 6 * 3600_000) : undefined);

  const sessions: Session[] = [];
  const extraRoots = await worktreeRoots(root);
  if (opts.sessionFiles?.length) {
    for (const file of opts.sessionFiles) {
      const adapter = guessAdapter(file);
      sessions.push(await adapter.parse(file));
    }
  } else {
    const harnesses = opts.harnesses ?? (Object.keys(ADAPTERS) as Harness[]);
    for (const h of harnesses) {
      const adapter = ADAPTERS[h];
      let paths: string[] = [];
      try {
        paths = await adapter.discover(root, { since, home: opts.home, scanAll: opts.scanAll, extraRoots });
      } catch { /* harness not installed */ }
      for (const p of paths) {
        try {
          const s = await adapter.parse(p);
          if (s.edits.length || s.prompts.length) sessions.push(s);
        } catch (err) {
          log(`skipped unreadable ${h} transcript ${path.basename(p)}: ${(err as Error).message}`);
        }
      }
    }
    if (sessions.length === 0 && hunks.length > 0 && !opts.scanAll) {
      log('no agent sessions found for this repo in the time window; if the agent ran from another folder, try --scan-all (or --since / --session)');
    }
  }
  log(`found ${sessions.length} agent session(s), ${hunks.length} hunk(s)`);

  const prompts = sessions.flatMap((s) => s.prompts);
  let attributed = attribute(hunks, sessions, root, { since, extraRoots });
  const texts = await loadConfigTexts(root, target, [...new Set(hunks.filter((h) => h.status !== 'deleted').map((h) => h.file))]);
  attributed = labelHunks(attributed, { prompts, repoRoot: root, fileText: (p) => texts.get(p) });
  // Without any transcript every hunk would be "unattributed": noise, not a finding.
  const mode: Report['mode'] = sessions.length === 0 ? 'risk-scan' : 'provenance';
  if (mode === 'risk-scan') attributed = attributed.map((h) => ({ ...h, labels: h.labels.filter((l) => l.kind !== 'unattributed') }));

  const kind = opts.classify ?? 'none';
  if (kind !== 'none' && attributed.length && mode === 'risk-scan') {
    log('no agent transcripts, so there are no prompts to check intent against; skipping intent check');
  } else if (kind !== 'none' && attributed.length) {
    const classifier = createClassifier(kind, { model: opts.model, onProgress: (done: number, total: number) => log(`intent check ${done}/${total} batches`) });
    if (classifier) {
      log(`checking intent with ${classifier.name}`);
      attributed = await classifyHunks(attributed, prompts, classifier, { repoRoot: root });
    } else {
      log('no LLM backend available (install Claude Code, or set ANTHROPIC_API_KEY / OPENAI_API_KEY); skipping intent check');
    }
  }

  const summary = summarize(attributed, sessions);
  if (attributed.some((h) => h.intent)) summary.intent = summarizeIntent(attributed);

  const usedPromptIds = new Set(attributed.map((h) => h.prompt?.id).filter(Boolean));
  const contributing = contributingSessionIds(attributed);
  const home = opts.home ?? os.homedir();
  return redactReport({
    schemaVersion: 1,
    version: await readVersion(),
    generatedAt: new Date().toISOString(),
    repo: { root, name: await repoName(root), branch: await currentBranch(root) },
    range: rangeLabel,
    mode,
    sessions: sessions
      .filter((s) => contributing.has(s.id))
      .map(({ id, harness, path: p, startedAt, endedAt, title }) => ({ id, harness, path: tildify(p, home), startedAt, endedAt, title })),
    prompts: prompts.filter((p) => usedPromptIds.has(p.id)),
    edits: editTable(attributed, sessions),
    hunks: compactHunks(attributed),
    summary,
  }, 'secrets');
}

/** Replace a leading home directory with `~` so reports do not leak the user name. */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, '');
  return p === h ? '~' : p.startsWith(h + '/') || p.startsWith(h + '\\') ? '~' + p.slice(h.length) : p;
}

function guessAdapter(file: string): SessionAdapter {
  if (file.includes('.codex') || /rollout-.*\.jsonl$/.test(file)) return codexAdapter;
  if (file.includes('opencode')) return opencodeAdapter;
  return claudeCodeAdapter;
}

const FILE_TEXT_CAP = 512 * 1024;

/**
 * Post-image text of the runner-config files in the diff (vitest/jest/pytest
 * config, package.json, CI workflows), so labels can see the keys around a
 * change. Working-tree targets and single-revision ranges read the disk;
 * `a..b` / `a...b` ranges read `b` (default HEAD) from git. Best effort:
 * unreadable or oversized files are simply absent.
 */
async function loadConfigTexts(root: string, target: DiffTarget, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let rev: string | null = null;
  if (typeof target === 'string') {
    const m = /^(?:.*?)\.\.\.?(.*)$/.exec(target);
    if (m) rev = m[1] || 'HEAD';
    if (rev?.startsWith('-')) return out;
  }
  for (const rel of files) {
    if (!needsFileText(rel)) continue;
    try {
      const text = rev === null
        ? await readFile(path.join(root, rel), 'utf8')
        : await git(root, ['show', `${rev}:${rel}`], { trim: false });
      if (text.length <= FILE_TEXT_CAP) out.set(rel, text);
    } catch { /* absent on that side */ }
  }
  return out;
}
