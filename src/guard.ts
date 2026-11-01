/**
 * Claude Code Stop-hook guard: decide whether the agent should be stopped from finishing
 * because ITS OWN edits in this session skipped, weakened or removed tests (or touched CI/secrets).
 *
 * Scoped on purpose: only the files the session's transcript edited are diffed, against the last
 * commit before the session started (so edits the agent already committed still count), and only
 * hunks that the session's edits exactly explain can block. A human's uncommitted change in the
 * same file never does. Once the session is known to have touched the repository (or its transcript
 * cannot be read), any error while checking it blocks, with the reason: the agent can break what
 * the guard reads (a truncated index, an unreadable file), and that must not let it finish unchecked.
 */
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { emptyTree, FailClosedError, git, hasHead, indexEntries, isCaseInsensitive, listUntracked, repoRoot, sparseExcluded, sparseMissing, worktreeRoots, type SparseTrust } from './git.js';
import { globToRegExp, repoRelativePath, rootVariants } from './attribute.js';
import { compileGlobs, loadConfig, type WhyDiffConfig } from './config.js';
import type { Hunk, LabelKind, Session } from './types.js';
import { recordPath, type BaseRecord } from './session-start.js';

export const DEFAULT_BLOCK_ON: readonly LabelKind[] = ['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path', 'unreviewed'];

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
  /** Change time of a path in ms (tests); default: lstat ctime */
  statTime?: (absPath: string) => Promise<number>;
  /** Change time of git object store files, for choosing the session base (tests); default: lstat ctime */
  objectTime?: (absPath: string) => Promise<number>;
}

export interface GuardResult {
  block: boolean;
  message?: string;
  hits: string[];
  /** The check ran past its internal deadline (and blocks): the caller should exit now */
  timedOut?: boolean;
}

const NO_BLOCK: GuardResult = { block: false, hits: [] };

/** Internal time limit of one guard run, below Claude Code's 30 s hook timeout (`WHY_DIFF_GUARD_DEADLINE_MS` overrides it, for tests). */
const DEADLINE_MS = 20_000;

/**
 * Decide whether to block the Stop. A run that does not finish within {@link DEADLINE_MS} blocks:
 * a hook killed by Claude Code's own timeout would let the agent finish unchecked, and the agent
 * can make the check slow (a hundred thousand untracked files).
 */
