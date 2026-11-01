/**
 * Claude Code Stop-hook guard: decide whether the agent should be stopped from finishing
 * because ITS OWN edits in this session skipped, weakened or removed tests (or touched CI/secrets).
 *
 * Scoped on purpose: only the files the session's transcript edited are diffed, against the last
 * commit before the session started (so edits the agent already committed still count), and only
 * hunks that the session's edits exactly explain can block. A human's uncommitted change in the
 * same file never does. Every internal error means "do not block".
 */
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { buildReport } from './pipeline.js';
import { claudeCodeAdapter } from './adapters/claude.js';
import { emptyTree, FailClosedError, git, hasHead, isCaseInsensitive, listUntracked, repoRoot, worktreeRoots } from './git.js';
import { globToRegExp, repoRelativePath, rootVariants } from './attribute.js';
import { compileGlobs, loadConfig, type WhyDiffConfig } from './config.js';
import type { Hunk, LabelKind, Session } from './types.js';

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
  if (headed) baseRev = await sessionBase(root, Date.parse(session.startedAt), opts.objectTime ?? changeTime);

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
  for (const h of report.hunks) {
    // Fail closed: git attributes show a file the session touched (the diff covers only files it
    // edited, named in a command, or changed during one of its calls) as binary and its text could
    // not be produced, so what changed in it is unknown. Blocks whatever the path.
    if (h.labels.some((l) => l.kind === 'unreviewed')) {
      const detail = `could not be diffed as text (git attributes mark it binary): ${h.hunk.file}`;
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
    }
  }

  if (!hits.length) return NO_BLOCK;
  // Every Stop with risky hits blocks; only `stop_hook_active` (set by Claude Code, after a block in
  // this same turn) lets the agent finish. Nothing on disk can switch a block off: the agent can write
  // the repo, its home and its own transcript. The transcript only picks a shorter message when the
  // same list was already shown.
  if (await shownBefore(payload.transcript_path, hits).catch(() => false)) {
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
 * during the session still count. Claude Code transcripts record the branch, not a commit, and
 * committer dates are the agent's to set (`GIT_COMMITTER_DATE` also stamps the reflog), so dates
 * only pick candidates and object write times decide:
 *
 * 1. HEAD's reflog, newest first: the first entry stamped before the session start whose commit was
 *    not written during the session;
 * 2. otherwise HEAD's first-parent history: the first commit not written during the session;
 * 3. otherwise fail closed ({@link FailClosedError}).
 *
 * A commit counts as written before the session only when it is a loose object (in this store or an
 * alternate) whose file changed before the session started, or, not being loose, when no pack file
 * in any store was written during the session. An alternates list changed during the session fails
 * closed. A base that is no longer an ancestor of HEAD (an amend, a rebase) becomes its merge base.
 */
async function sessionBase(root: string, startedAt: number, timeOf: (p: string) => Promise<number>): Promise<string> {
  if (!Number.isFinite(startedAt)) throw new FailClosedError('the transcript has no session start time');
  const cutoff = startedAt - WINDOW_SLACK_MS;
  const parse = (out: string): Array<{ sha: string; at: number }> => out.split('\n').map((l) => {
    const m = /^([0-9a-f]{40,64})\t(?:HEAD@\{)?(\d+)\}?$/.exec(l.trim());
    return m ? { sha: m[1]!, at: Number(m[2]) * 1000 } : null;
  }).filter((e): e is { sha: string; at: number } => e !== null);

  const main = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'objects']));
  const stores = [main];
  const alternatesFile = path.join(main, 'info', 'alternates');
  const alternates = await readFile(alternatesFile, 'utf8').catch(() => undefined);
  if (alternates !== undefined) {
    if ((await timeOf(alternatesFile).catch(() => Infinity)) >= cutoff) throw new FailClosedError('the object alternates list changed during the session');
    for (const line of alternates.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) stores.push(path.resolve(main, line));
  }
  let packedDuringSession: boolean | undefined;
  const writtenBefore = async (sha: string): Promise<boolean> => {
    for (const store of stores) {
      const t = await timeOf(path.join(store, sha.slice(0, 2), sha.slice(2))).catch(() => undefined);
      if (t !== undefined) return t < cutoff;
    }
    // Packed: its own write time is unknown, so trust it only if no pack was written during the session.
    if (packedDuringSession === undefined) {
      packedDuringSession = false;
      for (const store of stores) {
        const dir = path.join(store, 'pack');
        for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith('.pack'))) {
          if ((await timeOf(path.join(dir, f)).catch(() => Infinity)) >= cutoff) packedDuringSession = true;
        }
      }
    }
    return !packedDuringSession;
  };
  const isCommit = (sha: string): Promise<boolean> => git(root, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

  let base: string | undefined;
  for (const e of parse(await git(root, ['reflog', 'show', '--format=%H%x09%gd', '--date=unix', 'HEAD', '--']).catch(() => ''))) {
    if (e.at <= startedAt && (await isCommit(e.sha)) && (await writtenBefore(e.sha))) {
      base = e.sha;
      break;
    }
  }
  if (!base) {
    for (const e of parse(await git(root, ['log', '--first-parent', '-n', '5000', '--format=%H%x09%ct', 'HEAD', '--']).catch(() => ''))) {
      if (await writtenBefore(e.sha)) {
        base = e.sha;
        break;
      }
    }
  }
  if (!base) throw new FailClosedError('no commit from before the session start was found to compare against (every candidate was written during the session)');
  const ancestor = await git(root, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false);
  if (!ancestor) base = await git(root, ['merge-base', base, 'HEAD']).catch(() => base!);
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
