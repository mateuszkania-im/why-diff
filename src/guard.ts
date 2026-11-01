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
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { emptyTree, FailClosedError, git, hasHead, isCaseInsensitive, listUntracked, repoRoot, worktreeRoots } from './git.js';
import { isCiFile, isTestFile } from './labels.js';
import { globToRegExp, repoRelativePath, rootVariants } from './attribute.js';
import { compileGlobs, loadConfig, type WhyDiffConfig } from './config.js';
import type { Hunk, LabelKind, Session } from './types.js';

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
  /** Change time of a path in ms (tests); default: lstat ctime */
  statTime?: (absPath: string) => Promise<number>;
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
  } catch (err) {
    // Fail closed only where git could be made to hide the agent's changes (a filter driver that
    // cannot be switched off, an unreadable config): say so instead of letting the agent finish.
    if (err instanceof FailClosedError) {
      const hit = `- why-diff could not check this session's changes: ${err.message}`;
      return { block: true, hits: [hit], message: `why-diff guard: ${hit.slice(2)}\n\nTell the user that the repository's git configuration stops why-diff from reading the real content of your changes, and what you changed, so they can check it.\n` };
    }
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
  const icase = await isCaseInsensitive(root);
  // Shell commands can name globs (`rm test/*.test.js`): those become `:(glob)` pathspecs,
  // whose `*`/`?` stay within a segment and `**` spans segments, like the shell.
  const paths = [...new Set(session.edits
    .filter((e) => !e.failed)
    .map((e) => {
      const rel = repoRelativePath(e.filePath, roots, session.cwd, cwdVariants);
      if (!rel) return null;
      const p = rel.split(path.sep).join('/');
      // On a case-insensitive file system `TEST/F.test.js` names `test/f.test.js`.
      const magic = `:(${e.kind === 'bash' && SHELL_GLOB.test(p) ? 'glob' : 'literal'}${icase ? ',icase' : ''})`;
      // Paths are compared in NFC; a file stored under its NFD name (Linux) still has to be diffed.
      return [...new Set([p, p.normalize('NFD')])].map((v) => `${magic}${v}`);
    })
    .flatMap((p) => p ?? []))];

  let baseRev = 'HEAD';
  const headed = await hasHead(root);
  if (headed) baseRev = (await sessionBase(root, Date.parse(session.startedAt), opts.statTime ?? changeTime).catch(() => undefined)) ?? 'HEAD';

  // Files a shell command changed without naming them (a script computing the path, `rsync --delete`,
  // a path from the environment, a background process): credited when the file (or, once deleted,
  // the nearest path above it) last changed (ctime) while one of this session's tool calls ran.
  const byWindow = await toolWindowFiles(root, headed ? baseRev : undefined, session, opts.statTime ?? changeTime);
  for (const f of [...byWindow.written, ...byWindow.removed]) paths.push(`:(literal)${f}`);
  if (!paths.length) return NO_BLOCK;

  // The policy comes from the session-start commit, so the agent cannot loosen it mid-session.
  // An invalid config must not break the session: fall back to defaults.
  const config: WhyDiffConfig = await loadConfig(root, baseRev).catch(() => ({}));
  const blocking = opts.blocking ?? new Set<LabelKind>([...DEFAULT_BLOCK_ON, ...(config.blockOn ?? [])]);
  const protectedGlob = compileGlobs(config.protected);

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

  // Paths the session's own shell commands targeted literally (or by a glob), by kind of operation:
  // removed or moved away (rm, git rm, mv, git mv), or rewritten in place (sed -i, perl -i, `>`,
  // tee, cp onto it, truncate, inline python/node scripts that open the path for writing).
  const shellTargets = (ops: ReadonlySet<string>): Set<string> => new Set(session.edits
    .filter((e) => !e.failed && e.kind === 'bash' && ops.has(e.bashOp ?? ''))
    .map((e) => repoRelativePath(e.filePath, roots, session.cwd, cwdVariants))
    .filter((p): p is string => Boolean(p))
    .map((p) => p.split(path.sep).join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')));
  const removedByShell = shellTargets(REMOVE_OPS);
  const rewrittenByShell = shellTargets(REWRITE_OPS);
  const targeted = (targets: Set<string>, file: string, dirs: boolean): boolean => {
    let f = file.normalize('NFC').replace(/^(\.\/)+/, '');
    if (icase) f = f.toLowerCase();
    for (let r of targets) {
      if (!r) continue;
      if (icase) r = r.toLowerCase();
      if (f === r || (dirs && f.startsWith(`${r}/`))) return true;
      if (SHELL_GLOB.test(r) && globToRegExp(r).test(f)) return true;
    }
    return false;
  };

  const hits: string[] = [];
  const keys: string[] = [];
  for (const h of report.hunks) {
    // Fail closed: a file the session touched that git attributes show as binary and whose text could
    // not be produced blocks when it is a test, CI or protected file, whoever wrote it.
    if (h.labels.some((l) => l.kind === 'unreviewed')) {
      const names = [h.hunk.file, ...(h.hunk.oldFile ? [h.hunk.oldFile] : [])];
      if (names.some((f) => isTestFile(f) || isCiFile(f) || protectedGlob(f))) {
        const detail = `could not be diffed as text (git attributes mark it binary): ${h.hunk.file}`;
        hits.push(`- ${h.hunk.file} unreviewed: ${detail}`);
        keys.push(`${h.hunk.file}\tunreviewed\t${detail}`);
        continue;
      }
    }
    let timed = false;
    if (h.match !== 'exact' && h.match !== 'partial') {
      // A shell command leaves a file-only hunk. It counts only when the session's own command
      // named that path (literally or by a glob): a delete/rename when the hunk is nothing but that
      // operation (a pure rename with no changed lines, or a whole-file deletion; line changes on
      // top came from someone else), an in-place rewrite of the file for any of its hunks.
      // A file the agent never named in a command is never credited.
      const source = h.hunk.oldFile ?? h.hunk.file;
      const removed = h.match === 'file-only' && shellOnly(h.hunk) && targeted(removedByShell, source, true);
      const rewritten = h.match === 'file-only' && h.hunk.status !== 'renamed' && targeted(rewrittenByShell, h.hunk.file, false);
      // Not named by any command: the file's own change time (or, once deleted, its directory's) inside a
      // tool call window. A rewrite counts for every hunk of the file; a deletion or rename only
      // when the hunk is nothing but that operation.
      if (!removed && !rewritten) {
        timed = h.hunk.status === 'renamed'
          ? shellOnly(h.hunk) ? byWindow.removed.has(source) : byWindow.removed.has(source) && byWindow.written.has(h.hunk.file)
          : h.hunk.status === 'deleted' ? shellOnly(h.hunk) && byWindow.removed.has(h.hunk.file) : byWindow.written.has(h.hunk.file);
        if (!timed) continue;
      }
    }
    // Every explaining edit must be this session's; a hunk credited by its change time alone may have none.
    if ((!h.editIds.length && !timed) || !h.editIds.every((id) => id.startsWith(`${session.id}:`))) continue;
    const labels = [...h.labels];
    if (timed && !labels.some((l) => l.kind === 'protected-path')) {
      // `protected-path` is only set on hunks an agent edit explains; a timed hunk is one too.
      const glob = protectedGlob(h.hunk.file) ?? (h.hunk.oldFile ? protectedGlob(h.hunk.oldFile) : undefined);
      if (glob) labels.push({ kind: 'protected-path', severity: 'risk', detail: `Protected path (${glob}): ${h.hunk.file}` });
    }
    for (const l of labels) {
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
/** Clock slack on each side of a tool call window (transcript stamps vs file system times). */
const WINDOW_SLACK_MS = 2000;
const LSTAT_BATCH = 64;
/** lstat errors meaning "this path is not there any more" (as opposed to unreadable). */
const GONE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/**
 * When a path last changed: its ctime. A command can backdate mtime (`touch -d`, `utimes`) but not
 * ctime, and any later write (a human edit) moves ctime past the window. On Windows libuv fills
 * `ctimeMs` from the NTFS ChangeTime, which `utimes` cannot set either.
 */
async function changeTime(p: string): Promise<number> {
  return (await lstat(p)).ctimeMs;
}

/**
 * Changed files (against `rev`, working tree and untracked) whose change time lies inside one of the
 * session's tool call windows (`written`), and deleted ones whose nearest existing ancestor's time
 * does (`removed`). A human edit after the call moves the time out of every window, so it is never
 * credited; a human edit while an agent tool call is running is (the one edge; long calls, subagents
 * and background processes widen it).
 */
async function toolWindowFiles(root: string, rev: string | undefined, session: Session, timeOf: (p: string) => Promise<number>): Promise<{ written: Set<string>; removed: Set<string> }> {
  const written = new Set<string>();
  const removed = new Set<string>();
  const now = Date.now();
  const windows = (session.toolWindows ?? [])
    // An open window (background or detached process, no result yet) lasts until this guard runs.
    .map((w) => ({ start: Date.parse(w.start), end: w.open ? Math.max(now, Date.parse(w.end)) : Date.parse(w.end) }))
    // Long calls are kept: dropping them would let `sleep 700; node fix.js` slip through.
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .map((w) => ({ start: w.start - WINDOW_SLACK_MS, end: w.end + WINDOW_SLACK_MS }));
  if (!windows.length) return { written, removed };
  const inWindow = (ms: number): boolean => windows.some((w) => ms >= w.start && ms <= w.end);

  const changed = await git(root, ['diff', '--name-only', '--no-renames', '-z', rev ?? (await emptyTree(root)), '--'], { trim: false }).catch(() => '');
  const files = [...new Set([...changed.split('\0').filter(Boolean), ...(await listUntracked(root).catch(() => []))])]
    .filter((f) => !f.startsWith('.why-diff/'));
  // `git rev-parse --show-toplevel` prints `C:/x` on Windows: resolve it so the walk below compares like with like.
  const top = path.resolve(root);
  for (let i = 0; i < files.length; i += LSTAT_BATCH) {
    await Promise.all(files.slice(i, i + LSTAT_BATCH).map(async (f) => {
      const abs = path.join(top, ...f.split('/'));
      try {
        if (inWindow(await timeOf(abs))) written.add(f);
        return;
      } catch (err) {
        if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) return;
      }
      // Deleted: date it by the nearest path above it that still exists (up to the repo root). A
      // parent replaced by a file (ENOTDIR) or a symlink loop (ELOOP) is gone as a directory too.
      for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
        try {
          if (inWindow(await timeOf(dir))) removed.add(f);
          return;
        } catch (err) {
          if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) return;
        }
        if (dir === top || path.dirname(dir) === dir || !dir.startsWith(top)) return;
      }
    }));
  }
  return { written, removed };
}
/**
 * The commit HEAD pointed at when the session started: the diff base, so edits the agent committed
 * during the session still count. Committer dates are the agent's to set (`GIT_COMMITTER_DATE`, which
 * also stamps the reflog entry), so dates only pick candidates: HEAD's reflog (newest first; the
 * first-parent history when there is no reflog) is walked to the first entry stamped before the
 * session start whose commit object was not written during the session, judged by the change time
 * of its loose object file (or, once packed, by whether any pack file was written during the
 * session). Without such an entry the oldest one is used. A base that is no longer an ancestor of
 * HEAD (an amend, a rebase) becomes its merge base with HEAD.
 */
async function sessionBase(root: string, startedAt: number, timeOf: (p: string) => Promise<number>): Promise<string | undefined> {
  if (!Number.isFinite(startedAt)) return undefined;
  const parse = (out: string, unit: number): Array<{ sha: string; at: number }> => out.split('\n').map((l) => {
    const m = /^([0-9a-f]{40,64})\t(?:HEAD@\{)?(\d+)\}?$/.exec(l.trim());
    return m ? { sha: m[1]!, at: Number(m[2]) * unit } : null;
  }).filter((e): e is { sha: string; at: number } => e !== null);
  let entries = parse(await git(root, ['reflog', 'show', '--format=%H%x09%gd', '--date=unix', 'HEAD', '--']).catch(() => ''), 1000);
  if (!entries.length) entries = parse(await git(root, ['log', '--first-parent', '-n', '2000', '--format=%H%x09%ct', 'HEAD', '--']).catch(() => ''), 1000);
  if (!entries.length) return undefined;

  const objects = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'objects']));
  const cutoff = startedAt - WINDOW_SLACK_MS;
  let packedDuringSession: boolean | undefined;
  const writtenDuringSession = async (sha: string): Promise<boolean> => {
    try {
      return (await timeOf(path.join(objects, sha.slice(0, 2), sha.slice(2)))) >= cutoff;
    } catch {
      // packed: its own time is unknown, so trust it only if no pack was written during the session
      if (packedDuringSession === undefined) {
        const dir = path.join(objects, 'pack');
        const packs = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.pack'));
        const times = await Promise.all(packs.map((f) => timeOf(path.join(dir, f)).catch(() => Infinity)));
        packedDuringSession = times.some((t) => t >= cutoff);
      }
      return packedDuringSession;
    }
  };
  let base = entries[entries.length - 1]!.sha;
  for (const e of entries) {
    if (e.at > startedAt) continue;
    if (!(await git(root, ['cat-file', '-e', `${e.sha}^{commit}`]).then(() => true, () => false))) continue;
    if (await writtenDuringSession(e.sha)) continue;
    base = e.sha;
    break;
  }
  const ancestor = await git(root, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false);
  if (!ancestor) base = await git(root, ['merge-base', base, 'HEAD']).catch(() => base);
  return base;
}

