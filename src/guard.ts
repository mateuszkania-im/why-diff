/**
 * Claude Code Stop-hook guard: decide whether the agent should be stopped from finishing
 * because ITS OWN edits in this session skipped, weakened or removed tests (or touched CI/secrets).
 *
 * Scoped on purpose: only the files the session's transcript edited are diffed, against the last
 * commit before the session started (so edits the agent already committed still count), and only
 * hunks that the session's edits exactly explain can block. A human's uncommitted change in the
 * same file never does. Every internal error means "do not block".
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { git, hasHead, repoRoot, worktreeRoots } from './git.js';
import { repoRelativePath, rootVariants } from './attribute.js';
import type { LabelKind } from './types.js';

export interface GuardPayload {
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

export interface GuardOptions {
  blocking: Set<LabelKind>;
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
  const paths = [...new Set(session.edits
    .filter((e) => !e.failed)
    .map((e) => repoRelativePath(e.filePath, roots, session.cwd, cwdVariants))
    .filter((p): p is string => Boolean(p)))]
    .map((p) => `:(literal)${p.split(path.sep).join('/')}`);
  if (!paths.length) return NO_BLOCK;

  let baseRev = 'HEAD';
  if (await hasHead(root)) {
    const before = await git(root, ['rev-list', '-1', `--before=${session.startedAt}`, 'HEAD']).catch(() => '');
    if (before) baseRev = before;
  }

  const report = await buildReport({
    cwd: root,
    workingTree: true,
    baseRev,
    paths,
    sessionFiles: [payload.transcript_path],
    harnesses: ['claude-code'],
    home: opts.home,
  });

  const hits: string[] = [];
  const keys: string[] = [];
  for (const h of report.hunks) {
    if (h.match !== 'exact' && h.match !== 'partial') continue;
    if (!h.editIds.length || !h.editIds.every((id) => id.startsWith(`${session.id}:`))) continue;
    for (const l of h.labels) {
      if (!opts.blocking.has(l.kind)) continue;
      hits.push(`- ${h.hunk.file}:${h.hunk.newStart} ${l.kind}: ${l.detail}`);
      keys.push(`${h.hunk.file}\t${l.kind}\t${l.detail}`);
    }
  }

  const stateDir = opts.stateDir ?? path.join(root, '.why-diff');
  const stateFile = path.join(stateDir, 'guard-state.json');
  const sessionKey = payload.session_id ?? session.id;
  const hash = createHash('sha256').update(keys.sort().join('\n')).digest('hex');
  const state = await readState(stateFile);
  const prev = state[sessionKey];
  if (prev?.hash === hash) return { block: false, hits };
  if (hits.length || prev) {
    state[sessionKey] = { hash, at: new Date().toISOString() };
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of Object.entries(state)) if (!(Date.parse(v.at) >= cutoff)) delete state[k];
    await writeState(stateDir, stateFile, state);
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

type GuardState = Record<string, { hash: string; at: string }>;
const STATE_TTL_MS = 30 * 86_400_000;

async function readState(file: string): Promise<GuardState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as GuardState) : {};
  } catch {
    return {};
  }
}

async function writeState(dir: string, file: string, state: GuardState): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    if (path.basename(dir) === '.why-diff') {
      await writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    }
    await writeFile(file, JSON.stringify(state));
  } catch {
    // state is best effort; a failed write only means a possible repeat block
  }
}