export async function runGuard(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult> {
  const env = Number(process.env.WHY_DIFF_GUARD_DEADLINE_MS);
  const ms = Number.isFinite(env) && env > 0 ? env : DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<GuardResult>((resolve) => {
    timer = setTimeout(() => {
      const hit = `- why-diff could not check this session: it did not finish within ${ms / 1000} s (the Stop hook's time limit is 30 s), so its changes were not reviewed`;
      resolve({
        block: true,
        timedOut: true,
        hits: [hit],
        message: `why-diff guard: ${hit.slice(2)}\n\nTell the user that why-diff could not check the changes you made in this session in time, and what you changed, so they can check it.\n`,
      });
    }, ms);
  });
  const work = checkSession(payload, opts);
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkSession(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult> {
  const state = { relevant: false };
  try {
    return await guard(payload, opts, state);
  } catch (err) {
    // Fail closed: git could be made to hide the agent's changes (a filter driver that cannot be
    // switched off, an index that cannot be read), or anything else went wrong while checking a
    // session that touched this repository. Say so instead of letting the agent finish.
    if (err instanceof FailClosedError || state.relevant) {
      let reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
      if (reason.length > MAX_REASON) reason = `${reason.slice(0, MAX_REASON)}...`;
      const hit = `- why-diff could not check this session: ${reason}`;
      return {
        block: true,
        hits: [hit],
        message: `why-diff guard: ${hit.slice(2)}\n\nTell the user that why-diff could not check the changes you made in this session (the reason is above), and what you changed, so they can check it.\n`,
      };
    }
    return NO_BLOCK; // not a session that touched this repository: never break it because of why-diff
  }
}

const MAX_REASON = 400;

async function guard(payload: GuardPayload, opts: GuardOptions, state: { relevant: boolean }): Promise<GuardResult> {
  if (payload.stop_hook_active) return NO_BLOCK; // already blocked once this turn: let the agent explain and stop
  if (!payload.transcript_path) return NO_BLOCK;

  // Not a repository only when no `.git` (directory or file) exists at or above the cwd: asked of the
  // file system, since the agent can break what git needs to find the repository (`.git/HEAD`, the
  // config, a `.git` file pointing nowhere).
  const cwd = payload.cwd ?? process.cwd();
  const gitEntry = await findGitEntry(cwd);
  if (!gitEntry) return NO_BLOCK;
  // From here on an error blocks: an unreadable transcript could hide what the session did.
  state.relevant = true;
  // Read before any git command runs (none of why-diff's own may move them, but stat first anyway):
  // when the index and refs last changed, and the session's base record.
  const statTime = opts.statTime ?? changeTime;
  const metaTimes = await gitMetaTimes(gitEntry, statTime);
  const sessionId = payload.session_id;
  const record = sessionId ? await readBaseRecord(sessionId, statTime) : undefined;
  const session = await claudeCodeAdapter.parse(payload.transcript_path);
  // A session with no edits and no tool calls cannot have touched the repository.
  state.relevant = session.edits.some((e) => !e.failed) || (session.toolWindows?.length ?? 0) > 0;
  if (!state.relevant) return NO_BLOCK;
  const root = await repoRoot(cwd);
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

  const windows = windowCheck(session);
  // The base record from SessionStart: trusted only if its file last changed before the session's
  // first tool call (the agent cannot write it earlier, and rewriting it moves its ctime).
  let recordedHead: string | undefined;
  if (record) {
    if (windows && record.ctime >= windows.firstStart) throw new FailClosedError(`base record modified during session (${record.file})`);
    if (!record.data) throw new FailClosedError(`the session's base record cannot be read (${record.file})`);
    if (record.data.root === root && record.data.head) recordedHead = record.data.head;
  }

  let baseRev = 'HEAD';
  const headed = await hasHead(root);
  if (headed) baseRev = await sessionBase(root, Date.parse(session.startedAt), opts.objectTime ?? changeTime, recordedHead);

  // The policy comes from the session-start commit, so the agent cannot loosen it mid-session.
  // An invalid config must not break the session: fall back to defaults.
  const config: WhyDiffConfig = await loadConfig(root, baseRev).catch(() => ({}));
  const blocking = opts.blocking ?? new Set<LabelKind>([...DEFAULT_BLOCK_ON, ...(config.blockOn ?? [])]);
  const protectedGlob = compileGlobs(config.protected);
  const sparseTrust: SparseTrust = { before: Date.parse(session.startedAt) - WINDOW_SLACK_MS, timeOf: opts.objectTime ?? changeTime };

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

  /** Diff `pathspecs` from the base and list the risky hunks this session is credited with. */
  const check = async (pathspecs: string[], credit: Credit): Promise<string[]> => {
    const report = await buildReport({
      cwd: root,
      workingTree: true,
      baseRev,
      paths: pathspecs,
      sessionFiles: [payload.transcript_path!],
      harnesses: ['claude-code'],
      home: opts.home,
      config,
      keepAgentIgnored: true,
      sparseTrust,
      // Every path through a temporary index without stat data or flags: git hashes the content.
      contentIndex: true,
      // A change kept only in a commit or only staged (the working tree put back) shows too.
      committedLayers: headed,
    });
    const hits: string[] = [];
    for (const h of report.hunks) {
      // Fail closed: the text of a file the session touched (the diff covers only files it edited,
      // named in a command, or changed during one of its calls) could not be produced (binary by git
      // attributes and too big to re-diff, an untracked file over 2 MB or unreadable), so what changed
      // in it is unknown. Blocks whatever the path.
      if (h.labels.some((l) => l.kind === 'unreviewed')) {
        const detail = `could not be diffed as text (git attributes mark it binary, or it is too big or unreadable): ${h.hunk.file}`;
        hits.push(`- ${h.hunk.file} unreviewed: ${detail}`);
        continue;
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
            ? shellOnly(h.hunk) ? credit.removed.has(source) : credit.removed.has(source) && credit.written.has(h.hunk.file)
            : h.hunk.status === 'deleted' ? shellOnly(h.hunk) && credit.removed.has(h.hunk.file) : credit.written.has(h.hunk.file);
          // Gone from the index or HEAD but still on disk (untracked by a command that did not name it),
          // or changed in a commit or the index: dated by the index and ref files.
          if (!timed && h.hunk.status === 'deleted' && credit.detached.has(h.hunk.file)) timed = true;
          if (!timed && h.hunk.layer && (credit.layered.has(h.hunk.file) || credit.layered.has(source))) timed = true;
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
        const hit = `- ${h.hunk.file}:${h.hunk.newStart} ${l.kind}: ${l.detail}`;
        if (!hits.includes(hit)) hits.push(hit);
      }
    }
    return hits;
  };

  // First the paths the session named (its edits and shell commands): cheap, and a finding there
  // blocks without walking the whole working tree.
  if (paths.length) {
    const first = await check(paths, NO_CREDIT);
    if (first.length) return blocked(payload.transcript_path, first);
  }

  // Files a shell command changed without naming them (a script computing the path, `rsync --delete`,
  // a path from the environment, a background process): credited when the file (or, once deleted,
  // the nearest path above it) last changed (ctime) while one of this session's tool calls ran.
  // A skip-worktree file missing from the working tree is excused only when the sparse checkout,
  // as the repository's own config and patterns from before the session define it, leaves it out.
  const excluded = await sparseExcluded(root, sparseTrust);
  const inWindow = windows?.inWindow ?? null;
  const byWindow = await toolWindowFiles(root, headed ? baseRev : undefined, inWindow, statTime, excluded);
  const hits: string[] = [];
  // Untracked files credited by time alone are capped: past the cap they are not read, only reported.
  const timedNew = [...byWindow.written].filter((f) => byWindow.untracked.has(f)).sort();
  if (timedNew.length > MAX_TIMED_UNTRACKED) {
    const over = timedNew.slice(MAX_TIMED_UNTRACKED);
    for (const f of over) byWindow.written.delete(f);
    hits.push(`- ${over[0]} unreviewed: ${over.length} more untracked files written during this session's tool calls were not reviewed (over the cap of ${MAX_TIMED_UNTRACKED}), e.g. ${over.slice(0, 3).join(', ')}`);
  }
  const credit = { written: byWindow.written, removed: byWindow.removed, detached: new Set<string>(), layered: new Set<string>() };
  const all = [...paths];
  for (const f of [...byWindow.written, ...byWindow.removed]) all.push(`:(literal)${f}`);

  // Changes git keeps outside the working tree: files that differ between the base and HEAD or the
  // index, credited when the index, the branch ref, HEAD's reflog or packed-refs changed during a
  // call, or after the last one (a later `git status` from an IDE rewrites the index, and that cannot
  // be told apart from the agent's detached work). Among them, a file gone from the index or HEAD
  // but still on disk was untracked, and counts as deleted, even when the command that did it never
  // named it.
  if (headed && windows) {
    if (metaTimes.some((t) => windows.inWindow(t) || t > windows.lastEnd)) {
      for (const [args, deletedOnly] of [[[baseRev, 'HEAD'], false], [['--cached', baseRev], false], [['--diff-filter=D', baseRev, 'HEAD'], true], [['--diff-filter=D', '--cached', baseRev], true]] as const) {
        const out = await git(root, ['diff', '--name-only', '--no-renames', '-z', ...args, '--'], { trim: false });
        for (const f of out.split('\0')) {
          if (!f || f.startsWith('.why-diff/')) continue;
          if (!deletedOnly) {
            if (!credit.layered.has(f)) all.push(`:(literal)${f}`);
            credit.layered.add(f);
          } else if (await lstat(path.join(root, ...f.split('/'))).then(() => true, () => false)) {
            credit.detached.add(f);
          }
        }
      }
    }
  }
  if (!all.length) return hits.length ? blocked(payload.transcript_path, hits) : NO_BLOCK;
  for (const hit of await check(all, credit)) if (!hits.includes(hit)) hits.push(hit);
  return hits.length ? blocked(payload.transcript_path, hits) : NO_BLOCK;
}

interface Credit {
  /** Files whose own change time lies in a tool call window */
  written: ReadonlySet<string>;
  /** Deleted files whose nearest existing ancestor's change time does */
  removed: ReadonlySet<string>;
  /** In the base, gone from the index or HEAD, still on disk; index or ref changed in a window */
  detached: ReadonlySet<string>;
  /** Differ between the base and HEAD or the index; index or ref changed in a window */
  layered: ReadonlySet<string>;
}
const NO_CREDIT: Credit = { written: new Set(), removed: new Set(), detached: new Set(), layered: new Set() };
/** Untracked files credited by change time alone that are read and diffed; the rest block as unreviewed. */
const MAX_TIMED_UNTRACKED = 2000;

async function blocked(transcript: string | undefined, hits: string[]): Promise<GuardResult> {
  // Every Stop with risky hits blocks; only `stop_hook_active` (set by Claude Code, after a block in
  // this same turn) lets the agent finish. Nothing on disk can switch a block off: the agent can write
  // the repo, its home and its own transcript. The transcript only picks a shorter message when the
  // same list was already shown.
  if (transcript && (await shownBefore(transcript, hits).catch(() => false))) {
    return {
      block: true,
      hits,
      message: `why-diff guard: still present from an earlier block:\n${hits.join('\n')}\nTell the user about these changes, or revert them.\n`,
    };
  }
  return {
    block: true,
    hits,
    message:
      `${MESSAGE_HEAD}${hits.join('\n')}\n\n` +
      'Before finishing: if you skipped, weakened or removed tests (or changed CI/secrets), either revert that change ' +
      'or tell the user explicitly what you changed and why, so they can decide. Do not hide it.\n',
  };
}

/** The nearest `.git` entry (directory, file or link) in `dir` or any directory above it, or null. */
async function findGitEntry(dir: string): Promise<string | null> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const entry = path.join(d, '.git');
    try {
      await lstat(entry);
      return entry;
    } catch (err) {
      if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) return entry; // unreadable: assume a repository
    }
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Change times of the files git rewrites when the index or a ref moves: the index, HEAD's reflog,
 * the ref HEAD points at (its loose file, or `packed-refs` when it has none) and `packed-refs`
 * when present; the HEAD file itself when detached. Read from the file system alone, so no git
 * process can touch them first. A missing index is dated by the directory that held it. Nothing
 * that cannot be read fails: the times only add credit.
 */
async function gitMetaTimes(gitEntry: string, timeOf: (p: string) => Promise<number>): Promise<number[]> {
  let gitDir = gitEntry;
  try {
    const st = await lstat(gitEntry);
    if (!st.isDirectory()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitEntry, 'utf8'));
      if (!m) return [];
      gitDir = path.resolve(path.dirname(gitEntry), m[1]!);
    }
  } catch {
    return [];
  }
  const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').then((c) => path.resolve(gitDir, c.trim()), () => gitDir);
  const time = (p: string): Promise<number | undefined> => timeOf(p).then((t) => t, () => undefined);
  const files: Array<Promise<number | undefined>> = [
    time(path.join(gitDir, 'index')).then((t) => t ?? time(gitDir)),
    time(path.join(gitDir, 'logs', 'HEAD')),
    time(path.join(common, 'packed-refs')),
  ];
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '');
  const ref = /^ref:\s*(refs\/\S+)\s*$/.exec(head)?.[1];
  if (ref && !ref.split('/').includes('..')) files.push(time(path.join(common, ...ref.split('/'))));
  else files.push(time(path.join(gitDir, 'HEAD')));
  return (await Promise.all(files)).filter((t): t is number => t !== undefined);
}

