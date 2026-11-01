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
import { constants as fsConstants, createReadStream, realpath as realpathCb } from 'node:fs';
import { access, lstat, readdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { emptyTree, FailClosedError, git, GitError, hasHead, indexEntries, isCaseInsensitive, listUntracked, repoRoot, sparseExcluded, sparseMissing, worktreeRoots, type SparseTrust } from './git.js';
import { globToRegExp, repoRelativePath, rootVariants } from './attribute.js';
import { compileGlobs, loadConfig, type WhyDiffConfig } from './config.js';
import type { Hunk, LabelKind, Session } from './types.js';
import { isConfigFile, isTestFile } from './labels.js';
import { dataDir, failedMarker, recordMarker, recordPath, type BaseRecord } from './session-start.js';

const realpathNative = realpathCb.native;

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
  /** lstat of a path: its device and whether it is a symlink (tests); default: lstat */
  pathStat?: (absPath: string) => Promise<PathStat>;
  /** Type of the file system holding a path (`apfs`, `ext4`, `msdos`...) (tests); default: statfs / mount */
  fsType?: (absPath: string) => Promise<string>;
}

export interface GuardResult {
  block: boolean;
  message?: string;
  hits: string[];
  /** The check ran past its internal deadline (and blocks): the caller should exit now */
  timedOut?: boolean;
  /** Debug notes (shown with `WHY_DIFF_DEBUG=1`): how the base was chosen */
  notes?: string[];
}

const NO_BLOCK: GuardResult = { block: false, hits: [] };

/** Internal time limit of one guard run, below Claude Code's 30 s hook timeout (`WHY_DIFF_GUARD_DEADLINE_MS` overrides it, for tests). */
const DEADLINE_MS = 20_000;

/** The guard's time limit in ms: `WHY_DIFF_GUARD_DEADLINE_MS` when set (tests), else {@link DEADLINE_MS}. */
export function guardDeadlineMs(): number {
  const env = Number(process.env.WHY_DIFF_GUARD_DEADLINE_MS);
  return Number.isFinite(env) && env > 0 ? env : DEADLINE_MS;
}

/** The blocking result for a check that ran past its time limit. */
export function timeoutResult(ms: number): GuardResult {
  const hit = `- why-diff could not check this session: it did not finish within ${ms / 1000} s (the Stop hook's time limit is 30 s), so its changes were not reviewed`;
  return {
    block: true,
    timedOut: true,
    hits: [hit],
    message: `why-diff guard: ${hit.slice(2)}\n\nTell the user that why-diff could not check the changes you made in this session in time, and what you changed, so they can check it.\n`,
  };
}

/**
 * Decide whether to block the Stop. In process, the time limit ({@link guardDeadlineMs}) is a soft
 * one: it fires only when the check yields to the event loop, and the check keeps running after it.
 * The hard deadline belongs to the CLI (`why-diff guard`), which runs this check in a child process
 * and kills it at the limit: a hook killed by Claude Code's own 30 s timeout would let the agent
 * finish unchecked, and the agent can make the check slow.
 */
