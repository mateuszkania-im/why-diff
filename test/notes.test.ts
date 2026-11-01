/** Provenance stored as git notes (refs/notes/why-diff): writing, reading back without transcripts, untrusted input. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../src/pipeline.js';
import { applyNotes, noteFromReport, parseNote, writeNote, MAX_NOTED_HUNKS, NOTE_MAX_BYTES, type ProvenanceNote } from '../src/notes.js';
import type { AttributedHunk } from '../src/types.js';
import { expectScalesSubQuadratically } from './helpers/perf.js';
import { tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input: '', env: { ...process.env, ...GIT_ENV } }).trim();
}
function gitIn(cwd: string, input: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, input, env: { ...process.env, ...GIT_ENV } });
}
function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}

const TEST_BASE = 'it("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n';

/** main: base commit; feat: one agent commit (a.js bump + it.skip) with a transcript in `home`. */
function makeRepo(): { repo: string; home: string; emptyHome: string } {
  const repo = temp('why-diff-notes-');
  const home = temp('why-diff-notes-home-');
  const emptyHome = temp('why-diff-notes-empty-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  mkdirSync(path.join(repo, 'src'));
  mkdirSync(path.join(repo, 'test'));
  writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(repo, 'test', 'a.test.js'), TEST_BASE);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'feat');
  const now = Date.now();
  const at = (s: number): string => new Date(now - s * 1000).toISOString();
  writeSyntheticTranscript(home, repo, 'dddddddd-1111-4222-8333-444444444444', [
    {
      prompt: `bump a to 2 (key ${SECRET})`,
      at: at(120),
      calls: [{ tool: 'Edit', at: at(110), input: { file_path: path.join(repo, 'src', 'a.js'), old_string: 'a = 1', new_string: 'a = 2' } }],
    },
    {
      prompt: 'skip the adds test for now',
      at: at(100),
      calls: [{ tool: 'Edit', at: at(90), input: { file_path: path.join(repo, 'test', 'a.test.js'), old_string: 'it("adds"', new_string: 'it.skip("adds"' } }],
    },
  ]);
  writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 2;\n');
  writeFileSync(path.join(repo, 'test', 'a.test.js'), TEST_BASE.replace('it("adds"', 'it.skip("adds"'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'agent work');
  return { repo, home, emptyHome };
}

const provenance = (repo: string, home: string) => buildReport({ cwd: repo, base: 'main', committedOnly: true, home, harnesses: ['claude-code'] });
const scan = (repo: string, home: string) => buildReport({ cwd: repo, base: 'main', committedOnly: true, home, harnesses: ['claude-code'] });

