/**
 * Helpers for the synthetic Claude Code fixture under test/fixtures/claude.
 *
 * The checked-in transcripts use the placeholder cwd `/home/dev/acme-shop`.
 * `materialiseFixtureHome` copies them into a temporary home directory,
 * rewriting that placeholder (in file contents and in the encoded project
 * directory names) to a real repository path, so the same fixture drives both
 * the adapter unit tests and the end-to-end attribution test.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeProjectDir } from '../../src/adapters/claude.js';

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
export const FIXTURE_HOME = path.join(FIXTURE_DIR, 'home');
export const FIXTURE_REPO = path.join(FIXTURE_DIR, 'repo');
export const FIXTURE_CWD = '/home/dev/acme-shop';
export const FIXTURE_SESSION = '6f1d2c3b-9a8e-4f70-b1c2-d3e4f5a6b7c8';
export const FIXTURE_SUBDIR_SESSION = '0c3d4e5f-aaaa-4bbb-8ccc-ddddeeeeffff';

/**
 * A synthetic POSIX absolute path (`/work/repo/a.ts`) as the code under test spells it on this OS:
 * unchanged on POSIX, resolved onto the current drive on Windows (`D:\\work\\repo\\a.ts`).
 */
export function nat(p: string): string {
  return process.platform === 'win32' ? path.resolve(p) : p;
}

/** A path as a shell command on this OS would spell it: forward slashes (Git Bash on Windows takes `C:/x`, and `\\` is an escape). */
export function shellPath(p: string): string {
  return p.split(path.sep).join('/');
}

/** Fresh temp directory (realpath-resolved so macOS `/var` vs `/private/var` cannot bite). */
export function tempDir(prefix: string): string {
  // native: also expands Windows 8.3 short names (C:\\Users\\RUNNER~1), which git never prints.
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Copy the fixture home, re-pointing every transcript at `repoRoot`. Returns the new home. */
export function materialiseFixtureHome(repoRoot: string): string {
  const home = tempDir('why-diff-home-');
  const srcProjects = path.join(FIXTURE_HOME, '.claude', 'projects');
  const dstProjects = path.join(home, '.claude', 'projects');
  const oldPrefix = encodeProjectDir(FIXTURE_CWD);
  const newPrefix = encodeProjectDir(repoRoot);

  for (const dirName of readdirSync(srcProjects)) {
    const renamed = dirName.startsWith(oldPrefix) ? newPrefix + dirName.slice(oldPrefix.length) : dirName;
    // Forward slashes: JSON-safe as is, and what a shell command on Windows (Git Bash) would carry.
    copyTreeReplacing(path.join(srcProjects, dirName), path.join(dstProjects, renamed), FIXTURE_CWD, shellPath(repoRoot));
  }
  return home;
}

function copyTreeReplacing(src: string, dst: string, from: string, to: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTreeReplacing(s, d, from, to);
    } else if (/\.(jsonl|json)$/.test(entry.name)) {
      writeFileSync(d, readFileSync(s, 'utf8').split(from).join(to));
    } else {
      cpSync(s, d);
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic transcript builder (for scenario-specific regression tests)
// ---------------------------------------------------------------------------

export interface SyntheticCall {
  tool: 'Edit' | 'Write' | 'Bash';
  input: Record<string, unknown>;
  /** ISO timestamp of the tool call; the result is stamped one second later (or at `resultAt`). */
  at: string;
  /** ISO timestamp of the tool_result line (default: `at` + 1 s). */
  resultAt?: string;
  /** Assistant text emitted with the call (becomes the rationale). */
  text?: string;
  isError?: boolean;
  /** Explicit `toolUseResult` for the result line (default: a minimal one shaped like the real tool's). */
  result?: Record<string, unknown> | string;
}

export interface SyntheticTurn {
  prompt: string;
  at: string;
  calls: SyntheticCall[];
}

/**
 * Write a Claude Code transcript with the given human turns under
 * `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, mirroring the
 * real line shapes (origin/promptSource on prompts, tool_use blocks,
 * tool_result lines with `toolUseResult`). Returns the transcript path.
 */
export function writeSyntheticTranscript(home: string, cwd: string, sessionId: string, turns: SyntheticTurn[]): string {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const uuid = (): string => `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}`;
  let parent: string | null = null;
  const base = (type: string, timestamp: string): Record<string, unknown> => {
    const id = uuid();
    const line = { parentUuid: parent, isSidechain: false, type, uuid: id, timestamp, userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '2.1.310', gitBranch: 'main' };
    parent = id;
    return line;
  };
  const lines: Array<Record<string, unknown>> = [];
  turns.forEach((turn, t) => {
    const promptId = `turn-${t + 1}`;
    lines.push({ ...base('user', turn.at), promptId, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: turn.prompt } });
    turn.calls.forEach((call, c) => {
      const toolUseId = `toolu_${String(t + 1).padStart(2, '0')}${String(c + 1).padStart(2, '0')}${'x'.repeat(16)}`;
      const content: Array<Record<string, unknown>> = [];
      if (call.text) content.push({ type: 'text', text: call.text });
      content.push({ type: 'tool_use', id: toolUseId, name: call.tool, input: call.input });
      lines.push({ ...base('assistant', call.at), promptId, message: { model: 'claude-sonnet-4-5', id: `msg_${toolUseId}`, type: 'message', role: 'assistant', content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } } });
      const resultAt = call.resultAt ?? new Date(Date.parse(call.at) + 1000).toISOString();
      lines.push({
        ...base('user', resultAt),
        promptId,
        message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: call.isError ? '<tool_use_error>String to replace not found in file.</tool_use_error>' : 'ok', ...(call.isError ? { is_error: true } : {}) }] },
        toolUseResult: call.result ?? (call.isError ? 'Error: String to replace not found in file.' : toolUseResultFor(call)),
      });
    });
  });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

function toolUseResultFor(call: SyntheticCall): Record<string, unknown> {
  switch (call.tool) {
    case 'Edit':
      return { filePath: call.input.file_path, oldString: call.input.old_string, newString: call.input.new_string, originalFile: '', structuredPatch: [], userModified: false, replaceAll: false };
    case 'Write':
      return { type: 'create', filePath: call.input.file_path, content: call.input.content, structuredPatch: [], originalFile: null, userModified: false };
    case 'Bash':
      return { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  }
}

/** Parse the fixture transcript's JSON lines (for tests that need raw inputs such as file contents). */
export function fixtureLines(): Array<Record<string, unknown>> {
  const file = path.join(FIXTURE_HOME, '.claude', 'projects', encodeProjectDir(FIXTURE_CWD), `${FIXTURE_SESSION}.jsonl`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
