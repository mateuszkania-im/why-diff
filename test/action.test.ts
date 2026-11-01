/** The GitHub Action's sticky-comment script, run with a fake `gh` first on PATH (never the real gh). */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './helpers/claude-fixture.js';

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'action-comment.sh');
const MARKER = '<!-- why-diff:comment -->';
const hasJq = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

/** Fake gh: `api user`, the paginated comment listing (filtered by the real jq, as gh --jq would), PATCH and POST. */
const GH_STUB = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const dir = process.env.GH_STUB_DIR;
const field = args[args.indexOf('-F') + 1] || '';
const body = field.startsWith('body=@') ? fs.readFileSync(field.slice(6), 'utf8') : undefined;
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, body }) + '\\n');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
if (args[0] !== 'api') fail('unexpected');
if (args[1] === 'user') {
  if (!process.env.GH_STUB_USER) fail('HTTP 403: Resource not accessible by integration');
  process.stdout.write(process.env.GH_STUB_USER + '\\n');
} else if (args.includes('--paginate')) {
  if (process.env.GH_STUB_LIST_FAIL) fail('HTTP 500');
  const jq = args[args.indexOf('--jq') + 1];
  process.stdout.write(execFileSync('jq', ['-r', jq], { input: fs.readFileSync(dir + '/comments.json') }));
} else if (args.includes('PATCH') || args.includes('POST')) {
  if (process.env.GH_STUB_WRITE_FAIL) fail('HTTP 403: Resource not accessible by integration');
} else {
  fail('unexpected');
}
`;

let stubDir: string;
let work: string;

beforeAll(() => {
  stubDir = realpathSync(tempDir('why-diff-action-gh-'));
  work = realpathSync(tempDir('why-diff-action-work-'));
  writeFileSync(path.join(stubDir, 'gh'), GH_STUB);
  chmodSync(path.join(stubDir, 'gh'), 0o755);
  writeFileSync(path.join(work, 'report.md'), '## why-diff risk scan\n\nbody\n');
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(path.join(stubDir, 'calls.jsonl'), { force: true });
  writeFileSync(path.join(stubDir, 'comments.json'), '[]');
});

function run(env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string; calls: { args: string[]; body?: string }[] } {
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: [stubDir, process.env.PATH].join(path.delimiter),
      GH_STUB_DIR: stubDir,
      RUNNER_TEMP: work,
      REPORT: path.join(work, 'report.md'),
      REPO: 'acme/app',
      HEAD_REPO: 'acme/app',
      PR_NUMBER: '7',
      ...env,
    },
  });
  const f = path.join(stubDir, 'calls.jsonl');
  const calls = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const comments = (list: { id: number; login: string; body: string }[]) =>
  writeFileSync(path.join(stubDir, 'comments.json'), JSON.stringify(list.map((c) => ({ id: c.id, user: { login: c.login }, body: c.body }))));

// Windows: `bash` on the runner may be WSL's, and the stub `gh` is a shebang script; covered on Linux.
describe.skipIf(!hasJq || process.platform === 'win32')('action comment script', () => {
  it('skips forks with a notice and calls no gh', () => {
    const r = run({ HEAD_REPO: 'mallory/app' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::notice::');
    expect(r.calls).toEqual([]);
  });

  it('posts a new comment starting with the marker when none exists', () => {
    const r = run();
    expect(r.status).toBe(0);
    const write = r.calls.find((c) => c.args.includes('POST'));
    expect(write?.args).toContain('repos/acme/app/issues/7/comments');
    expect(write?.body).toBe(`${MARKER}\n## why-diff risk scan\n\nbody\n`);
    expect(r.calls.some((c) => c.args.includes('PATCH'))).toBe(false);
  });

  it('updates only the bot\'s own marker comment, ignoring a planted one from another user', () => {
    comments([
      { id: 1, login: 'mallory', body: `${MARKER}\nplanted` },
      { id: 2, login: 'github-actions[bot]', body: 'unrelated bot comment' },
      { id: 3, login: 'github-actions[bot]', body: `${MARKER}\nold report` },
      { id: 4, login: 'github-actions[bot]', body: `${MARKER}\nolder duplicate` },
    ]);
    const r = run();
    expect(r.status).toBe(0);
    const writes = r.calls.filter((c) => c.args.includes('PATCH') || c.args.includes('POST'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toContain('repos/acme/app/issues/comments/3');
  });

  it('treats a planted marker comment as absent and posts its own', () => {
    comments([{ id: 1, login: 'mallory', body: `${MARKER}\nplanted` }]);
    const r = run();
    const writes = r.calls.filter((c) => c.args.includes('PATCH') || c.args.includes('POST'));
    expect(writes.map((c) => c.args.includes('POST'))).toEqual([true]);
  });

  it('matches the token\'s own login when `gh api user` works (personal access token)', () => {
    comments([
      { id: 5, login: 'github-actions[bot]', body: `${MARKER}\nfrom the default token` },
      { id: 6, login: 'release-bot', body: `${MARKER}\nours` },
    ]);
    const r = run({ GH_STUB_USER: 'release-bot' });
    const writes = r.calls.filter((c) => c.args.includes('PATCH') || c.args.includes('POST'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toContain('repos/acme/app/issues/comments/6');
  });

  it('uses COMMENT_AUTHOR as the identity filter (GitHub App token that cannot call /user)', () => {
    comments([
      { id: 8, login: 'github-actions[bot]', body: `${MARKER}\nother` },
      { id: 9, login: 'my-app[bot]', body: `${MARKER}\nours` },
    ]);
    const r = run({ COMMENT_AUTHOR: 'my-app[bot]' });
    const writes = r.calls.filter((c) => c.args.includes('PATCH') || c.args.includes('POST'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toContain('repos/acme/app/issues/comments/9');
  });

  it('warns about an invalid COMMENT_AUTHOR and falls back to the default identity', () => {
    comments([
      { id: 10, login: 'github-actions[bot]', body: `${MARKER}\nours` },
      { id: 11, login: 'x"y', body: `${MARKER}\nnot ours` },
    ]);
    const r = run({ COMMENT_AUTHOR: 'x"y' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::invalid comment-author "x"y", using the default');
    const writes = r.calls.filter((c) => c.args.includes('PATCH') || c.args.includes('POST'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toContain('repos/acme/app/issues/comments/10');
  });

  it('escapes a multi-line COMMENT_AUTHOR so it cannot inject a workflow command', () => {
    const r = run({ COMMENT_AUTHOR: 'a\n::error::boom%' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::invalid comment-author "a%0A::error::boom%25", using the default');
    expect(r.stdout.split('\n').some((l) => l.startsWith('::error::'))).toBe(false);
  });

  it('a failing write is a warning, not a failed step', () => {
    const r = run({ GH_STUB_WRITE_FAIL: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
  });

  it('a failing comment listing is a warning, not a failed step', () => {
    const r = run({ GH_STUB_LIST_FAIL: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
    expect(r.calls.some((c) => c.args.includes('PATCH') || c.args.includes('POST'))).toBe(false);
  });
});

describe('action.yml', () => {
  const yml = readFileSync(path.join(root, 'action.yml'), 'utf8');

  it('runs the comment script, passes the head repo, and always writes the job summary', () => {
    expect(yml).toContain('bash "$GITHUB_ACTION_PATH/scripts/action-comment.sh"');
    expect(yml).toContain('HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}');
    expect(yml).toContain('GH_TOKEN: ${{ inputs.token }}');
    expect(yml).toMatch(/token:\n\s+description:[\s\S]*?default: \$\{\{ github\.token \}\}/);
    expect(yml).toContain('COMMENT_AUTHOR: ${{ inputs.comment-author }}');
    expect(yml).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  it('fetches the why-diff notes ref before the report, never failing when it is missing', () => {
    const fetch = yml.indexOf("git fetch --quiet origin '+refs/notes/why-diff:refs/notes/why-diff'");
    expect(fetch).toBeGreaterThan(-1);
    expect(fetch).toBeLessThan(yml.indexOf('- id: report'));
    expect(yml.slice(fetch, yml.indexOf('\n', fetch))).toContain('|| true');
  });
});
