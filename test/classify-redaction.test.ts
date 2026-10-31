/** End to end: the --classify input is redacted whatever the pipeline order. Fake `claude` binary, no real LLM. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../src/pipeline.js';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CLAUDE_STUB_LOG, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{}' }));
`;

let dir: string;
let repo: string;
let home: string;
let log: string;
let saved: Record<string, string | undefined>;

beforeAll(() => {
  dir = realpathSync(tempDir('why-diff-clsred-'));
  repo = path.join(dir, 'repo');
  home = path.join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, env: ENV, stdio: 'pipe' }); };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  const now = Date.now();
  writeSyntheticTranscript(home, repo, 'cls-red-1', [{
    prompt: `bump a, my key is ${SECRET}`,
    at: new Date(now - 60_000).toISOString(),
    calls: [{ tool: 'Edit', at: new Date(now - 50_000).toISOString(), text: `Using ${SECRET} to bump a`, input: { file_path: path.join(repo, 'a.js'), old_string: 'a = 1', new_string: 'a = 2' } }],
  }]);
  const bin = path.join(dir, 'claude');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  log = path.join(dir, 'calls.jsonl');
  saved = { WHY_DIFF_CLAUDE_BIN: process.env.WHY_DIFF_CLAUDE_BIN, CLAUDE_STUB_LOG: process.env.CLAUDE_STUB_LOG };
  process.env.WHY_DIFF_CLAUDE_BIN = bin;
  process.env.CLAUDE_STUB_LOG = log;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('--classify input', () => {
  it('never contains secrets from prompts or rationales', async () => {
    await buildReport({ cwd: repo, home, classify: 'claude-cli', workingTree: true }).catch(() => undefined);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; input: string });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.input).toContain('bump a');
      expect(c.input).not.toContain(SECRET);
      expect(c.args.join(' ')).not.toContain(SECRET);
    }
  });
});