/** The session's base record (see `why-diff session-start`) with its file's change time, if there is one. */
async function readBaseRecord(sessionId: string, timeOf: (p: string) => Promise<number>): Promise<{ file: string; ctime: number; data?: BaseRecord } | undefined> {
  const file = recordPath(sessionId);
  let ctime: number;
  try {
    ctime = await timeOf(file);
  } catch (err) {
    if (GONE.has((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw new FailClosedError(`the session's base record cannot be read (${file})`);
  }
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as BaseRecord;
    const ok = data && data.session_id === sessionId && typeof data.root === 'string' && (data.head === null || (typeof data.head === 'string' && /^[0-9a-f]{40,64}$/.test(data.head)));
    return ok ? { file, ctime, data } : { file, ctime };
  } catch {
    return { file, ctime };
  }
}

const SHELL_GLOB = /[*?[]/;
/** Clock slack on each side of a tool call window (transcript stamps vs file system times). */
const WINDOW_SLACK_MS = 2000;
const LSTAT_BATCH = 256;
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
 * Changed files (against `rev`, working tree and untracked) and every tracked file, whose change
 * time lies inside one of the session's tool call windows (`written`), and deleted ones whose
 * nearest existing ancestor's time does (`removed`). Every tracked file is checked, not only those
 * `git diff` lists: an index entry (flagged, or forged with the new file's stat data) can hide a
 * change from git, not from the file's ctime. A human edit after the call moves the time out of
 * every window, so it is never credited; a human edit while an agent tool call is running is (the
 * one edge; long calls, subagents and background processes widen it).
 */
async function toolWindowFiles(root: string, rev: string | undefined, inWindow: ((ms: number) => boolean) | null, timeOf: (p: string) => Promise<number>, excluded: ((file: string) => boolean) | null): Promise<{ written: Set<string>; removed: Set<string>; untracked: Set<string> }> {
  const written = new Set<string>();
  const removed = new Set<string>();
  const untracked = new Set<string>();
  if (!inWindow) return { written, removed, untracked };

  const changed = await git(root, ['diff', '--name-only', '--no-renames', '-z', rev ?? (await emptyTree(root)), '--'], { trim: false });
  const entries = await indexEntries(root);
  // Skip-worktree files the sparse checkout leaves out are expected to be missing.
  const sparse = await sparseMissing(root, entries, excluded);
  for (const f of await listUntracked(root)) untracked.add(f);
  const files = [...new Set([...changed.split('\0').filter(Boolean), ...entries.map((e) => e.path), ...untracked])]
    .filter((f) => !f.startsWith('.why-diff/') && !sparse.has(f));
  // `git rev-parse --show-toplevel` prints `C:/x` on Windows: resolve it so the walk below compares like with like.
  const top = path.resolve(root);
  const gone = (err: unknown): boolean => {
    if (GONE.has((err as NodeJS.ErrnoException).code ?? '')) return true;
    throw err;
  };
  // Deleted: date it by the nearest path above it that still exists (up to the repo root). A parent
  // replaced by a file (ENOTDIR) or a symlink loop (ELOOP) is gone as a directory too. One lookup per directory.
  const dirTimes = new Map<string, Promise<number | undefined>>();
  const dirTime = (dir: string): Promise<number | undefined> => {
    let t = dirTimes.get(dir);
    if (!t) {
      t = timeOf(dir).catch((err) => {
        gone(err);
        if (dir === top || path.dirname(dir) === dir || !dir.startsWith(top)) return undefined;
        return dirTime(path.dirname(dir));
      });
      dirTimes.set(dir, t);
    }
    return t;
  };
  for (let i = 0; i < files.length; i += LSTAT_BATCH) {
    await Promise.all(files.slice(i, i + LSTAT_BATCH).map(async (f) => {
      const abs = path.join(top, ...f.split('/'));
      let t: number | undefined;
      try {
        t = await timeOf(abs);
      } catch (err) {
        gone(err);
      }
      if (t !== undefined) {
        if (inWindow(t)) written.add(f);
        return;
      }
      const d = await dirTime(path.dirname(abs));
      if (d !== undefined && inWindow(d)) removed.add(f);
    }));
  }
  return { written, removed, untracked };
}

/**
 * "Did this change time fall inside one of the session's tool call windows?", or null when the
 * session has none. An open window (background or detached process, no result yet) lasts until this
 * guard runs; long calls are kept (dropping them would let `sleep 700; node fix.js` slip through).
 */
function windowCheck(session: Session): { inWindow: (ms: number) => boolean; firstStart: number; lastEnd: number } | null {
  const now = Date.now();
  const raw = (session.toolWindows ?? [])
    .map((w) => ({ start: Date.parse(w.start), end: w.open ? Math.max(now, Date.parse(w.end)) : Date.parse(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  if (!raw.length) return null;
  const windows = raw.map((w) => ({ start: w.start - WINDOW_SLACK_MS, end: w.end + WINDOW_SLACK_MS }));
  return {
    inWindow: (ms) => windows.some((w) => ms >= w.start && ms <= w.end),
    /** When the first tool call started (no slack) */
    firstStart: Math.min(...raw.map((w) => w.start)),
    /** When the last window closes, slack included */
    lastEnd: Math.max(...windows.map((w) => w.end)),
  };
}

/**
 * The commit HEAD pointed at when the session started: the diff base, so edits the agent committed
 * during the session still count. Claude Code transcripts record the branch, not a commit, and
 * committer dates are the agent's to set (`GIT_COMMITTER_DATE` also stamps the reflog, and the
 * reflog file is the agent's to rewrite), so dates only pick candidates and object write times
 * decide:
 *
 * 1. candidates: every commit in HEAD's reflog stamped before the session start, and the first
 *    commit of HEAD's first-parent history; each counts only when its object was written before
 *    the session;
 * 2. the base is the candidate whose object was written last (an agent cannot write an object that
 *    predates the session, so it cannot make an older commit look newer than the real base); among
 *    candidates written at the same time (one pack), the one that descends from the others;
 * 3. no candidate: fail closed ({@link FailClosedError}).
 *
 * A commit counts as written before the session only when it is a loose object of this repository's
 * own store whose file changed before the session started (written then), or sits in one of its
 * packs whose pack and index files both did (written when the later of the two changed; an index
 * changed during the session fails closed). Objects reachable only through alternates are never
 * trusted. A `.git/shallow` changed during the session fails closed. The base is used as is, even
 * when it is no longer an ancestor of HEAD (a reset dropped it): only the session's paths are
 * diffed, so a merge base would let a reset hide the commits it dropped.
 */
async function sessionBase(root: string, startedAt: number, timeOf: (p: string) => Promise<number>, recorded?: string): Promise<string> {
  if (!Number.isFinite(startedAt)) throw new FailClosedError('the transcript has no session start time');
  const cutoff = startedAt - WINDOW_SLACK_MS;
  const parse = (out: string): Array<{ sha: string; at: number }> => out.split('\n').map((l) => {
    const m = /^([0-9a-f]{40,64})\t(?:[^\t]*@\{)?(\d+)\}?$/.exec(l.trim());
    return m ? { sha: m[1]!, at: Number(m[2]) * 1000 } : null;
  }).filter((e): e is { sha: string; at: number } => e !== null);

  // A shallow boundary moved during the session can cut history short: no base can be trusted.
  const shallow = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'shallow']));
  const shallowTime = await timeOf(shallow).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? undefined : Infinity));
  if (shallowTime !== undefined && shallowTime >= cutoff) throw new FailClosedError('the shallow history boundary (.git/shallow) changed during the session');

  // Only this repository's own object store counts: a commit found only through alternates is untrusted.
  const main = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'objects']));
  let oldPacks: Array<{ idx: Buffer; at: number }> | undefined;
  /** When the commit's object was written, if before the session; undefined otherwise. */
  const writtenAt = async (sha: string): Promise<number | undefined> => {
    const loose = await timeOf(path.join(main, sha.slice(0, 2), sha.slice(2))).catch(() => undefined);
    if (loose !== undefined) return loose < cutoff ? loose : undefined;
    if (!oldPacks) {
      oldPacks = [];
      const dir = path.join(main, 'pack');
      const files = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [] as string[];
        throw err;
      });
      // A pack index rewritten during the session could list anything: no pack can be trusted then.
      for (const f of files.filter((x) => x.endsWith('.idx'))) {
        if ((await timeOf(path.join(dir, f)).catch(() => Infinity)) >= cutoff) throw new FailClosedError('a pack index (.git/objects/pack/*.idx) changed during the session');
      }
      // Trusted: a pack and its index both from before the session (a missing index is not).
      for (const f of files.filter((x) => x.endsWith('.pack'))) {
        const idx = path.join(dir, `${f.slice(0, -5)}.idx`);
        const times = await Promise.all([timeOf(path.join(dir, f)), timeOf(idx)].map((t) => t.catch(() => Infinity)));
        const buf = times.every((t) => t < cutoff) ? await readFile(idx).catch(() => undefined) : undefined;
        if (buf) oldPacks.push({ idx: buf, at: Math.max(...times) });
      }
    }
    let at: number | undefined;
    for (const p of oldPacks) if (packIndexHas(p.idx, sha) && (at === undefined || p.at > at)) at = p.at;
    return at;
  };

  const isCommit = async (sha: string): Promise<boolean> => git(root, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
  if (recorded) {
    // The commit recorded at SessionStart, out of the agent's reach: still only if its object predates the session.
    if ((await isCommit(recorded)) && (await writtenAt(recorded)) !== undefined) return recorded;
    throw new FailClosedError(`the commit recorded at session start (${recorded.slice(0, 12)}) is missing or was not written before the session`);
  }

  // Candidates, in order of preference for a tie: the reflogs of HEAD and of the current branch
  // (newest first), then HEAD's history. Every qualifying reflog commit is considered: past the cap
  // the check fails closed rather than drop any (a flooded reflog could push the real base out).
  const order: string[] = [];
  const cap = Number(process.env.WHY_DIFF_MAX_BASE_CANDIDATES) > 0 ? Number(process.env.WHY_DIFF_MAX_BASE_CANDIDATES) : MAX_BASE_CANDIDATES;
  const branch = await git(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  for (const ref of ['HEAD', ...(branch ? [branch] : [])]) {
    for (const e of parse(await git(root, ['reflog', 'show', '--format=%H%x09%gd', '--date=unix', ref, '--']).catch(() => ''))) {
      if (e.at > startedAt || order.includes(e.sha)) continue;
      if (order.length >= cap) throw new FailClosedError(`HEAD's reflog has more than ${cap} commits from before the session; the session base cannot be chosen among them`);
      order.push(e.sha);
    }
  }
  // HEAD's first-parent history: the first commit written before the session, outside the cap.
  for (const e of parse(await git(root, ['log', '--first-parent', '-n', '5000', '--format=%H%x09%ct', 'HEAD', '--']).catch(() => ''))) {
    if ((await writtenAt(e.sha)) !== undefined) {
      if (!order.includes(e.sha)) order.push(e.sha);
      break;
    }
  }
  // Commits only (a reflog line can name anything), in one git call.
  const types = order.length
    ? await git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${order.join('\n')}\n` }).catch(() => '')
    : '';
  const commits = new Set(types.split('\n').map((l) => l.split(' ')).filter(([, t]) => t === 'commit').map(([sha]) => sha!));
  const dated: Array<{ sha: string; at: number }> = [];
  for (const sha of order) {
    if (!commits.has(sha)) continue;
    const at = await writtenAt(sha);
    if (at !== undefined) dated.push({ sha, at });
  }
  if (!dated.length) throw new FailClosedError('no commit from before the session start was found to compare against (every candidate was written during the session)');
  const latest = Math.max(...dated.map((d) => d.at));
  const tied = dated.filter((d) => d.at === latest).map((d) => d.sha);
  if (tied.length === 1) return tied[0]!;
  // Written together (one pack): the one the others lead to; if they diverge, the first preferred tip.
  const tips = new Set((await git(root, ['merge-base', '--independent', ...tied]).catch(() => '')).split('\n').filter(Boolean));
  return tied.find((sha) => tips.has(sha)) ?? tied[0]!;
}

/** Distinct pre-session reflog commits considered for the session base; more fails closed. */
const MAX_BASE_CANDIDATES = 10_000;

/** Is `sha` listed in this pack index (version 2: magic, version, 256-entry fan-out, sorted names)? */
function packIndexHas(buf: Buffer, sha: string): boolean {
  if (buf.length < 8 + 1024 || buf.readUInt32BE(0) !== 0xff744f63 || buf.readUInt32BE(4) !== 2) return false;
  const want = Buffer.from(sha, 'hex');
  const len = want.length;
  const first = want[0]!;
  let lo = first === 0 ? 0 : buf.readUInt32BE(8 + (first - 1) * 4);
  let hi = buf.readUInt32BE(8 + first * 4);
  const names = 8 + 1024;
  if (names + hi * len > buf.length) return false;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = buf.compare(want, 0, len, names + mid * len, names + (mid + 1) * len);
    if (c === 0) return true;
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

const REMOVE_OPS: ReadonlySet<string> = new Set(['delete', 'move']);
const REWRITE_OPS: ReadonlySet<string> = new Set(['edit', 'write', 'append', 'copy']);

/** The hunk is exactly a shell rename (no changed lines) or a shell deletion of the whole file. */
function shellOnly(hunk: Hunk): boolean {
  if (hunk.status === 'renamed') return !hunk.lines.some((l) => l.type === 'add' || l.type === 'del');
  if (hunk.status === 'deleted') return hunk.newLines === 0 && hunk.oldStart <= 1 && hunk.lines.every((l) => l.type === 'del');
  return false;
}

const MESSAGE_HEAD = 'why-diff guard: your changes in this session include risky edits:\n';

/**
 * Was a block with exactly these hits already shown in this session (a Stop hook block that Claude
 * Code recorded in the transcript)? Only chooses the short message; never skips a block.
 */
async function shownBefore(transcript: string, hits: string[]): Promise<boolean> {
  const needle = `${MESSAGE_HEAD}${hits.join('\n')}\n\n`;
  const stream = createReadStream(transcript, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw.includes('why-diff guard') || !(raw.includes('hook_blocking_error') || raw.includes('stop_hook_summary'))) continue;
      let line: { type?: unknown; subtype?: unknown; attachment?: { type?: unknown } } & Record<string, unknown>;
      try {
        line = JSON.parse(raw) as typeof line;
      } catch {
        continue;
      }
      const harnessLine = (line.type === 'attachment' && line.attachment?.type === 'hook_blocking_error') || (line.type === 'system' && line.subtype === 'stop_hook_summary');
      if (harnessLine && strings(line.type === 'attachment' ? line.attachment : line).some((t) => t.includes(needle))) return true;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return false;
}

function strings(v: unknown, depth = 0): string[] {
  if (typeof v === 'string') return [v];
  if (depth > 4 || !v || typeof v !== 'object') return [];
  return Object.values(v as Record<string, unknown>).flatMap((x) => strings(x, depth + 1));
}
