/** End-to-end CLI behaviour: argument validation, pathspec, binary files, JSON shape. Never calls an LLM. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

let repo: string;
let home: string;
let bareBin: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  // PATH holds only node and git: no `claude`, so no LLM backend can ever be found.
  const env: NodeJS.ProcessEnv = { PATH: bareBin, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...GIT_ENV };
  const r = spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), ...args], { cwd: repo, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  bareBin = [path.dirname(process.execPath), path.dirname(gitPath)].join(path.delimiter);
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'why-diff-cli-')));
  home = realpathSync(tempDir('why-diff-cli-home-'));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, 'src'));
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(repo, 'docs/readme.md'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'second');
  writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 2;\n');
  writeFileSync(path.join(repo, 'docs/readme.md'), 'hello world\n');
  writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 255]));
  const now = Date.now();
  writeSyntheticTranscript(home, repo, 'cccccccc-1111-4222-8333-444444444444', [
    { prompt: 'bump a to 2', at: new Date(now - 60_000).toISOString(), calls: [{ tool: 'Edit', at: new Date(now - 50_000).toISOString(), input: { file_path: path.join(repo, 'src/a.js'), old_string: 'a = 1', new_string: 'a = 2', replace_all: false } }] },
  ]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('argument validation', () => {
  it('rejects an unknown --fail-on value', () => {
    const r = cli(['--fail-on', 'risks', '-q']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown --fail-on value "risks" (use risk, unrequested, tests, unattributed)');
  });

  it('--fail-on unrequested needs --classify', () => {
    const r = cli(['--fail-on', 'unrequested', '-q']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--fail-on unrequested needs --classify');
  });

  it('rejects an unparseable --since date', () => {
    const r = cli(['--since', 'yesterday', '-q']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid --since date');
  });

  it('--classify HEAD~1 treats HEAD~1 as the range', () => {
    const r = cli(['--classify', 'HEAD~1', '-f', 'json', '-q']);
    expect(r.stderr).not.toContain('unknown');
    expect(JSON.parse(r.stdout).range).toBe('HEAD~1');
  });

  it('--classify <bad> with an explicit range is an error', () => {
    const r = cli(['--classify', 'bogus', 'HEAD', '-q']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown --classify backend "bogus" (use auto, claude-cli, anthropic, openai)');
  });
});

describe('json output', () => {
  it('carries schemaVersion, a ~-relative session path and the repo basename', () => {
    const r = cli(['-w', '-f', 'json', '-q']);
    expect(r.status).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep.schemaVersion).toBe(1);
    expect(rep.repo.name).toBe(path.basename(repo));
    expect(rep.sessions.length).toBeGreaterThan(0);
    expect(rep.sessions[0].path.startsWith('~/')).toBe(true);
    expect(rep.sessions[0].path).not.toContain(home);
  });

  it('lists a changed binary file as an empty hunk', () => {
    const r = cli(['-w', '-f', 'json', '-q']);
    const rep = JSON.parse(r.stdout);
    const bin = rep.hunks.find((h: { hunk: { file: string } }) => h.hunk.file === 'logo.png');
    expect(bin).toBeTruthy();
    expect(bin.hunk.lines).toEqual([]);
    expect(bin.hunk.header).toBe('Binary file changed');
    const md = cli(['-w', '-f', 'md', '-q']);
    expect(md.stdout).toContain('logo.png');
  });
});

describe('pathspec after --', () => {
  it('limits hunks to the given paths', () => {
    const r = cli(['-w', '-f', 'json', '-q', '--', 'src']);
    expect(r.status).toBe(0);
    const files = JSON.parse(r.stdout).hunks.map((h: { hunk: { file: string } }) => h.hunk.file);
    expect(files).toEqual(['src/a.js']);
  });
});
