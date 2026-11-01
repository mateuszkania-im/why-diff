/**
 * The why-diff pipeline: git diff + agent transcripts -> attributed, labelled, (optionally) intent-checked report.
 */
import os from 'node:os';
import path from 'node:path';
import { lstat, readFile, stat } from 'node:fs/promises';
import type { Harness, Hunk, Prompt, Report, Session, SessionAdapter } from './types.js';
import { getDiffDetailed, git, isCaseInsensitive, mergeBase, hasHead, repoRoot as findRepoRoot, currentBranch, repoName, resolveDefaultTarget, commitTimes, isShallow, worktreeRoots, SHALLOW_HINT, type DiffTarget } from './git.js';
import { parseUnifiedDiff } from './diff-parse.js';
import { attribute, repoRelativePath, rootVariants } from './attribute.js';
import { labelHunks, needsFileText } from './labels.js';
import { contributingSessionIds, summarize } from './summary.js';
import { compactHunks, editTable } from './compact.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { redactReport } from './redact.js';
import { compileGlobs, configChanged, loadConfig, samePath, CONFIG_FILE, type WhyDiffConfig } from './config.js';
import { createClassifier, classifyHunks, summarizeIntent, type ClassifierKind } from './classify/index.js';
import { DRIVE_PATH, driveKey } from './adapters/scan.js';
import { applyNotes, readNotes, NOTE_MODEL, NOTES_REF } from './notes.js';

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
  /** With auto base detection: diff `<base>...HEAD` only (committed work), not the working tree on top */
  committedOnly?: boolean;
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
  /** Team rules; default: read from the repo root at the base revision (`.why-diff.json`) */
  config?: WhyDiffConfig;
  /** Never drop hunks the agent edited because of `ignore` (the guard sets this) */
  keepAgentIgnored?: boolean;
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
    if (!resolved.base && !resolved.onBase) {
      // Shallow first: in a depth-1 checkout the base ref is merely missing, and fetching history is the fix.
      if (await isShallow(root)) throw new Error(SHALLOW_HINT);
      if (opts.base) throw new Error(`cannot compare against --base ${opts.base}: ref not found or no commits beyond it`);
    }
    if (opts.committedOnly && resolved.base) {
      target = `${resolved.base}...HEAD`;
      rangeLabel = target;
    } else {
      target = resolved.target;
      rangeLabel = resolved.label;
    }
  }

  const baseRev = await policyRev(root, target);
  const config = opts.config ?? (await loadConfig(root, baseRev, log));
  const protectedGlob = compileGlobs(config.protected);
  const ignoredGlob = compileGlobs(config.ignore);

  log(`diffing ${rangeLabel}`);
  const detailed = await getDiffDetailed(root, target, { paths: opts.paths });
  const allHunks = parseUnifiedDiff(detailed.diff);
  const unreviewed = new Set(detailed.unreviewed);

  // The team-rules files themselves: any change is a finding, and `ignore` can never hide it.
  const rulesFiles = new Set<string>();
  for (const h of allHunks) {
    if (samePath(h.file, CONFIG_FILE) || (h.oldFile !== undefined && samePath(h.oldFile, CONFIG_FILE))) rulesFiles.add(h.file);
  }
  const pkgHunks = allHunks.filter((h) => samePath(h.file, 'package.json'));
  if (pkgHunks.length && (await configChanged(root, baseRev, headRevOf(target)))) for (const h of pkgHunks) rulesFiles.add(h.file);

  const isIgnored = (h: Hunk): boolean =>
    Boolean(ignoredGlob(h.file)) && (!h.oldFile || Boolean(ignoredGlob(h.oldFile))) &&
    !protectedGlob(h.file) && !(h.oldFile && protectedGlob(h.oldFile)) && !rulesFiles.has(h.file);
  const hunks = opts.keepAgentIgnored ? allHunks : allHunks.filter((h) => !isIgnored(h));
  let ignoredHunks = allHunks.length - hunks.length;

  const window = await commitTimes(root, target).catch(() => undefined);
  const since = opts.since ?? (window ? new Date(new Date(window.since).getTime() - 6 * 3600_000) : undefined);

  const sessions: Session[] = [];
  const extraRoots = await worktreeRoots(root);
  if (opts.sessionFiles?.length) {
    for (const file of opts.sessionFiles) {
      await checkSessionFile(file);
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
  let attributed = attribute(hunks, sessions, root, { since, extraRoots, ignoreCase: await isCaseInsensitive(root) });
  if (opts.keepAgentIgnored) {
    // Guard: ignore may drop only hunks no session edit explains.
    const kept = attributed.filter((h) => !(isIgnored(h.hunk) && h.match === 'none'));
    ignoredHunks = attributed.length - kept.length;
    attributed = kept;
  }
  // Without any transcript every hunk would be "unattributed": noise, not a finding.
  let mode: Report['mode'] = sessions.length === 0 ? 'risk-scan' : 'provenance';
  const texts = await loadConfigTexts(root, target, [...new Set(hunks.filter((h) => h.status !== 'deleted').map((h) => h.file))]);
  const packages = await pythonPackageDirs(root, baseRev, hunks);
  attributed = labelHunks(attributed, { prompts, repoRoot: root, fileText: (p) => texts.get(p), protectedGlob, riskScan: mode === 'risk-scan', rulesFiles, pythonPackage: (d) => packages.has(d) });
  if (mode === 'risk-scan') attributed = attributed.map((h) => ({ ...h, labels: h.labels.filter((l) => l.kind !== 'unattributed') }));
  // Fail closed: a file git attributes show as binary, whose text could not be produced, is a finding.
  if (unreviewed.size) {
    attributed = attributed.map((h) => (unreviewed.has(h.hunk.file) || (h.hunk.oldFile !== undefined && unreviewed.has(h.hunk.oldFile))
      ? { ...h, labels: [...h.labels, { kind: 'unreviewed', severity: 'risk', detail: `Shown as binary by git attributes and too big to diff as text: ${h.hunk.file}` }] }
      : h));
  }

  // No transcripts here: the author may have left provenance as git notes (`why-diff notes`).
  // They add prompts to the hunks they cover; labels stay the ones computed above from the diff.
  let reportSessions: Session[] = sessions;
  let reportPrompts: Prompt[] = prompts;
  if (mode === 'risk-scan' && attributed.length) {
    const notes = await readNotes(root, target).catch(() => []);
    if (notes.length) {
      const noted = applyNotes(attributed, notes);
      if (noted.applied > 0) {
        attributed = noted.hunks;
        mode = 'notes';
        reportSessions = noted.sessions;
        reportPrompts = noted.prompts;
        log(`read provenance for ${noted.applied} hunk(s) from git notes (${NOTES_REF})`);
      }
    }
  }

  const kind = opts.classify ?? 'none';
  if (kind !== 'none' && attributed.length && mode !== 'provenance') {
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

  const summary = summarize(attributed, reportSessions);
  if (ignoredHunks > 0) summary.ignoredHunks = ignoredHunks;
  // A verdict copied from a note is shown, but it is not an intent check that ran here.
  if (attributed.some((h) => h.intent && h.intent.model !== NOTE_MODEL)) summary.intent = summarizeIntent(attributed);

  const usedPromptIds = new Set(attributed.map((h) => h.prompt?.id).filter(Boolean));
  const contributing = contributingSessionIds(attributed);
  const home = opts.home ?? os.homedir();
  // Reports are shared: edit paths are stored repo-relative (tildified when outside the repo), so
  // they do not carry the user's home directory. Absolute paths are only used above, for matching.
  const pathRoots = [root, ...extraRoots].flatMap(rootVariants).sort((a, b) => b.length - a.length);
  const cwdOf = new Map(sessions.map((s) => [s.id, s.cwd]));
  const publicPath = (e: { filePath: string; sessionId: string }): string => {
    const rel = repoRelativePath(e.filePath, pathRoots, cwdOf.get(e.sessionId) ?? '');
    return rel ? rel.split(path.sep).join('/') : tildify(e.filePath, home);
  };
  const edits = editTable(attributed, sessions);
  for (const e of Object.values(edits)) e.filePath = publicPath(e);
  const reportHunks = compactHunks(attributed).map((h) => (h.edits.length ? { ...h, edits: h.edits.map((e) => ({ ...e, filePath: publicPath(e) })) } : h));
  return redactReport({
    schemaVersion: 1,
    version: await readVersion(),
    generatedAt: new Date().toISOString(),
    repo: { root: tildify(root, home), name: await repoName(root), branch: await currentBranch(root) },
    range: rangeLabel,
    includesWorkingTree: typeof target !== 'string',
    mode,
    sessions: reportSessions
      .filter((s) => contributing.has(s.id))
      .map(({ id, harness, path: p, startedAt, endedAt, title }) => ({ id, harness, path: tildify(p, home), startedAt, endedAt, title })),
    prompts: reportPrompts.filter((p) => usedPromptIds.has(p.id)),
    edits,
    hunks: reportHunks,
    summary,
  }, 'secrets');
}

/**
 * Revision the team rules are read from: the left side of the diff, so a change
 * cannot rewrite the policy it is judged by. Undefined: read the working tree.
 */
async function policyRev(root: string, target: DiffTarget): Promise<string | undefined> {
  if (typeof target === 'string') {
    if (target.startsWith('-')) return undefined;
    const m = /^(.*?)(\.\.\.?)(.*)$/.exec(target);
    if (!m) return target;
    const left = m[1] || 'HEAD';
    return m[2] === '...' ? await mergeBase(root, left, m[3] || 'HEAD').catch(() => left) : left;
  }
  if (!(await hasHead(root))) return undefined;
  if (target.baseRev) return target.baseRev;
  return target.base ? await mergeBase(root, target.base, 'HEAD').catch(() => 'HEAD') : 'HEAD';
}

/** Revision holding the right side of the diff; undefined = the working tree. */
function headRevOf(target: DiffTarget): string | undefined {
  if (typeof target !== 'string') return undefined;
  const m = /^(?:.*?)\.\.\.?(.*)$/.exec(target);
  return m ? m[1] || 'HEAD' : undefined;
}

/**
 * Directories of Python sources deleted or renamed away in the diff that are packages: they hold
 * an `__init__.py` at the base revision (`rev`), or on disk when there is no base commit. One
 * check per directory.
 */
async function pythonPackageDirs(root: string, rev: string | undefined, hunks: Hunk[]): Promise<Set<string>> {
  const dirs = new Set<string>();
  for (const h of hunks) {
    const gone = h.status === 'deleted' ? h.file : h.status === 'renamed' && h.oldFile && h.oldFile !== h.file ? h.oldFile : null;
    if (gone?.endsWith('.py')) dirs.add(path.posix.dirname(gone));
  }
  const out = new Set<string>();
  for (const dir of dirs) {
    const init = dir === '.' ? '__init__.py' : `${dir}/__init__.py`;
    try {
      if (rev !== undefined && !rev.startsWith('-')) await git(root, ['cat-file', '-e', `${rev}:${init}`]);
      else await lstat(path.join(root, init));
      out.add(dir);
    } catch { /* not a package */ }
  }
  return out;
}

/** A clear error for a `--session` argument that is not a readable transcript file. */
async function checkSessionFile(file: string): Promise<void> {
  let info;
  try {
    info = await stat(/^(.*\.db)#[^#/\\]+$/.exec(file)?.[1] ?? file); // opencode `<db>#<session id>`
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `--session ${file}: file not found` : `--session ${file}: cannot read (${code ?? (err as Error).message})`);
  }
  if (info.isDirectory()) throw new Error(`--session ${file}: is a directory; pass a transcript file (a .jsonl, or an opencode session .json / .db)`);
}

/** Replace a leading home directory with `~` so reports do not leak the user name. */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, '');
  if (DRIVE_PATH.test(p) && DRIVE_PATH.test(h)) {
    // Windows: git prints `C:/Users/x`, the home is `C:\\Users\\x`; compare without case or slash style.
    const pk = driveKey(p);
    const hk = driveKey(h);
    if (pk === hk) return '~';
    return pk.startsWith(`${hk}/`) ? `~${p.replace(/\\/g, '/').replace(/\/+$/, '').slice(hk.length)}` : p;
  }
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
      // A symlink on disk is never followed (it may point outside the repo).
      const text = rev === null
        ? ((await lstat(path.join(root, rel))).isSymbolicLink() ? null : await readFile(path.join(root, rel), 'utf8'))
        : await git(root, ['show', '--no-textconv', `${rev}:${rel}`], { trim: false });
      if (text !== null && text.length <= FILE_TEXT_CAP) out.set(rel, text);
    } catch { /* absent on that side */ }
  }
  return out;
}