const REMOVE_OPS: ReadonlySet<string> = new Set(['delete', 'move']);
const REWRITE_OPS: ReadonlySet<string> = new Set(['edit', 'write', 'append', 'copy']);

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
 * under an exclusive lock file (`wx` create; a lock older than {@link LOCK_STALE} is taken
 * over), merges into the latest on-disk state, and lands with an atomic temp-file + rename.
 * If the lock cannot be had, nothing is written (a possible repeat block, never a hang).
 */
async function recordState(dir: string, file: string, key: string, entry: { hash: string; at: string }): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    if (path.basename(dir) === '.why-diff') {
      await writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    }
    const lock = `${file}.lock`;
    // No lock, no write: the state only dedupes repeat blocks, so skipping it is always safe.
    const token = await acquireLock(lock);
    if (!token) return;
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
      await releaseLock(lock, token);
    }
  } catch {
    // state is best effort; a failed write only means a possible repeat block
  }
}

const LOCK_WAIT_MS = 3000;
const LOCK_STALE = 10_000;

const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));

/**
 * Take the state lock: exclusive `wx` create of a regular file. A lock older than `staleMs` is
 * removed and retried. Every iteration checks the deadline first and every retry sleeps, so this
 * always returns within about `waitMs`: a random owner token, or null (no lock) on timeout, on a
 * lock path that is not a regular file, on a stale lock that cannot be removed, or on any
 * unexpected error. The guard must never hang; without the lock the dedupe state is not written.
 *
 * Known race, accepted: two waiters can both judge the same lock stale, and the second can remove
 * the lock the first just took over. Both then write; the worst outcome is a lost dedupe entry, so
 * one repeat block, never a missed one. The owner token keeps a writer from removing a lock that
 * is no longer its own on release.
 */
export async function acquireLock(lock: string, opts: { waitMs?: number; staleMs?: number } = {}): Promise<string | null> {
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  const staleMs = opts.staleMs ?? LOCK_STALE;
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  for (;;) {
    if (Date.now() > deadline) return null;
    try {
      await writeFile(lock, token, { flag: 'wx' });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    let info;
    try {
      info = await lstat(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      await pause(); // released between our attempts
      continue;
    }
    if (!info.isFile()) return null; // a directory, symlink or device is never our lock
    if (Date.now() - info.mtimeMs > staleMs) {
      try {
        await rm(lock);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
    }
    await pause();
  }
}

/** Remove the lock only while it still holds our token (it may have been taken over as stale). */
export async function releaseLock(lock: string, token: string): Promise<void> {
  try {
    if ((await readFile(lock, 'utf8')) === token) await rm(lock, { force: true });
  } catch {
    // gone already, or unreadable: leave it; it goes stale and is taken over
  }
}
