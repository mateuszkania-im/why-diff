/** End-to-end CLI behaviour: argument validation, pathspec, binary files, JSON shape. Never calls an LLM. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const NO_CLAUDE = '/nonexistent/why-diff-test-claude';
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
  // The node bin dir can hold a global `claude` (npm i -g); point the classifier at a missing binary so no LLM is ever reached.
  const env: NodeJS.ProcessEnv = { PATH: bareBin, HOME: home, GIT_CONFIG_NOSYSTEM: '1', WHY_DIFF_CLAUDE_BIN: NO_CLAUDE, ...GIT_ENV };
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
  it('--session pointing at a directory or a missing file gives a clear error, not a raw errno', () => {
    const dir = cli(['-q', '--format', 'json', '-s', repo]);
    expect(dir.status).toBe(2);
    expect(dir.stderr).toContain('is a directory');
    expect(dir.stderr).not.toContain('EISDIR');
    const missing = cli(['-q', '--format', 'json', '-s', path.join(repo, 'nope.jsonl')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('not found');
    expect(missing.stderr).not.toContain('ENOENT');
  });

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

  it('--fail-on unrequested exits 2 when no LLM backend is available instead of passing silently', () => {
    const r = cli(['-w', '-f', 'md', '-q', '--classify', '--fail-on', 'unrequested']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--fail-on unrequested: the intent check did not run (no LLM backend available');
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

describe('binary files', () => {
  it('counts changed binary files in summary.binaryFiles and shows them in md and terminal', () => {
    const rep = JSON.parse(cli(['-w', '-f', 'json', '-q']).stdout);
    expect(rep.summary.binaryFiles).toBe(1);
    expect(rep.summary.unattributedBinaryFiles).toBe(1);
    expect(cli(['-w', '-f', 'md', '-q']).stdout).toContain('| Binary files | 1, 1 with no agent edit |');
    expect(cli(['-w', '-q']).stdout).toContain('1 binary file');
  });

  it('--fail-on unattributed fails on a binary file no agent edit explains', () => {
    expect(cli(['-w', '-f', 'md', '-q', '--fail-on', 'unattributed', '--', 'src/a.js']).status).toBe(0);
    const r = cli(['-w', '-f', 'md', '-q', '--fail-on', 'unattributed', '--', 'src/a.js', 'logo.png']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('failing on unattributed');
  });

  it('a binary file an agent shell command wrote counts as explained', () => {
    writeFileSync(path.join(repo, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 0, 255]));
    const now = Date.now();
    writeSyntheticTranscript(home, repo, 'eeeeeeee-1111-4222-8333-444444444444', [
      { prompt: 'add the icon', at: new Date(now - 40_000).toISOString(), calls: [{ tool: 'Bash', at: new Date(now - 30_000).toISOString(), input: { command: `cp /tmp/icon.png ${path.join(repo, 'icon.png')}`, description: 'copy icon' } }] },
    ]);
    try {
      const r = cli(['-w', '-f', 'json', '-q', '--fail-on', 'unattributed', '--', 'src/a.js', 'icon.png']);
      expect(JSON.parse(r.stdout).summary.binaryFiles).toBe(1);
      expect(JSON.parse(r.stdout).summary.unattributedBinaryFiles).toBe(0);
      expect(r.status).toBe(0);
    } finally {
      rmSync(path.join(repo, 'icon.png'), { force: true });
    }
  });
});

describe('-o into .why-diff/', () => {
  it('creates .why-diff/.gitignore when absent and never overwrites an existing one', () => {
    const dir = path.join(repo, '.why-diff');
    try {
      expect(cli(['-w', '-f', 'md', '-q', '-o', '.why-diff/a.md']).status).toBe(0);
      expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
      writeFileSync(path.join(dir, '.gitignore'), '*\n!keep.md\n');
      expect(cli(['-w', '-f', 'md', '-q', '-o', '.why-diff/b.md']).status).toBe(0);
      expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n!keep.md\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('pathspec separator', () => {
  it('a literal -- given as an option value is not a pathspec separator', () => {
    const r = cli(['-w', '-m', '--', '-f', 'json', '-q']);
    expect(r.status).toBe(0);
    const files = JSON.parse(r.stdout).hunks.map((h: { hunk: { file: string } }) => h.hunk.file);
    expect(files).toContain('src/a.js');
    expect(files).toContain('docs/readme.md');
  });

  it('a real -- after an option value of -- still separates paths', () => {
    const r = cli(['-w', '-m', '--', '-f', 'json', '-q', '--', 'docs']);
    expect(r.status).toBe(0);
    const files = JSON.parse(r.stdout).hunks.map((h: { hunk: { file: string } }) => h.hunk.file);
    expect(files).toEqual(['docs/readme.md']);
  });

  it('--opt=value forms and clustered short options do not hide the separator', () => {
    const r = cli(['-w', '--model=x', '-qf', 'json', '--', 'src']);
    expect(r.status).toBe(0);
    const files = JSON.parse(r.stdout).hunks.map((h: { hunk: { file: string } }) => h.hunk.file);
    expect(files).toEqual(['src/a.js']);
  });
});

describe('positional arguments', () => {
  it('rejects an extra positional before -- instead of dropping it', () => {
    const r = cli(['HEAD~1', 'extra', '--', 'src/a.js']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('too many arguments');
  });
});
