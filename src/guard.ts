/**
 * Claude Code Stop-hook guard: decide whether the agent should be stopped from finishing
 * because ITS OWN edits in this session skipped, weakened or removed tests (or touched CI/secrets).
 *
 * Scoped on purpose: only the files the session's transcript edited are diffed, against the last
 * commit before the session started (so edits the agent already committed still count), and only
 * hunks that the session's edits exactly explain can block. A human's uncommitted change in the
 * same file never does. Every internal error means "do not block".
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { git, hasHead, repoRoot, worktreeRoots } from './git.js';
import { globToRegExp, repoRelativePath, rootVariants } from './attribute.js';
import { loadConfig, type WhyDiffConfig } from './config.js';
import type { Hunk, LabelKind } from './types.js';

export const DEFAULT_BLOCK_ON: readonly LabelKind[] = ['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path'];

export interface GuardPayload {
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

export interface GuardOptions {
  /** Explicit blocking list (`--on`) replaces everything; default: {@link DEFAULT_BLOCK_ON} plus config `blockOn` */
  blocking?: Set<LabelKind>;
  /** Home dir for transcript discovery (tests) */
  home?: string;
  /** Where guard-state.json lives; default `<repo>/.why-diff` */
  stateDir?: string;
}

export interface GuardResult {
  block: boolean;
  message?: string;
  hits: string[];
}

const NO_BLOCK: GuardResult = { block: false, hits: [] };