// `git notes add` makes a commit on the notes ref: it needs an identity (CI machines have none).
const savedEnv = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
beforeAll(() => {
  Object.assign(process.env, GIT_ENV);
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('noteFromReport', () => {
  it('keeps per hunk: file, new range, match, labels and the redacted prompt with its session', async () => {
    const { repo, home } = makeRepo();
    const note = noteFromReport(await provenance(repo, home));
    expect(note.whyDiffNote).toBe(1);
    const a = note.hunks.find((h) => h.file === 'src/a.js')!;
    expect(a).toMatchObject({ file: 'src/a.js', newStart: 1, newLines: 1, match: 'exact' });
    const p = note.prompts.find((x) => x.id === a.promptId)!;
    expect(p.text).toContain('bump a to 2');
    expect(p.text).not.toContain(SECRET);
    expect(p).toMatchObject({ sessionId: 'dddddddd-1111-4222-8333-444444444444', harness: 'claude-code' });
    const t = note.hunks.find((h) => h.file === 'test/a.test.js')!;
    expect(t.labels).toContain('test-skip-added');
  });
});

describe('reading notes in a risk scan', () => {
  let repo: string;
  let emptyHome: string;
  beforeAll(async () => {
    const r = makeRepo();
    repo = r.repo;
    emptyHome = r.emptyHome;
    await writeNote(repo, noteFromReport(await provenance(repo, r.home)));
    // a later human commit no note covers
    writeFileSync(path.join(repo, 'src', 'c.js'), 'export const c = 3;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'human');
  });

  it('stores the note on HEAD under refs/notes/why-diff', () => {
    const shown = git(repo, 'notes', '--ref=why-diff', 'show', 'HEAD~1');
    expect(parseNote(shown)?.hunks.length).toBeGreaterThan(0);
  });

  it('attaches noted prompts to overlapping hunks; mode is notes; other hunks stay risk-scan', async () => {
    const r = await scan(repo, emptyHome);
    expect(r.mode).toBe('notes');
    const a = r.hunks.find((h) => h.hunk.file === 'src/a.js')!;
    expect(a.source).toBe('notes');
    expect(a.prompt?.text).toContain('bump a to 2');
    expect(a.prompt?.text).not.toContain(SECRET);
    const c = r.hunks.find((h) => h.hunk.file === 'src/c.js')!;
    expect(c.source).toBeUndefined();
    expect(c.prompt).toBeUndefined();
    expect(c.labels.some((l) => l.kind === 'unattributed')).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(['dddddddd-1111-4222-8333-444444444444']);
  });

  it('computes labels from the diff, never from the note', async () => {
    const forged = parseNote(git(repo, 'notes', '--ref=why-diff', 'show', 'HEAD~1'))!;
    for (const h of forged.hunks) h.labels = [];
    gitIn(repo, JSON.stringify(forged), 'notes', '--ref=why-diff', 'add', '-f', '-F', '-', 'HEAD~1');
    const r = await scan(repo, emptyHome);
    const t = r.hunks.find((h) => h.hunk.file === 'test/a.test.js')!;
    expect(t.labels.map((l) => l.kind)).toContain('test-skip-added');
  });

  it('without notes the report is a plain risk scan', async () => {
    const { repo: bare, emptyHome: eh } = makeRepo();
    const r = await scan(bare, eh);
    expect(r.mode).toBe('risk-scan');
    expect(r.hunks.every((h) => !h.prompt && h.source === undefined)).toBe(true);
  });
});

describe('untrusted note content', () => {
  const valid = {
    whyDiffNote: 1,
    tool: '0.3.0',
    generatedAt: '2026-10-31T10:00:00.000Z',
    range: 'main...HEAD',
    prompts: [{ id: 's:0', sessionId: 's', harness: 'claude-code', index: 0, at: '2026-10-31T09:00:00.000Z', text: 'do it' }],
    hunks: [{ file: 'src/a.js', newStart: 1, newLines: 1, match: 'exact', coverage: 1, labels: [], promptId: 's:0' }],
  };

  it('accepts a well-formed note', () => {
    expect(parseNote(JSON.stringify(valid))?.hunks).toHaveLength(1);
  });

  it('rejects malformed JSON, wrong shapes and oversized text', () => {
    expect(parseNote('{nope')).toBeNull();
    expect(parseNote('[]')).toBeNull();
    expect(parseNote(JSON.stringify({ ...valid, whyDiffNote: 2 }))).toBeNull();
    expect(parseNote(JSON.stringify({ ...valid, hunks: 'x' }))).toBeNull();
    expect(parseNote('x'.repeat(NOTE_MAX_BYTES + 1))).toBeNull();
  });

  it('drops invalid hunks and prompts instead of trusting them', () => {
    const note = parseNote(JSON.stringify({
      ...valid,
      prompts: [...valid.prompts, { id: 'bad', sessionId: 5, harness: 'evil', index: 0, at: 'x', text: 'y' }],
      hunks: [
        ...valid.hunks,
        { file: 'b.js', newStart: -1, newLines: 1, match: 'exact', coverage: 1, labels: [] },
        { file: 'c.js', newStart: 1, newLines: 1, match: 'sure', coverage: 1, labels: [] },
        { file: 'd.js', newStart: 1, newLines: 1, match: 'exact', coverage: 7, labels: ['x'], promptId: 'missing' },
      ],
    }))!;
    expect(note.prompts.map((p) => p.id)).toEqual(['s:0']);
    expect(note.hunks.map((h) => h.file)).toEqual(['src/a.js', 'd.js']);
    const d = note.hunks[1]!;
    expect(d.coverage).toBe(1);
    expect(d.promptId).toBeUndefined();
    expect(d.labels).toEqual([]);
  });

  it('sanitises prompt text: secrets masked, control characters removed', () => {
    const note = parseNote(JSON.stringify({ ...valid, prompts: [{ ...valid.prompts[0], text: `run \u001b[31mred\u001b[0m with ${SECRET}` }] }))!;
    const text = note.prompts[0]!.text;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('\u001b');
  });

  it('ignores a note blob over 1 MB when reading', async () => {
    const { repo, emptyHome } = makeRepo();
    gitIn(repo, JSON.stringify({ ...valid, pad: 'x'.repeat(NOTE_MAX_BYTES) }), 'notes', '--ref=why-diff', 'add', '-f', '-F', '-', 'HEAD');
    const r = await scan(repo, emptyHome);
    expect(r.mode).toBe('risk-scan');
  });
});

describe('why-diff notes CLI', () => {
  function cli(cwd: string, home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, WHY_DIFF_CLAUDE_BIN: '/nonexistent/why-diff-test-claude', ...GIT_ENV },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('--dry-run prints the note JSON and writes nothing', () => {
    const { repo, home } = makeRepo();
    const r = cli(repo, home, ['notes', '--base', 'main', '--harness', 'claude-code', '--dry-run', '-q']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const note = parseNote(r.stdout);
    expect(note?.hunks.some((h) => h.file === 'src/a.js')).toBe(true);
    expect(spawnSync('git', ['notes', '--ref=why-diff', 'list'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('');
  });

  it('writes the note on HEAD and prints the push hint', () => {
    const { repo, home } = makeRepo();
    const r = cli(repo, home, ['notes', '--base', 'main', '--harness', 'claude-code', '-q']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git push origin refs/notes/why-diff');
    expect(parseNote(git(repo, 'notes', '--ref=why-diff', 'show', 'HEAD'))?.hunks.length).toBeGreaterThan(0);
  });

  it('says to set user.name / user.email when git has no identity for the notes commit', () => {
    const { repo, home } = makeRepo();
    const noIdentity: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, WHY_DIFF_CLAUDE_BIN: '/nonexistent/why-diff-test-claude', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'no-such-gitconfig'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
    for (const k of Object.keys(GIT_ENV)) delete noIdentity[k];
    for (const k of ['EMAIL', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2']) delete noIdentity[k];
    const r = spawnSync(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'cli.ts'), 'notes', '--base', 'main', '--harness', 'claude-code', '-q'], { cwd: repo, encoding: 'utf8', env: noIdentity });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('git config user.name');
    expect(r.stderr).toContain('git config user.email');
  });

  it('refuses when no transcripts are found (nothing to record)', () => {
    const { repo, emptyHome } = makeRepo();
    const r = cli(repo, emptyHome, ['notes', '--base', 'main', '-q']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no agent transcripts');
  });
});

describe('rendering a notes report', () => {
  it('markdown and terminal say the provenance came from git notes', async () => {
    const { renderReport } = await import('../src/report/index.js');
    const { repo, home, emptyHome } = makeRepo();
    await writeNote(repo, noteFromReport(await provenance(repo, home)));
    const r = await scan(repo, emptyHome);
    expect(r.mode).toBe('notes');
    expect(renderReport(r, 'md', {})).toContain('refs/notes/why-diff');
    expect(renderReport(r, 'terminal', {})).toContain('refs/notes/why-diff');
  });
});

describe('applyNotes cost (sec030 #11)', () => {
  const note = (n: number, offset = 1_000_000): ProvenanceNote => parseNote(JSON.stringify({
    whyDiffNote: 1, prompts: [], hunks: Array.from({ length: n }, (_, k) => ({ file: 'x.js', newStart: offset + k * 2, newLines: 1, match: 'none', labels: [] })),
  }))!;
  const diff = (n: number): AttributedHunk[] => Array.from({ length: n }, (_, k) => ({ hunk: { file: 'x.js', newStart: k * 10 + 1, newLines: 3 }, match: 'none', coverage: 0, labels: [], editIds: [], edits: [] }) as unknown as AttributedHunk);

  it('scales sub-quadratically with notes and diff hunks on one file', () => {
    const small = { notes: Array.from({ length: 10 }, () => note(500)), hunks: diff(500) };
    const large = { notes: Array.from({ length: 10 }, () => note(2000)), hunks: diff(2000) };
    expectScalesSubQuadratically(() => applyNotes(small.hunks, small.notes), () => applyNotes(large.hunks, large.notes));
  });

  it('50 notes of 13k hunks against 5k diff hunks stays well under a second', () => {
    const notes = Array.from({ length: 50 }, () => note(13_000));
    const t0 = performance.now();
    applyNotes(diff(5000), notes);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('keeps the first match in note order, and caps the noted hunks it reads', () => {
    const a = parseNote(JSON.stringify({ whyDiffNote: 1, prompts: [], hunks: [{ file: 'x.js', newStart: 1, newLines: 5, match: 'exact', coverage: 1, labels: [] }] }))!;
    const b = parseNote(JSON.stringify({ whyDiffNote: 1, prompts: [], hunks: [{ file: 'x.js', newStart: 2, newLines: 1, match: 'partial', coverage: 0.5, labels: [] }] }))!;
    expect(applyNotes(diff(1), [a, b]).hunks[0]!.match).toBe('exact');
    expect(applyNotes(diff(1), [b, a]).hunks[0]!.match).toBe('partial');
    const filler = Array.from({ length: Math.ceil(MAX_NOTED_HUNKS / 13_000) }, () => note(13_000));
    expect(applyNotes(diff(1), [...filler, a]).applied).toBe(0);
  });
});

