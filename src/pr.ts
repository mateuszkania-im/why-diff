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
 * Put `section` between the why-diff markers in `body`. An existing marked
 * section is replaced in place; otherwise the section is appended after a
 * blank line. Everything outside the markers stays byte-identical.
 */
export function upsertSection(body: string, section: string): string {
  const block = `${SECTION_START}\n${section.replace(/\s+$/, '')}\n${SECTION_END}`;
  const start = body.indexOf(SECTION_START);
  const end = start >= 0 ? body.indexOf(SECTION_END, start + SECTION_START.length) : -1;
  if (start >= 0 && end >= 0) return body.slice(0, start) + block + body.slice(end + SECTION_END.length);
  if (body === '') return `${block}\n`;
  return `${body}${body.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
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