export async function runGuard(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult> {
  const ms = guardDeadlineMs();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<GuardResult>((resolve) => {
    timer = setTimeout(() => resolve(timeoutResult(ms)), ms);
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
  const notes: string[] = [];
  const result = await checkSessionInner(payload, opts, notes);
  return notes.length ? { ...result, notes } : result;
}

async function checkSessionInner(payload: GuardPayload, opts: GuardOptions, notes: string[]): Promise<GuardResult> {
  const state = { relevant: false };
  try {
    return await guard(payload, opts, state, notes);
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

async function guard(payload: GuardPayload, opts: GuardOptions, state: { relevant: boolean }, notes: string[]): Promise<GuardResult> {
  if (payload.stop_hook_active) return NO_BLOCK; // already blocked once this turn: let the agent explain and stop
  if (!payload.transcript_path) return NO_BLOCK;

  // Not a repository only when no `.git` (directory or file) exists at or above the cwd: asked of the
  // file system, since the agent can break what git needs to find the repository (`.git/HEAD`, the
  // config, a `.git` file pointing nowhere).
  const cwd = payload.cwd ?? process.cwd();
  const gitEntry = await findGitEntry(cwd);
  if (!gitEntry) {
    // No `.git` now, but the session may have started in a repository: the agent can move `.git`
    // (or the repository) away. The SessionStart record and the transcript marker say so.
    await startedInRepository(payload, cwd, opts.statTime ?? changeTime, opts.pathStat ?? lstatOf);
    return NO_BLOCK;
  }
  // From here on an error blocks: an unreadable transcript could hide what the session did.
  state.relevant = true;
  // Read before any git command runs (none of why-diff's own may move them, but stat first anyway):
  // when the index and refs last changed, and the session's base record.
  const statTime = opts.statTime ?? changeTime;
  const pathStat = opts.pathStat ?? lstatOf;
  const metaTimes = await gitMetaTimes(gitEntry, statTime, pathStat);
  const sessionId = payload.session_id;
  const record = sessionId ? await readBaseRecord(sessionId, statTime, pathStat) : undefined;
  const session = await claudeCodeAdapter.parse(payload.transcript_path);
  // A session with no edits and no tool calls cannot have touched the repository.
  state.relevant = session.edits.some((e) => !e.failed) || (session.toolWindows?.length ?? 0) > 0;
  if (!state.relevant) return NO_BLOCK;
  const root = await repoRoot(cwd);
  const real = (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));
  // Object write times count only from the file system of the git common dir that holds them (see onDevice).
  const commonDir = await gitCommonDir(root);
  const objectTime = onDevice(opts.objectTime ?? changeTime, pathStat, await deviceOf(commonDir, pathStat));
  // The work tree git reports must be the one the `.git` entry sits in: `core.worktree` (or a gitfile
  // in another directory pointing back) would make git diff a clean copy instead of the files the
  // agent changed.
  if ((await real(root)) !== (await real(path.dirname(gitEntry)))) {
    throw new FailClosedError(`git reports the work tree at ${root}, not at ${path.dirname(gitEntry)} where the .git entry is (core.worktree or a .git file points elsewhere)`);
  }
  const windows = windowCheck(session);
  // The base record from SessionStart: trusted only if its file last changed before the session's
  // first tool call (the agent cannot write it earlier, and rewriting it moves its ctime). A record
  // the transcript says was written (the hook's marker) must still be there.
  let recordedHead: string | undefined;
  let indexBase: string | undefined;
  let recordedSubmodules: Record<string, RecordedSubmodule> | undefined;
  const fsType = opts.fsType ?? fileSystemType;
  const markers = sessionId ? await transcriptMarkers(payload.transcript_path, sessionId).catch(() => ({ ok: true, failed: true })) : { ok: false, failed: false };
  if (markers.failed) throw new FailClosedError(`base record could not be written at session start (the SessionStart hook said so); the session's base cannot be trusted`);
  if (record) {
    if (!windows) throw new FailClosedError(`the session's base record cannot be dated: no tool call of this session has a readable time (${record.file})`);
    if (record.ctime >= windows.firstStart) throw new FailClosedError(`base record modified during session (${record.file})`);
    if (!record.data) throw new FailClosedError(`base record missing or unreadable (${record.file})`);
    const recordRoot = await real(record.data.root);
    if (recordRoot !== (await real(root))) {
      const here = await real(cwd);
      if (here === recordRoot || here.startsWith(recordRoot.endsWith(path.sep) ? recordRoot : `${recordRoot}${path.sep}`)) {
        throw new FailClosedError(`the base record is for ${record.data.root}, and this session's directory is inside it, but git now finds the repository ${root}`);
      }
      notes.push(`base record is for another repository (${record.data.root}); this session now works in ${root}, so the base comes from the reflogs`);
    } else {
      // A file system mounted over the repository (or its git dir, or the record directory) after
      // the session started reports any change time it likes: the devices must be the recorded ones.
      const devs = record.data;
      if (typeof devs.rootDev === 'number' && typeof devs.gitDev === 'number') {
        for (const [what, p, was] of [['repository root', await real(root), devs.rootDev], ['git dir', commonDir, devs.gitDev]] as const) {
          const now = await deviceOf(p, pathStat);
          if (now !== was) throw new FailClosedError(`the ${what} (${p}) is on another file system than at session start (device ${was} then, ${now ?? 'unreadable'} now): a file system mounted over it can report any change time`);
        }
      }
      if (typeof devs.dataDirDev === 'number') {
        const now = await deviceOf(path.dirname(record.file), pathStat);
        if (now !== devs.dataDirDev) throw new FailClosedError(`the base record directory (${path.dirname(record.file)}) is on another file system than at session start (device ${devs.dataDirDev} then, ${now ?? 'unreadable'} now)`);
      }
      if (devs.submodules && typeof devs.submodules === 'object') {
        recordedSubmodules = {};
        for (const [k, v] of Object.entries(devs.submodules as Record<string, unknown>)) {
          const e = (typeof v === 'string' ? { head: v } : v) as Partial<RecordedSubmodule> | null;
          if (!e || typeof e.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(e.head)) continue;
          recordedSubmodules[k] = { head: e.head, ...(typeof e.rootDev === 'number' ? { rootDev: e.rootDev } : {}), ...(typeof e.gitDev === 'number' ? { gitDev: e.gitDev } : {}) };
        }
      }
      if (record.data.head) {
        recordedHead = record.data.head;
        notes.push(`base from the SessionStart record: ${record.data.head}`);
      } else {
        notes.push('base record names no commit (unborn branch at session start); the base comes from the reflogs');
      }
      // The index at session start: staged changes from before the session are not the agent's.
      const tree = record.data.indexTree;
      if (tree && (await git(root, ['cat-file', '-e', `${tree}^{tree}`]).then(() => true, () => false)) && (await writtenBefore(root, tree, windows.firstStart, objectTime))) {
        indexBase = tree;
        notes.push(`index compared against the index tree recorded at session start: ${tree}`);
      }
    }
  } else if (markers.ok) {
    throw new FailClosedError(`base record missing: the SessionStart hook recorded one for this session, and it is gone (${recordPath(sessionId!)})`);
  } else {
    // No record and no marker: the plugin may have been installed mid-session, or the hook's output
    // lost. A record directory that exists but cannot be written was made so on purpose (no record
    // can ever be kept there): fail closed rather than fall back to the reflogs.
    const dir = path.dirname(sessionId ? recordPath(sessionId) : recordPath('-'));
    const unwritable = await access(dir, fsConstants.W_OK).then(() => false, (err: NodeJS.ErrnoException) => !GONE.has(err.code ?? ''));
    if (unwritable) throw new FailClosedError(`the base record directory cannot be written (${dir}), so the session's base cannot be trusted`);
    notes.push('no SessionStart base record; the base comes from the reflogs');
  }

  // A record (once trusted by its time) only proves anything if its own file system cannot forge times.
  if (record) await trustedFileSystem(record.file, 'the base record', fsType);
  // The repository's file systems must be ones whose change times cannot be forged without root,
  // whether or not the devices match the recorded ones (a remount can reuse the same device).
  await trustedFileSystem(root, 'the repository', fsType);
  await trustedFileSystem(commonDir, 'the git dir', fsType);

  let baseRev = 'HEAD';
  const headed = await hasHead(root);
  if (headed) baseRev = await sessionBase(root, Date.parse(session.startedAt), objectTime, recordedHead);

  // The policy comes from the session-start commit, so the agent cannot loosen it mid-session.
  // An invalid config must not break the session: fall back to defaults.
  const config: WhyDiffConfig = await loadConfig(root, baseRev).catch(() => ({}));
  const blocking = opts.blocking ?? new Set<LabelKind>([...DEFAULT_BLOCK_ON, ...(config.blockOn ?? [])]);
  const protectedGlob = compileGlobs(config.protected);
  const ctx: SessionCheck = { payload, opts, session, windows, statTime, pathStat, rawObjectTime: opts.objectTime ?? changeTime, config, blocking, protectedGlob, recordedSubmodules, fsType, gitDev: await deviceOf(commonDir, pathStat) };
  const hits = await checkRepository(ctx, { root, baseRev, headed, indexBase, metaTimes, prefix: '', depth: 0 });
  return hits.length ? blocked(payload.transcript_path, hits) : NO_BLOCK;
}

/** A submodule as the SessionStart record kept it: its HEAD and the devices of its root and git common dir. */
interface RecordedSubmodule {
  head: string;
  rootDev?: number;
  gitDev?: number;
}

/** What one guard run knows about the session, shared by the repository and its submodules. */
interface SessionCheck {
  payload: GuardPayload;
  opts: GuardOptions;
  session: Session;
  windows: ReturnType<typeof windowCheck>;
  statTime: (p: string) => Promise<number>;
  pathStat: (p: string) => Promise<PathStat>;
  /** Object write times as read (each repository anchors them to its own git common dir, see onDevice) */
  rawObjectTime: (p: string) => Promise<number>;
  /** Submodule heads from the SessionStart record, by path from the session's repository */
  recordedSubmodules?: Record<string, RecordedSubmodule>;
  fsType: (p: string) => Promise<string>;
  /** Device of the session repository's git common dir */
  gitDev?: number;
  config: WhyDiffConfig;
  blocking: Set<LabelKind>;
  protectedGlob: (file: string) => string | undefined;
}

/** One repository to check: the session's, or a submodule of it (`prefix` is its path, with a slash). */
interface RepoUnderCheck {
  root: string;
  baseRev: string;
  headed: boolean;
  indexBase?: string;
  /** See {@link gitMetaTimes} */
  metaTimes: number[];
  prefix: string;
  depth: number;
  /** Only these files are dated in the work tree (a submodule whose index and refs did not change: what `git status` lists) */
  onlyFiles?: ReadonlySet<string>;
}

/** Submodules inside submodules are checked this many levels deep; deeper ones block as unreviewed. */
const MAX_SUBMODULE_DEPTH = 3;

/**
 * The risky hunks this session is credited with in one repository (paths in the hits carry
 * `repo.prefix`), then in each of its checked-out submodules, recursively.
 */
async function checkRepository(ctx: SessionCheck, repo: RepoUnderCheck): Promise<string[]> {
  const { payload, opts, session, windows, statTime, pathStat, config, blocking, protectedGlob } = ctx;
  const { root, baseRev, headed, indexBase, prefix } = repo;
  // Refs are dated by the files of a backend this guard knows (see gitMetaTimes): any other one could
  // move a branch without changing any of them.
  const refStorage = (await git(root, ['config', '--get', 'extensions.refStorage']).catch((err: unknown) => {
    if (err instanceof GitError && err.exitCode === 1 && !err.stderr.trim()) return 'files';
    throw err;
  })).trim().toLowerCase();
  if (refStorage !== 'files' && refStorage !== 'reftable') throw new FailClosedError(`the repository ${prefix ? `${prefix.slice(0, -1)} ` : ''}keeps its refs in an unknown backend (extensions.refStorage = ${refStorage}), whose changes cannot be dated`);
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
  const sparseTrust: SparseTrust = { before: Date.parse(session.startedAt) - WINDOW_SLACK_MS, timeOf: onDevice(ctx.rawObjectTime, pathStat, await deviceOf(await gitCommonDir(root), pathStat)) };

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
      ...(indexBase ? { indexBase } : {}),
    });
    const hits: string[] = [];
    for (const h of report.hunks) {
      // Fail closed: the text of a file the session touched (the diff covers only files it edited,
      // named in a command, or changed during one of its calls) could not be produced (binary by git
      // attributes and too big to re-diff, an untracked file over 2 MB or unreadable), so what changed
      // in it is unknown. Blocks whatever the path.
      if (h.labels.some((l) => l.kind === 'unreviewed')) {
        const detail = `could not be diffed as text (git attributes mark it binary, or it is too big or unreadable): ${h.hunk.file}`;
        hits.push(`- ${prefix}${h.hunk.file} unreviewed: ${detail}`);
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
        const hit = `- ${prefix}${h.hunk.file}:${h.hunk.newStart} ${l.kind}: ${l.detail}`;
        if (!hits.includes(hit)) hits.push(hit);
      }
    }
    return hits;
  };

  // First the paths the session named (its edits and shell commands): cheap, and a finding there
  // blocks without walking the whole working tree.
  if (paths.length) {
    const first = await check(paths, NO_CREDIT);
    if (first.length) return first;
  }

  // Files a shell command changed without naming them (a script computing the path, `rsync --delete`,
  // a path from the environment, a background process): credited when the file (or, once deleted,
  // the nearest path above it) last changed (ctime) while one of this session's tool calls ran.
  // A skip-worktree file missing from the working tree is excused only when the sparse checkout,
  // as the repository's own config and patterns from before the session define it, leaves it out.
  const excluded = await sparseExcluded(root, sparseTrust);
  const byWindow = await toolWindowFiles(root, headed ? baseRev : undefined, windows, opts.statTime ? statTime : undefined, pathStat, excluded, repo.onlyFiles);
  const hits: string[] = [];
  // Files on another file system mounted inside the repository: their times prove nothing (a FAT
  // image takes any ctime), so one that differs from the base, or any test or config file there,
  // blocks as unreviewed.
  for (const [f, mount] of [...byWindow.foreign].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (byWindow.differs.has(f) || isTestFile(f) || isConfigFile(f)) {
      hits.push(`- ${prefix}${f} unreviewed: on another file system mounted inside the repository (at ${prefix}${mount}), whose change times cannot be trusted`);
    }
  }
  // Untracked files credited by time alone are capped: past the cap they are not read, only reported.
  // Both by count and by total size: reading and labelling them is synchronous work.
  const timedNew = [...byWindow.written].filter((f) => byWindow.untracked.has(f)).sort();
  const byteCap = Number(process.env.WHY_DIFF_MAX_TIMED_BYTES) > 0 ? Number(process.env.WHY_DIFF_MAX_TIMED_BYTES) : MAX_TIMED_BYTES;
  const kept = timedNew.slice(0, MAX_TIMED_UNTRACKED);
  const over = timedNew.slice(MAX_TIMED_UNTRACKED);
  let bytes = 0;
  for (let i = 0; i < kept.length; i += LSTAT_BATCH) {
    const sizes = await Promise.all(kept.slice(i, i + LSTAT_BATCH).map((f) => lstat(path.join(root, ...f.split('/'))).then((st) => st.size, () => 0)));
    for (const [j, size] of sizes.entries()) {
      bytes += size;
      if (bytes > byteCap) {
        over.unshift(...kept.slice(i + j));
        kept.length = i + j;
        break;
      }
    }
    if (bytes > byteCap) break;
  }
  if (over.length) {
    for (const f of over) byWindow.written.delete(f);
    over.sort();
    hits.push(`- ${prefix}${over[0]} unreviewed: ${over.length} more untracked files written during this session's tool calls were not reviewed (over the caps of ${MAX_TIMED_UNTRACKED} files and ${byteCap} bytes read), e.g. ${over.slice(0, 3).map((f) => `${prefix}${f}`).join(', ')}`);
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
  const layeredActive = Boolean(windows && repo.metaTimes.some((t) => windows.inWindow(t) || t > windows.lastEnd));
  if (headed && windows) {
    if (layeredActive) {
      for (const [args, deletedOnly] of [[[baseRev, 'HEAD'], false], [['--cached', indexBase ?? baseRev], false], [['--diff-filter=D', baseRev, 'HEAD'], true], [['--diff-filter=D', '--cached', indexBase ?? baseRev], true]] as const) {
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
  if (all.length) for (const hit of await check(all, credit)) if (!hits.includes(hit)) hits.push(hit);
  for (const hit of await checkSubmodules(ctx, repo, layeredActive)) if (!hits.includes(hit)) hits.push(hit);
  return hits;
}

/**
 * Every submodule of `repo` (a gitlink in its base, HEAD or index): checked out, it is checked like
 * the repository itself ({@link checkRepository}), from the commit the base records for it, dated by
 * its own work tree, index and ref times against the same session windows. It blocks as unreviewed
 * when it cannot be read: not checked out while its gitlink changed during the session, a directory
 * holding files but no repository, a symlink or a mount in its place, the recorded commit missing,
 * or more than {@link MAX_SUBMODULE_DEPTH} levels deep. A clean, unchanged submodule finds nothing.
 */
async function checkSubmodules(ctx: SessionCheck, repo: RepoUnderCheck, layeredActive: boolean): Promise<string[]> {
  const { root, baseRev, headed, indexBase, prefix, depth } = repo;
  const links = new Map<string, { base?: string; head?: string; index?: string }>();
  const link = (p: string): { base?: string; head?: string; index?: string } => {
    let l = links.get(p);
    if (!l) links.set(p, (l = {}));
    return l;
  };
  for (const e of await indexEntries(root)) if (e.mode === GITLINK) link(e.path).index = e.oid;
  if (headed) {
    // Gitlinks gone from the index (removed, or replaced by a directory of files) but in the base or HEAD.
    for (const revs of [[baseRev, 'HEAD'], ['--cached', indexBase ?? baseRev]]) {
      const raw = (await git(root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', ...revs, '--'], { trim: false })).split('\0');
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const [oldMode, newMode] = raw[i]!.replace(/^:/, '').split(' ');
        if (oldMode === GITLINK || newMode === GITLINK) link(raw[i + 1]!);
      }
    }
  }
  if (!links.size) return [];
  const treeLink = async (rev: string, p: string): Promise<string | undefined> => {
    const out = await git(root, ['ls-tree', '-z', rev, '--', `:(literal)${p}`], { trim: false });
    const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(out);
    return m && m[1] === GITLINK ? m[2] : undefined;
  };
  const rootDev = await deviceOf(root, ctx.pathStat);
  const real = (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));
  const hits: string[] = [];
  const unreviewed = (p: string, why: string): void => {
    hits.push(`- ${prefix}${p} unreviewed: submodule ${why}, so its changes were not reviewed`);
  };
  for (const [p, l] of [...links].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (headed) {
      l.base = await treeLink(baseRev, p);
      l.head = await treeLink('HEAD', p);
    }
    const changed = headed && new Set([l.base, l.head, l.index].map((x) => x ?? '-')).size > 1;
    const abs = path.join(root, ...p.split('/'));
    const st = await lstat(abs).catch(() => undefined);
    if (!st) {
      if (changed && layeredActive) unreviewed(p, 'is not checked out, and its recorded commit changed during the session');
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || (await ctx.pathStat(abs).then((x) => x.dev, () => rootDev)) !== rootDev) {
      unreviewed(p, 'is a symlink, a file or a mount point in the place of the submodule directory');
      continue;
    }
    const gitEntry = path.join(abs, '.git');
    const hasGit = await lstat(gitEntry).then(() => true, () => false);
    const subRoot = hasGit ? await repoRoot(abs).catch(() => undefined) : undefined;
    if (!subRoot || (await real(subRoot)) !== (await real(abs))) {
      if (hasGit || (await readdir(abs).catch(() => [] as string[])).length) unreviewed(p, 'holds files but no repository of its own (its .git is missing or points elsewhere)');
      else if (changed && layeredActive) unreviewed(p, 'is not checked out, and its recorded commit changed during the session');
      continue;
    }
    if (depth + 1 > MAX_SUBMODULE_DEPTH) {
      unreviewed(p, `is nested more than ${MAX_SUBMODULE_DEPTH} levels deep`);
      continue;
    }
    const subHeaded = await hasHead(subRoot);
    const prefixed = `${prefix}${p}/`;
    const key = `${prefix}${p}`;
    // Its times prove something only on a trusted file system, on the devices it had at session start.
    const subCommon = await gitCommonDir(subRoot);
    try {
      await trustedFileSystem(subRoot, `submodule ${key}`, ctx.fsType);
      await trustedFileSystem(subCommon, `the git dir of submodule ${key}`, ctx.fsType);
    } catch (err) {
      unreviewed(p, `is on an untrusted file system (${(err as Error).message.replace(/^unreviewed: /, '')})`);
      continue;
    }
    const rec = ctx.recordedSubmodules?.[key];
    const subGitDev = await deviceOf(subCommon, ctx.pathStat);
    if (rec?.rootDev !== undefined || rec?.gitDev !== undefined) {
      const rootNow = await deviceOf(await real(subRoot), ctx.pathStat);
      if ((rec.rootDev !== undefined && rec.rootDev !== rootNow) || (rec.gitDev !== undefined && rec.gitDev !== subGitDev)) {
        unreviewed(p, 'or its git dir is on another file system than at session start');
        continue;
      }
    }
    const subRoots = rootVariants(subRoot);
    const named = ctx.session.edits.some((e) => !e.failed && repoRelativePath(e.filePath, subRoots, ctx.session.cwd) !== null);
    // `git status` lists changed files from the index's stat data; entries flagged assume-unchanged or
    // skip-worktree are never compared, so they are always candidates.
    const candidatePaths = async (): Promise<Set<string>> => {
      const set = statusPaths(await git(subRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { trim: false }));
      for (const e of await indexEntries(subRoot)) if (e.tag === 'S' || e.tag === 's' || (e.tag >= 'a' && e.tag <= 'z')) set.add(e.path);
      return set;
    };
    if (rec?.gitDev === undefined && subGitDev !== ctx.gitDev) {
      // Its git dir (index, refs, objects) on another device than the repository's, with no device
      // recorded for it: none of its times can be trusted. Unchanged and clean (by `git status`, the
      // flagged entries and every tracked file's own change time in its work tree) costs nothing;
      // anything else is unreviewed.
      const walk = await toolWindowFiles(subRoot, undefined, ctx.windows, ctx.opts.statTime ? ctx.statTime : undefined, ctx.pathStat, null);
      if (changed || named || (await candidatePaths()).size || walk.written.size || walk.removed.size || walk.foreign.size) {
        unreviewed(p, 'has its git dir on another file system than the repository\'s, with no device recorded at session start, and it changed');
        continue;
      }
      const unchanged: RepoUnderCheck = { root: subRoot, baseRev: subHeaded ? 'HEAD' : await emptyTree(subRoot), headed: subHeaded, metaTimes: [], prefix: prefixed, depth: depth + 1 };
      for (const hit of await checkSubmodules(ctx, unchanged, false)) if (!hits.includes(hit)) hits.push(hit);
      continue;
    }
    const metaTimes = await gitMetaTimes(gitEntry, ctx.statTime, ctx.pathStat);
    // Its index and refs unchanged during the session: HEAD is where it was at session start, and the
    // index's stat data can be trusted (change times compared, which a command cannot set on a
    // trusted file system), so `git status` lists every changed file and only those are dated. None,
    // and no path the session named in it: nothing to check there but its own submodules.
    const w = ctx.windows;
    const quiet = !(w && metaTimes.some((t) => w.inWindow(t) || t > w.lastEnd));
    let candidates: Set<string> | undefined;
    if (quiet) {
      candidates = await candidatePaths();
      if (!candidates.size && !named) {
        const unchanged: RepoUnderCheck = { root: subRoot, baseRev: subHeaded ? 'HEAD' : await emptyTree(subRoot), headed: subHeaded, metaTimes, prefix: prefixed, depth: depth + 1 };
        for (const hit of await checkSubmodules(ctx, unchanged, false)) if (!hits.includes(hit)) hits.push(hit);
        continue;
      }
    }
    // The submodule's own base: the head the SessionStart record kept for it, else its own trusted
    // pre-session commit (reflogs and first-parent history, by object write times), as for the
    // repository itself. Not the superproject's gitlink: a checkout behind it (a pull without
    // `git submodule update`) would otherwise read as the agent's change.
    const objectTime = onDevice(ctx.rawObjectTime, ctx.pathStat, subGitDev);
    let subBase: string;
    try {
      subBase = subHeaded ? await sessionBase(subRoot, Date.parse(ctx.session.startedAt), objectTime, ctx.recordedSubmodules?.[`${prefix}${p}`]?.head) : await emptyTree(subRoot);
    } catch (err) {
      if (!(err instanceof FailClosedError)) throw err;
      if (l.base || l.index !== l.head) {
        unreviewed(p, `has no commit from before the session to compare against (${err.message})`);
        continue;
      }
      subBase = await emptyTree(subRoot); // added during the session: every file in it is new
    }
    const sub: RepoUnderCheck = { root: subRoot, baseRev: subBase, headed: subHeaded, metaTimes, prefix: prefixed, depth: depth + 1 };
    if (candidates && (!subHeaded || (await git(subRoot, ['rev-parse', 'HEAD'])) === subBase)) sub.onlyFiles = candidates;
    for (const hit of await checkRepository(ctx, sub)) if (!hits.includes(hit)) hits.push(hit);
  }
  return hits;
}

const GITLINK = '160000';

/** The paths `git status --porcelain=v2 -z` lists: changed, renamed (both names), unmerged and untracked. */
function statusPaths(out: string): Set<string> {
  const paths = new Set<string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const fields = (n: number): string | undefined => {
      let at = 0;
      for (let k = 0; k < n; k++) {
        at = t.indexOf(' ', at) + 1;
        if (at === 0) return undefined;
      }
      return t.slice(at);
    };
    let p: string | undefined;
    if (t.startsWith('1 ')) p = fields(8);
    else if (t.startsWith('2 ')) {
      p = fields(9);
      if (tokens[i + 1]) paths.add(tokens[++i]!);
    } else if (t.startsWith('u ')) p = fields(10);
    else if (t.startsWith('? ')) p = t.slice(2);
    if (p) paths.add(p);
  }
  return paths;
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
/** Total size of those files that is read (`WHY_DIFF_MAX_TIMED_BYTES` overrides it, for tests). */
const MAX_TIMED_BYTES = 32 * 1024 * 1024;

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

/**
 * Outside any repository: throw {@link FailClosedError} when this session started in one, so a `.git`
 * moved away during the session (or the repository renamed under the session's directory) cannot
 * make the guard skip it. The record's content is not trusted here (the agent can rewrite it):
 * - the transcript carries the SessionStart record or failed marker (the hook ran in a repository
 *   for this session): always blocks, whatever the record says or whether it still exists. A
 *   transcript that exists but cannot be read counts as a marker;
 * - no marker, but a record file for this session: blocks when its change time is unknown, inside a
 *   tool call window, or after the session started (the agent may have written it), and otherwise
 *   when the root it names is the cwd or contains it (or cannot be read).
 * No marker and no record: not a repository session.
 */
async function startedInRepository(payload: GuardPayload, cwd: string, statTime: (p: string) => Promise<number>, pathStat: (p: string) => Promise<PathStat>): Promise<void> {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const gone = (why: string): FailClosedError => new FailClosedError(`no .git is found at or above ${cwd}, but ${why}: the repository (or its .git) was moved or removed during the session`);
  // A transcript that does not exist carries no marker; one that cannot be read may hide one.
  const markers = await transcriptMarkers(payload.transcript_path, sessionId).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? { ok: false, failed: false } : { ok: true, failed: true }));
  if (markers.ok || markers.failed) throw gone('the SessionStart hook ran in a repository for this session (its marker is in the transcript)');
  const record = await readBaseRecord(sessionId, statTime, pathStat).catch(() => {
    throw gone('this session has a SessionStart base record that cannot be read');
  });
  if (!record) return;
  let windows: ReturnType<typeof windowCheck> = null;
  let started = NaN;
  try {
    const session = await claudeCodeAdapter.parse(payload.transcript_path!);
    windows = windowCheck(session);
    started = Date.parse(session.startedAt);
  } catch {
    // unknown: the record cannot be dated
  }
  const t = record.ctime;
  if (!Number.isFinite(t) || !Number.isFinite(started) || t >= started || (windows && (windows.inWindow(t) || t > windows.lastEnd))) {
    throw gone(`this session has a SessionStart base record whose change time cannot be trusted (${record.file})`);
  }
  if (!record.data) throw gone(`this session has a SessionStart base record that cannot be read (${record.file})`);
  const real = (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));
  const root = await real(record.data.root);
  const here = await real(cwd);
  if (here === root || here.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) {
    throw gone(`this session started in the repository ${record.data.root} (SessionStart record)`);
  }
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
 * when present; the HEAD file itself when detached; with the reftable backend, `reftable/` and every
 * file in it. Read from the file system alone, so no git
 * process can touch them first. A missing index is dated by the directory that held it. Nothing
 * that cannot be read fails: the times only add credit.
 */
async function gitMetaTimes(gitEntry: string, statTime: (p: string) => Promise<number>, pathStat: (p: string) => Promise<PathStat>): Promise<number[]> {
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
  // A file on another device than the git dir it belongs to (the worktree's own git dir for the
  // index, HEAD and its reflog; the common dir for refs) sits on a mount: its time reads as changed
  // after every call (see onDevice). A mount over the git dir itself is caught by the devices the
  // SessionStart record keeps, or by the file system type check.
  const anchored = async (dir: string): Promise<(p: string) => Promise<number | undefined>> => {
    const timeOf = onDevice(statTime, pathStat, await deviceOf(dir, pathStat));
    return (p) => timeOf(p).then((t) => t, () => undefined);
  };
  const time = await anchored(gitDir);
  const commonTime = await anchored(common);
  const files: Array<Promise<number | undefined>> = [
    time(path.join(gitDir, 'index')).then((t) => t ?? time(gitDir)),
    time(path.join(gitDir, 'logs', 'HEAD')),
    commonTime(path.join(common, 'packed-refs')),
  ];
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '');
  const ref = /^ref:\s*(refs\/\S+)\s*$/.exec(head)?.[1];
  if (ref && !ref.split('/').includes('..')) files.push(commonTime(path.join(common, ...ref.split('/'))));
  else files.push(time(path.join(gitDir, 'HEAD')));
  // The reftable backend (`extensions.refStorage = reftable`, or `git refs migrate`) keeps every ref
  // and reflog in `reftable/` (tables.list and the *.ref tables), of the common dir and of a worktree.
  for (const [dir, t] of [[path.join(common, 'reftable'), commonTime], ...(gitDir === common ? [] : [[path.join(gitDir, 'reftable'), time] as const])] as const) {
    files.push(t(dir));
    for (const f of await readdir(dir).catch(() => [] as string[])) files.push(t(path.join(dir, f)));
  }
  return (await Promise.all(files)).filter((t): t is number => t !== undefined);
}

/**
 * The SessionStart hook's markers for this session in the transcript (hook attachment lines whose
 * output carries them): `ok` proves the base record was written (so it must still exist), `failed`
 * that it could not be (so there is no trusted base).
 */
async function transcriptMarkers(transcript: string | undefined, sessionId: string): Promise<{ ok: boolean; failed: boolean }> {
  const found = { ok: false, failed: false };
  if (!transcript) return found;
  const want = [recordMarker(sessionId), failedMarker(sessionId)];
  const stream = createReadStream(transcript, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!want.some((m) => raw.includes(m))) continue;
      let line: { type?: unknown; attachment?: unknown };
      try {
        line = JSON.parse(raw) as typeof line;
      } catch {
        continue;
      }
      if (line.type !== 'attachment') continue;
      const texts = strings(line.attachment);
      if (texts.some((t) => t.includes(want[0]!))) found.ok = true;
      if (texts.some((t) => t.includes(want[1]!))) found.failed = true;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return found;
}

/**
 * Was this object written before `cutoff`: a loose object of the repository's own store whose file
 * changed before then, or one in a pack whose pack and index files both did?
 */
async function writtenBefore(root: string, sha: string, cutoff: number, timeOf: (p: string) => Promise<number>): Promise<boolean> {
  const main = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'objects']));
  const loose = await timeOf(path.join(main, sha.slice(0, 2), sha.slice(2))).catch(() => undefined);
  if (loose !== undefined) return loose < cutoff;
  const dir = path.join(main, 'pack');
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith('.pack'))) {
    const idx = path.join(dir, `${f.slice(0, -5)}.idx`);
    const times = await Promise.all([timeOf(path.join(dir, f)), timeOf(idx)].map((t) => t.catch(() => Infinity)));
    if (!times.every((t) => t < cutoff)) continue;
    const buf = await readFile(idx).catch(() => undefined);
    if (buf && packIndexHas(buf, sha)) return true;
  }
  return false;
}