export async function runGuard(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult> {
  try {
    return await guard(payload, opts);
  } catch {
    return NO_BLOCK; // never break the user's session because of why-diff itself
  }
}

async function guard(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult> {
  if (payload.stop_hook_active) return NO_BLOCK; // already blocked once this turn: let the agent explain and stop
  if (!payload.transcript_path) return NO_BLOCK;

  const root = await repoRoot(payload.cwd ?? process.cwd());
  const session = await claudeCodeAdapter.parse(payload.transcript_path);
  const roots = [root, ...(await worktreeRoots(root))].flatMap(rootVariants).sort((a, b) => b.length - a.length);
  const cwdVariants = rootVariants(session.cwd);
  // Shell commands can name globs (`rm test/*.test.js`): those become `:(glob)` pathspecs,
  // whose `*`/`?` stay within a segment and `**` spans segments, like the shell.
  const paths = [...new Set(session.edits
    .filter((e) => !e.failed)
    .map((e) => {
      const rel = repoRelativePath(e.filePath, roots, session.cwd, cwdVariants);
      if (!rel) return null;
      const p = rel.split(path.sep).join('/');
      return e.kind === 'bash' && SHELL_GLOB.test(p) ? `:(glob)${p}` : `:(literal)${p}`;
    })
    .filter((p): p is string => Boolean(p)))];
  if (!paths.length) return NO_BLOCK;

  let baseRev = 'HEAD';
  if (await hasHead(root)) {
    const before = await git(root, ['rev-list', '-1', `--before=${session.startedAt}`, 'HEAD']).catch(() => '');
    if (before) baseRev = before;
  }

  // The policy comes from the session-start commit, so the agent cannot loosen it mid-session.
  // An invalid config must not break the session: fall back to defaults.
  const config: WhyDiffConfig = await loadConfig(root, baseRev).catch(() => ({}));
  const blocking = opts.blocking ?? new Set<LabelKind>([...DEFAULT_BLOCK_ON, ...(config.blockOn ?? [])]);

  const report = await buildReport({
    cwd: root,
    workingTree: true,
    baseRev,
    paths,
    sessionFiles: [payload.transcript_path],
    harnesses: ['claude-code'],
    home: opts.home,
    config,
    keepAgentIgnored: true,
  });

  // Paths the session's own shell commands removed or moved away (rm, git rm, mv, git mv).
  const removedByShell = new Set(session.edits
    .filter((e) => !e.failed && e.kind === 'bash' && (e.bashOp === 'delete' || e.bashOp === 'move'))
    .map((e) => repoRelativePath(e.filePath, roots, session.cwd, cwdVariants))
    .filter((p): p is string => Boolean(p))
    .map((p) => p.split(path.sep).join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')));
  const shellRemoved = (file: string): boolean => {
    const f = file.replace(/^(\.\/)+/, '');
    for (const r of removedByShell) {
      if (!r) continue;
      if (f === r || f.startsWith(`${r}/`)) return true;
      if (SHELL_GLOB.test(r) && globToRegExp(r).test(f)) return true;
    }
    return false;
  };

  const hits: string[] = [];
  const keys: string[] = [];
  for (const h of report.hunks) {
    if (h.match !== 'exact' && h.match !== 'partial') {
      // A shell delete/rename leaves a file-only hunk: it counts only when the session's own
      // command targeted that path AND the hunk is nothing but that operation (a pure rename with
      // no changed lines, or a whole-file deletion). Line changes on top came from someone else.
      const source = h.hunk.oldFile ?? h.hunk.file;
      if (!(h.match === 'file-only' && shellOnly(h.hunk) && shellRemoved(source))) continue;
    }
    if (!h.editIds.length || !h.editIds.every((id) => id.startsWith(`${session.id}:`))) continue;
    for (const l of h.labels) {
      if (!blocking.has(l.kind)) continue;
      hits.push(`- ${h.hunk.file}:${h.hunk.newStart} ${l.kind}: ${l.detail}`);
      keys.push(`${h.hunk.file}\t${l.kind}\t${l.detail}`);
    }
  }

  const stateDir = opts.stateDir ?? path.join(root, '.why-diff');
  const stateFile = path.join(stateDir, 'guard-state.json');
  const sessionKey = payload.session_id ?? session.id;
  const hash = createHash('sha256').update(keys.sort().join('\n')).digest('hex');
  // State only dedupes repeat blocks: any failure here must never change the decision below.
  try {
    const prev = (await readState(stateFile))[sessionKey];
    if (prev?.hash === hash) return { block: false, hits };
    if (hits.length || prev) await recordState(stateDir, stateFile, sessionKey, { hash, at: new Date().toISOString() });
  } catch {
    // fall through with the computed decision
  }

  if (!hits.length) return NO_BLOCK;
  return {
    block: true,
    hits,
    message:
      `why-diff guard: your changes in this session include risky edits:\n${hits.join('\n')}\n\n` +
      'Before finishing: if you skipped, weakened or removed tests (or changed CI/secrets), either revert that change ' +
      'or tell the user explicitly what you changed and why, so they can decide. Do not hide it.\n',
  };
}

const SHELL_GLOB = /[*?[]/;

/** The hunk is exactly a shell rename (no changed lines) or a shell deletion of the whole file. */
function shellOnly(hunk: Hunk): boolean {
  if (hunk.status === 'renamed') return !hunk.lines.some((l) => l.type === 'add' || l.type === 'del');
  if (hunk.status === 'deleted') return hunk.newLines === 0 && hunk.oldStart <= 1 && hunk.lines.every((l) => l.type === 'del');
  return false;
}

type GuardState = Record<string, { hash: string; at: string }>;
const STATE_TTL_MS = 30 * 86_400_000;

async function readState(file: string): Promise<GuardState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: GuardState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as { hash?: unknown; at?: unknown } | null;
      if (e && typeof e === 'object' && typeof e.hash === 'string' && typeof e.at === 'string') out[k] = { hash: e.hash, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Store one session's entry. Guards of parallel sessions write the same file, so the update runs
 * under an exclusive lock file (`wx` create; a lock older than {@link LOCK_STALE_MS} is taken
 * over), merges into the latest on-disk state, and lands with an atomic temp-file + rename.
 * If the lock cannot be had in time the merged write still happens, unlocked (best effort).
 */
async function recordState(dir: string, file: string, key: string, entry: { hash: string; at: string }): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    if (path.basename(dir) === '.why-diff') {
      await writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    }
    const lock = `${file}.lock`;
    const locked = await acquireLock(lock);
    try {
      const state = await readState(file);
      state[key] = entry;
      const cutoff = Date.now() - STATE_TTL_MS;
      for (const [k, v] of Object.entries(state)) if (!(Date.parse(v.at) >= cutoff)) delete state[k];
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(state));
        await rename(tmp, file);
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    } finally {
      if (locked) await rm(lock, { force: true }).catch(() => {});
    }
  } catch {
    // state is best effort; a failed write only means a possible repeat block
  }
}

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10_000;

async function acquireLock(lock: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
    } catch {
      continue; // released between our attempts
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
  }
}
