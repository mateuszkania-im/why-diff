/**
 * `why-diff pr`: put the report into the body of the current branch's pull
 * request, between two HTML comment markers, so the PR author (who has the
 * transcripts) can share provenance with reviewers (who do not).
 *
 * It only ever reads and edits the body of an existing PR through the GitHub
 * CLI (`gh pr view` / `gh pr edit`). It never pushes and never creates a PR.
 */
import { spawn } from 'node:child_process';

export const SECTION_START = '<!-- why-diff:start -->';
export const SECTION_END = '<!-- why-diff:end -->';

/** GitHub rejects PR bodies over 65 536 characters. */
export const PR_BODY_LIMIT = 65_536;

/**
 * Put `section` between the why-diff markers in `body`. Markers count only on a line of their own
 * (trailing spaces and CR allowed), so markers quoted inline in prose are ordinary text. An
 * existing marked section is replaced in place; with no markers the section is appended after a
 * blank line. Everything outside the markers stays byte-identical. Anything else (a start without
 * an end, an end before the start, several sections) is ambiguous: this throws instead of
 * guessing, so the author's own text is never overwritten.
 */
export function upsertSection(body: string, section: string): string {
  const block = `${SECTION_START}\n${section.replace(/\s+$/, '')}\n${SECTION_END}`;
  const starts: Array<[number, number]> = [];
  const ends: Array<[number, number]> = [];
  const re = /^[^\S\r\n]*(<!-- why-diff:(?:start|end) -->)[^\S\n]*$/gm;
  for (const m of body.matchAll(re)) {
    const at = m.index + m[0].indexOf(m[1]!);
    // The block ends after the marker; trailing spaces and the CR stay with the line ending.
    (m[1] === SECTION_START ? starts : ends).push([m.index, at + m[1]!.length]);
  }
  if (starts.length === 0 && ends.length === 0) {
    if (body === '') return `${block}\n`;
    return `${body}${body.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
  }
  const [start] = starts;
  const [end] = ends;
  if (starts.length !== 1 || ends.length !== 1 || !start || !end || end[0] < start[1]) {
    throw new Error(
      `the pull request description has unbalanced why-diff markers (${starts.length} "${SECTION_START}" and ${ends.length} "${SECTION_END}" on their own lines, ` +
      'expected one of each, start first); fix or remove them by hand and run again',
    );
  }
  return body.slice(0, start[0]) + block + body.slice(end[1]);
}

/** Characters left for the section once `body` (outside the markers) and the markers are counted. */
export function sectionBudget(body: string): number {
  return PR_BODY_LIMIT - upsertSection(body, '').length - 1;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

/** Run the GitHub CLI (`WHY_DIFF_GH_BIN` overrides the binary). */
export function ghRunner(bin = process.env.WHY_DIFF_GH_BIN || 'gh'): GhRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
      child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'ENOENT'
          ? new Error('GitHub CLI (gh) not found on PATH: install it from https://cli.github.com and run `gh auth login`')
          : err);
      });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on('error', () => { /* gh exited before reading */ });
      child.stdin.end(input ?? '');
    });
}

/** Body of the pull request for the current branch. Throws when there is none. */
export async function readPrBody(gh: GhRunner): Promise<string> {
  const r = await gh(['pr', 'view', '--json', 'body']);
  if (r.code !== 0) {
    const why = r.stderr.trim().split('\n')[0] || `gh exited with ${r.code}`;
    throw new Error(`no pull request found for the current branch (${why}); open one first, why-diff pr only edits an existing PR`);
  }
  try {
    const body = (JSON.parse(r.stdout) as { body?: unknown }).body;
    return typeof body === 'string' ? body : '';
  } catch {
    throw new Error('could not read the pull request body from `gh pr view --json body`');
  }
}

/** Replace the body of the current branch's pull request. */
export async function writePrBody(gh: GhRunner, body: string): Promise<void> {
  const r = await gh(['pr', 'edit', '--body-file', '-'], body);
  if (r.code !== 0) throw new Error(`gh pr edit failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}
