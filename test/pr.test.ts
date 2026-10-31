/** Risk-scan mode (no transcripts), `why-diff pr` with a fake `gh`, and `upsertSection`. Never calls an LLM or the real gh. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildReport } from '../src/pipeline.js';
import { SECTION_END, SECTION_START, upsertSection } from '../src/pr.js';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const NO_CLAUDE = '/nonexistent/why-diff-test-claude';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

describe('upsertSection', () => {
  const block = (s: string) => `${SECTION_START}\n${s}\n${SECTION_END}`;

  it('appends the section at the end when absent, keeping the body byte-identical', () => {
    const body = 'Fixes #12.\r\n\r\n- did a thing  \n';
    const out = upsertSection(body, '## report\n');
    expect(out.startsWith(body)).toBe(true);
    expect(out).toBe(`${body}\n${block('## report')}\n`);
  });

  it('appends after a body without a trailing newline', () => {
    expect(upsertSection('hello', 'x')).toBe(`hello\n\n${block('x')}\n`);
  });

  it('uses the section alone for an empty body', () => {
    expect(upsertSection('', 'x')).toBe(`${block('x')}\n`);
  });

  it('replaces an existing section and keeps everything around it byte-identical', () => {
    const before = 'intro\n\n';
    const after = '\n\n<!-- other -->\ntrailer';
    const body = `${before}${block('old report\nline 2')}${after}`;
    const out = upsertSection(body, 'new report');
    expect(out).toBe(`${before}${block('new report')}${after}`);
    expect(upsertSection(out, 'new report')).toBe(out);
  });

  it('appends instead of guessing when the markers are out of order', () => {
    const body = `${SECTION_END}\nmiddle\n${SECTION_START}`;
    const out = upsertSection(body, 'x');
    expect(out.startsWith(body)).toBe(true);
    expect(out.endsWith(`${block('x')}\n`)).toBe(true);
  });
});

let repo: string;
let emptyHome: string;
let stubDir: string;
let bareBin: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  // PATH holds the fake gh first, then node and git.
  // The node bin dir can hold a global `claude` (npm i -g); point the classifier at a missing binary so no LLM is ever reached.
  const fullEnv: NodeJS.ProcessEnv = { PATH: [stubDir, bareBin].join(path.delimiter), HOME: emptyHome, GIT_CONFIG_NOSYSTEM: '1', WHY_DIFF_CLAUDE_BIN: NO_CLAUDE, ...GIT_ENV, ...env };
  const r = spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), ...args], { cwd: repo, encoding: 'utf8', env: fullEnv });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const GH_STUB = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.GH_STUB_DIR;
let input = '';
if (args.includes('--body-file')) input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  if (process.env.GH_STUB_NO_PR) { process.stderr.write('no pull requests found for branch "feature"\\n'); process.exit(1); }
  const f = dir + '/body.md';
  process.stdout.write(JSON.stringify({ body: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }));
} else if (args[0] === 'pr' && args[1] === 'edit') {
  fs.writeFileSync(dir + '/body.md', input);
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(3);
}
`;

beforeAll(() => {
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  bareBin = [path.dirname(process.execPath), path.dirname(gitPath)].join(path.delimiter);
  repo = realpathSync(tempDir('why-diff-pr-'));
  emptyHome = realpathSync(tempDir('why-diff-pr-home-'));
  stubDir = realpathSync(tempDir('why-diff-pr-gh-'));
  writeFileSync(path.join(stubDir, 'gh'), GH_STUB);
  chmodSync(path.join(stubDir, 'gh'), 0o755);
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 2;\n');
  git(repo, 'commit', '-q', '-am', 'bump');
  writeFileSync(path.join(repo, 'src/b.js'), 'export const b = 1;\n');
});

afterAll(() => {
  for (const d of [repo, emptyHome, stubDir]) rmSync(d, { recursive: true, force: true });
});

describe('risk-scan mode', () => {
  it('a report built with zero sessions is a risk scan without unattributed labels', async () => {
    const report = await buildReport({ cwd: repo, home: emptyHome });
    expect(report.summary.sessionsFound).toBe(0);
    expect(report.mode).toBe('risk-scan');
    expect(report.hunks.length).toBeGreaterThan(0);
    expect(report.hunks.flatMap((h) => h.labels).some((l) => l.kind === 'unattributed')).toBe(false);
    expect(report.summary.labels.unattributed).toBeUndefined();
  });

  it('markdown output starts with the risk-scan heading', () => {
    const r = cli(['-f', 'md', '-q']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('## why-diff risk scan\n')).toBe(true);
  });

  it('--fail-on risk ignores the dropped unattributed labels but still fails on a real risk label', () => {
    expect(cli(['-f', 'md', '-q', '--fail-on', 'risk']).status).toBe(0);
    const skipped = path.join(repo, 'src', 'skip.test.js');
    writeFileSync(skipped, 'it.skip("works", () => {});\n');
    try {
      const r = cli(['-f', 'md', '-q', '--fail-on', 'risk']);
      expect(r.stdout.startsWith('## why-diff risk scan\n')).toBe(true);
      expect(r.stdout).toContain('test-skip-added');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('failing on risk');
    } finally {
      rmSync(skipped, { force: true });
    }
  });

  it('--fail-on unattributed is ignored with a note', () => {
    const r = cli(['-f', 'md', '-q', '--fail-on', 'unattributed']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('--fail-on unattributed ignored');
  });

  it('--fail-on unrequested exits 2: without transcripts there is nothing to check intent against', () => {
    const r = cli(['-f', 'md', '-q', '--classify', '--fail-on', 'unrequested']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--fail-on unrequested: the intent check did not run (no agent transcripts');
  });
});

describe('why-diff pr', () => {
  const calls = (): { args: string[]; input: string }[] => {
    const f = path.join(stubDir, 'calls.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const env = () => ({ GH_STUB_DIR: stubDir });

  beforeEach(() => {
    rmSync(path.join(stubDir, 'calls.jsonl'), { force: true });
    writeFileSync(path.join(stubDir, 'body.md'), 'Fixes #3.\n\nSome notes.\n');
  });

  it('--dry-run prints the new body and makes no gh write', () => {
    const r = cli(['pr', '--dry-run', '-q'], env());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('Fixes #3.\n\nSome notes.\n\n<!-- why-diff:start -->\n## why-diff risk scan')).toBe(true);
    expect(r.stdout).toContain('src/b.js');
    expect(r.stdout).toContain('main...HEAD');
    expect(calls().map((c) => c.args.slice(0, 2).join(' '))).toEqual(['pr view']);
    expect(readFileSync(path.join(stubDir, 'body.md'), 'utf8')).toBe('Fixes #3.\n\nSome notes.\n');
  });

  it('edits the existing PR body via gh pr edit --body-file -, and replaces its own section on the next run', () => {
    const r = cli(['pr', '--base', 'main', '-q'], env());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const c = calls();
    expect(c.map((x) => x.args)).toEqual([['pr', 'view', '--json', 'body'], ['pr', 'edit', '--body-file', '-']]);
    const body = readFileSync(path.join(stubDir, 'body.md'), 'utf8');
    expect(body.startsWith('Fixes #3.\n\nSome notes.\n\n<!-- why-diff:start -->\n')).toBe(true);
    expect(body.trimEnd().endsWith('<!-- why-diff:end -->')).toBe(true);

    const again = cli(['pr', '--base', 'main', '-q'], env());
    expect(again.status).toBe(0);
    const body2 = readFileSync(path.join(stubDir, 'body.md'), 'utf8');
    expect(body2.match(/why-diff:start/g)).toHaveLength(1);
    expect(body2.startsWith('Fixes #3.\n\nSome notes.\n\n<!-- why-diff:start -->\n')).toBe(true);
  });

  it('never creates a PR: without one for the branch it exits 2', () => {
    const r = cli(['pr', '-q'], { ...env(), GH_STUB_NO_PR: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no pull request');
    expect(calls().map((c) => c.args[1])).toEqual(['view']);
  });

  it('shrinks the section to keep the body within the GitHub limit', () => {
    writeFileSync(path.join(stubDir, 'body.md'), 'x'.repeat(63_000) + '\n');
    const r = cli(['pr', '-q'], env());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const body = readFileSync(path.join(stubDir, 'body.md'), 'utf8');
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('<!-- why-diff:end -->');
  });

  it('exits 2 without editing when the description leaves no room for the section', () => {
    writeFileSync(path.join(stubDir, 'body.md'), 'x'.repeat(65_000));
    const r = cli(['pr', '-q'], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('65536');
    expect(calls().map((c) => c.args[1])).toEqual(['view']);
  });

  it('validates --harness and --since like the main command', () => {
    const h = cli(['pr', '--dry-run', '-q', '--harness', 'bogus'], env());
    expect(h.status).toBe(2);
    expect(h.stderr).toContain('unknown harness "bogus"');
    const d = cli(['pr', '--dry-run', '-q', '--since', 'yesterday'], env());
    expect(d.status).toBe(2);
    expect(d.stderr).toContain('invalid --since date');
  });

  it('--session uses an explicit transcript, giving a provenance section', () => {
    const elsewhere = realpathSync(tempDir('why-diff-pr-session-'));
    try {
      const now = Date.now();
      const file = writeSyntheticTranscript(elsewhere, repo, 'dddddddd-1111-4222-8333-444444444444', [
        { prompt: 'add b', at: new Date(now - 60_000).toISOString(), calls: [{ tool: 'Write', at: new Date(now - 50_000).toISOString(), input: { file_path: path.join(repo, 'src/b.js'), content: 'export const b = 1;\n' } }] },
      ]);
      const r = cli(['pr', '--dry-run', '-q', '--session', file], env());
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('<!-- why-diff:start -->\n## Provenance');
      expect(r.stdout).toContain('add b');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports a missing gh clearly', () => {
    // A bare PATH could still hold a real gh (CI runners ship one in /usr/bin), so point at a missing binary instead.
    const r = cli(['pr', '-q'], { WHY_DIFF_GH_BIN: path.join(stubDir, 'no-such-gh') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GitHub CLI');
  });
});