/** The session's base record (see `why-diff session-start`) with its file's change time, if there is one. */
async function readBaseRecord(sessionId: string, statTime: (p: string) => Promise<number>, pathStat: (p: string) => Promise<PathStat> = lstatOf): Promise<{ file: string; ctime: number; data?: BaseRecord } | undefined> {
  const file = recordPath(sessionId);
  // A record on another file system than the directory holding the data directory (a mount over it) has no trusted time.
  const timeOf = onDevice(statTime, pathStat, await deviceOf(path.dirname(dataDir()), pathStat));
  let ctime: number;
  try {
    ctime = await timeOf(file);
  } catch (err) {
    if (GONE.has((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw new FailClosedError(`base record missing or unreadable (${file})`);
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

/** The git common dir of the repository at `root` (the main repository's `.git` for a linked worktree), absolute. */
async function gitCommonDir(root: string): Promise<string> {
  return path.resolve(root, await git(root, ['rev-parse', '--git-common-dir']));
}

/**
 * File system types whose change times a user without root cannot set: local disk file systems and
 * the kernel's own. Not: FAT and exFAT (ctime is the stored mtime, `touch` sets it), FUSE, network
 * file systems (the server reports times), and anything unknown.
 */
const TRUSTED_FS: ReadonlySet<string> = new Set(['apfs', 'hfs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'ntfs', 'refs', 'tmpfs', 'overlay']);
/** Linux `statfs` `f_type` magic numbers, by name (ext2/3/4 share one). */
const LINUX_FS: ReadonlyMap<number, string> = new Map([
  [0xef53, 'ext4'], [0x58465342, 'xfs'], [0x9123683e, 'btrfs'], [0x2fc12fc1, 'zfs'], [0x5346544e, 'ntfs'], [0x01021994, 'tmpfs'], [0x794c7630, 'overlay'],
  [0x4244, 'hfs'], [0x482b, 'hfs'], [0x4d44, 'msdos'], [0x2011bab0, 'exfat'], [0x65735546, 'fuse'], [0x6969, 'nfs'], [0x517b, 'smbfs'], [0xff534d42, 'cifs'], [0xfe534d42, 'smb2'],
]);
let darwinMounts: Promise<Map<number, string>> | undefined;
/** macOS: file system type by device, from `mount` (each `/dev/...` source's `st_rdev` is the `st_dev` of files on it). */
function darwinMountTypes(): Promise<Map<number, string>> {
  darwinMounts ??= new Promise<string>((resolve, reject) => execFile('/sbin/mount', [], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out))))
    .then(async (out) => {
      const types = new Map<number, string>();
      for (const line of out.split('\n')) {
        const m = /^(\/dev\/\S+) on .+ \(([^,)]+)/.exec(line);
        if (!m) continue;
        const rdev = await stat(m[1]!).then((st) => Number(st.rdev), () => undefined);
        if (rdev !== undefined && !types.has(rdev)) types.set(rdev, m[2]!);
      }
      return types;
    });
  setTimeout(() => { darwinMounts = undefined; }, 2000).unref();
  return darwinMounts;
}
const fsTypes = new Map<string, Promise<string>>();
/** The type of the file system holding `p` (`apfs`, `ext4`, `msdos`...), once per path; throws when it cannot be told. */
function fileSystemType(p: string): Promise<string> {
  let t = fsTypes.get(p);
  if (!t) {
    t = readFileSystemType(p);
    fsTypes.set(p, t);
    // One guard run is short; a long-lived process (the library) must see a later mount.
    setTimeout(() => fsTypes.delete(p), 2000).unref();
  }
  return t;
}
async function readFileSystemType(p: string): Promise<string> {
  if (process.platform === 'win32') return windowsFileSystemType(p);
  if (process.platform === 'darwin') {
    const dev = Number((await lstat(p)).dev);
    const type = (await darwinMountTypes()).get(dev);
    if (!type) throw new Error(`no mounted device ${dev} found for ${p}`);
    return type;
  }
  const { type } = await statfs(p);
  return LINUX_FS.get(type) ?? `unknown (0x${type.toString(16)})`;
}
/**
 * The command that reads the Windows volume holding `realPath`: PowerShell's `Get-Volume -FilePath`,
 * by absolute path under `%SystemRoot%` (the hook's own environment, not the agent's), run in the
 * temporary directory without a shell. The path travels as data (`WD_PATH` in the environment),
 * never in the script text, so no character in it (a quote of any kind, `$`, a backtick) can
 * change the script (exported for tests).
 */
export function windowsVolumeCommand(realPath: string): { file: string; args: string[]; options: { cwd: string; windowsHide: true; shell: false; encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv } } {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return {
    file: path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_VOLUME_SCRIPT],
    options: { cwd: os.tmpdir(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 20_000, env: { ...process.env, WD_PATH: realPath } },
  };
}
const WINDOWS_VOLUME_SCRIPT = '$v = Get-Volume -FilePath $env:WD_PATH -ErrorAction Stop; "$($v.FileSystemType)|$($v.DriveType)"';
const windowsVolumes = new Map<number, Promise<string>>();
/**
 * Windows: the file system of the volume that actually holds `p` (junctions and folder mount points
 * followed with `realpath`), from `Get-Volume -FilePath` ({@link windowsVolumeCommand}). Trusted only
 * as NTFS or ReFS on a Fixed or Removable drive: any other file system or drive type (Remote, Network,
 * Unknown...), a UNC path, or a failure is not. Cached by volume serial (`st_dev`) for the process:
 * one PowerShell start per volume per guard run.
 */
async function windowsFileSystemType(p: string): Promise<string> {
  const real = await new Promise<string>((resolve, reject) => realpathNative(p, (err, out) => (err ? reject(err) : resolve(out))));
  if (/^\\\\/.test(real)) throw new Error(`${real} is a UNC or network path`);
  if (!/^[A-Za-z]:[\\/]/.test(real)) throw new Error(`${real} is not on a local drive`);
  const dev = Number((await stat(real)).dev);
  let t = windowsVolumes.get(dev);
  if (!t) {
    const c = windowsVolumeCommand(real);
    t = new Promise<string>((resolve, reject) => execFile(c.file, c.args, c.options, (err, out) => (err ? reject(err) : resolve(String(out)))))
      .then((out) => {
        const m = /^(\w+)\|(\w*)\s*$/m.exec(out.trim());
        if (!m) throw new Error('no file system in Get-Volume output');
        if (!/^(fixed|removable)$/i.test(m[2]!)) throw new Error(`drive type ${m[2] || 'unknown'}`);
        const fs = m[1]!.toLowerCase();
        return fs === 'ntfs' || fs === 'refs' ? fs : `${fs} (Windows)`;
      });
    windowsVolumes.set(dev, t);
    t.catch(() => windowsVolumes.delete(dev));
  }
  return t;
}
/** Throw {@link FailClosedError} unless `p` sits on a file system type from {@link TRUSTED_FS}. */
async function trustedFileSystem(p: string, what: string, fsType: (p: string) => Promise<string>): Promise<void> {
  let type: string;
  try {
    type = await fsType(p);
  } catch (err) {
    throw new FailClosedError(`unreviewed: cannot tell which file system ${what} is on (${p}: ${(err as Error).message}), so its change times cannot be trusted`);
  }
  if (!TRUSTED_FS.has(type.toLowerCase())) throw new FailClosedError(`unreviewed: ${what} (${p}) is on a ${type} file system, whose change times can be set without root, so its changes cannot be dated`);
}

/** What the guard reads of a path (lstat: a symlink is never followed). */
export interface PathStat {
  dev: number;
  ctimeMs: number;
  symlink: boolean;
}

async function lstatOf(p: string): Promise<PathStat> {
  const st = await lstat(p);
  return { dev: Number(st.dev), ctimeMs: st.ctimeMs, symlink: st.isSymbolicLink() };
}

/** The device of `p` (its file system), or undefined when it cannot be read. */
async function deviceOf(p: string, pathStat: (p: string) => Promise<PathStat>): Promise<number | undefined> {
  return pathStat(p).then((st) => st.dev, () => undefined);
}

/**
 * `timeOf`, except that a path on another device than `dev` (a file system mounted inside the
 * repository or the data directory) reads as changed now and forever (Infinity): ctime proves
 * nothing there, since a user-mounted FAT image or FUSE file system reports any time it likes.
 */
function onDevice(timeOf: (p: string) => Promise<number>, pathStat: (p: string) => Promise<PathStat>, dev: number | undefined): (p: string) => Promise<number> {
  if (dev === undefined) return timeOf;
  return async (p) => {
    const t = await timeOf(p);
    const d = await deviceOf(p, pathStat);
    return d !== undefined && d !== dev ? Infinity : t;
  };
}

/**
 * Changed files (against `rev`, working tree and untracked) and every tracked file, whose change
 * time lies inside one of the session's tool call windows (`written`), and deleted ones whose
 * nearest existing ancestor's time does (`removed`). Every tracked file is checked, not only those
 * `git diff` lists: an index entry (flagged, or forged with the new file's stat data) can hide a
 * change from git, not from the file's ctime. A human edit after the call moves the time out of
 * every window, so it is never credited; a human edit while an agent tool call is running is (the
 * one edge; long calls, subagents and background processes widen it).
 *
 * No symlink is followed: each directory above a file inside the repository is read with lstat. A
 * symlink there (git sees every file under it as deleted, while a path lookup would find the moved
 * originals through it) makes the file deleted, dated by the symlink's own change time, and credited
 * when that lies in a window or after the last one. A directory or file on another device than the
 * repository root (a mount) is not dated at all: it is returned in `foreign`, with its mount point.
 */
async function toolWindowFiles(root: string, rev: string | undefined, windows: { inWindow: (ms: number) => boolean; lastEnd: number } | null, statTime: ((p: string) => Promise<number>) | undefined, pathStat: (p: string) => Promise<PathStat>, excluded: ((file: string) => boolean) | null, onlyFiles?: ReadonlySet<string>): Promise<{ written: Set<string>; removed: Set<string>; untracked: Set<string>; foreign: Map<string, string>; differs: Set<string> }> {
  const written = new Set<string>();
  const removed = new Set<string>();
  const untracked = new Set<string>();
  const foreign = new Map<string, string>();
  const differs = new Set<string>();
  if (!windows) return { written, removed, untracked, foreign, differs };
  const { inWindow, lastEnd } = windows;
  const timeOf = statTime ?? changeTime;

  const changed = await git(root, ['diff', '--name-only', '--no-renames', '-z', rev ?? (await emptyTree(root)), '--'], { trim: false });
  const entries = await indexEntries(root);
  // Skip-worktree files the sparse checkout leaves out are expected to be missing.
  const sparse = await sparseMissing(root, entries, excluded);
  for (const f of await listUntracked(root)) untracked.add(f);
  for (const f of changed.split('\0')) if (f) differs.add(f);
  for (const f of untracked) differs.add(f);
  // Gitlinks are submodules: checked on their own (see checkSubmodules).
  const gitlinks = new Set(entries.filter((e) => e.mode === GITLINK).map((e) => e.path));
  const files = [...new Set([...differs, ...entries.map((e) => e.path)])]
    .filter((f) => !f.startsWith('.why-diff/') && !sparse.has(f) && !gitlinks.has(f) && (!onlyFiles || onlyFiles.has(f)));
  // `git rev-parse --show-toplevel` prints `C:/x` on Windows: resolve it so the walk below compares like with like.
  const top = path.resolve(root);
  const rootDev = await deviceOf(top, pathStat);
  const gone = (err: unknown): boolean => {
    if (GONE.has((err as NodeJS.ErrnoException).code ?? '')) return true;
    throw err;
  };
  // Each directory inside the repository, read once: fine, missing (or not a directory), a symlink,
  // or on another device. A directory under a symlink or a mount takes that state from it.
  type DirState = { kind: 'ok' | 'gone' } | { kind: 'symlink' | 'foreign'; at: string };
  const dirStates = new Map<string, Promise<DirState>>();
  const dirState = (rel: string): Promise<DirState> => {
    if (!rel || rel === '.') return Promise.resolve({ kind: 'ok' });
    let st = dirStates.get(rel);
    if (!st) {
      st = dirState(path.posix.dirname(rel)).then(async (up) => {
        if (up.kind !== 'ok') return up;
        const abs = path.join(top, ...rel.split('/'));
        let ps: PathStat;
        try {
          ps = await pathStat(abs);
        } catch (err) {
          gone(err);
          return { kind: 'gone' };
        }
        if (ps.symlink) return { kind: 'symlink', at: rel };
        if (rootDev !== undefined && ps.dev !== rootDev) return { kind: 'foreign', at: rel };
        return { kind: 'ok' };
      });
      dirStates.set(rel, st);
    }
    return st;
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
      const up = await dirState(path.posix.dirname(f));
      if (up.kind === 'symlink') {
        // Never followed: the file is gone from the repository, removed when the symlink appeared.
        // Whatever git makes of it (git for Windows reads through a junction), every change to the
        // file is credited by the link's own time.
        const t = await timeOf(path.join(top, ...up.at.split('/'))).catch(() => Infinity);
        if (inWindow(t) || t > lastEnd) {
          removed.add(f);
          written.add(f);
        }
        return;
      }
      if (up.kind === 'foreign') {
        foreign.set(f, up.at);
        return;
      }
      const abs = path.join(top, ...f.split('/'));
      let t: number | undefined;
      if (up.kind === 'ok') {
        try {
          const ps = await pathStat(abs);
          if (rootDev !== undefined && ps.dev !== rootDev) {
            foreign.set(f, f);
            return;
          }
          t = statTime ? await statTime(abs) : ps.ctimeMs;
        } catch (err) {
          gone(err);
        }
      }
      if (t !== undefined) {
        if (inWindow(t)) written.add(f);
        return;
      }
      const d = await dirTime(path.dirname(abs));
      if (d !== undefined && inWindow(d)) removed.add(f);
    }));
  }
  return { written, removed, untracked, foreign, differs };
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
