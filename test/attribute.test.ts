import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../src/adapters/claude.js';
import { attribute, repoRelativePath } from '../src/attribute.js';
import { labelHunks } from '../src/labels.js';
import { parseUnifiedDiff } from '../src/diff-parse.js';
import { commitTimes, currentBranch, getDiff, repoRoot, resolveDefaultTarget } from '../src/git.js';
import { buildReport } from '../src/pipeline.js';
import { summarize } from '../src/summary.js';
import type { AttributedHunk, FileEdit, Hunk, Prompt, Session } from '../src/types.js';
import { FIXTURE_REPO, materialiseFixtureHome, tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

// ---------------------------------------------------------------------------
// Builders for hand-made scenarios
// ---------------------------------------------------------------------------

const ROOT = '/work/repo';
let seq = 0;

function prompt(sessionId: string, index: number, text: string): Prompt {
  return { id: `${sessionId}:${index}`, sessionId, harness: 'claude-code', index, at: `2026-10-31T10:0${index}:00.000Z`, text };
}

function edit(sessionId: string, promptId: string, file: string, oldText: string | null, newText: string | null, extra: Partial<FileEdit> = {}): FileEdit {
  const n = ++seq;
  return {
    id: `${sessionId}:toolu_${n}:0`,
    sessionId,
    harness: 'claude-code',
    toolUseId: `toolu_${n}`,
    tool: extra.kind === 'bash' ? 'Bash' : newText !== null && oldText === null ? 'Write' : 'Edit',
    kind: extra.kind ?? (oldText === null ? 'write' : 'edit'),
    filePath: path.join(ROOT, file),
    at: `2026-10-31T10:00:${String(n).padStart(2, '0')}.000Z`,
    promptId,
    oldText,
    newText,
    ...extra,
  };
}

function session(id: string, prompts: Prompt[], edits: FileEdit[]): Session {
  return { id, harness: 'claude-code', cwd: ROOT, path: `/tmp/${id}.jsonl`, startedAt: '2026-10-31T10:00:00.000Z', endedAt: '2026-10-31T11:00:00.000Z', prompts, edits };
}

/** Build a hunk from `+`/`-`/` ` prefixed lines. */
function hunk(file: string, body: string[], opts: Partial<Hunk> = {}): Hunk {
  let oldNo = 1;
  let newNo = 1;
  const lines = body.map((l) => {
    const text = l.slice(1);
    if (l.startsWith('+')) return { type: 'add' as const, text, newNo: newNo++ };
    if (l.startsWith('-')) return { type: 'del' as const, text, oldNo: oldNo++ };
    return { type: 'ctx' as const, text, oldNo: oldNo++, newNo: newNo++ };
  });
  const oldLines = oldNo - 1;
  const newLines = newNo - 1;
  // Like git: a side with no lines is anchored at line 0.
  return { id: 'h1', file, status: 'modified', oldStart: oldLines ? 1 : 0, oldLines, newStart: newLines ? 1 : 0, newLines, header: `@@ -${oldLines ? 1 : 0},${oldLines} +${newLines ? 1 : 0},${newLines} @@`, lines, ...opts };
}

const texts = (h: AttributedHunk | undefined): string[] => (h?.hunk.lines ?? []).map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`);

const S = 'sess-1';
const P0 = prompt(S, 0, 'write the parser');
const P1 = prompt(S, 1, 'fix the typo');

// ---------------------------------------------------------------------------
// Unit scenarios
// ---------------------------------------------------------------------------

describe('attribute: matching rules', () => {
  it('credits a hunk fully explained by a Write to that edit and prompt', () => {
    const content = 'export function parse(input: string) {\n  return input.split("\\n");\n}\n';
    const s = session(S, [P0], [edit(S, P0.id, 'src/parse.ts', null, content)]);
    const [h] = attribute([hunk('src/parse.ts', ['+export function parse(input: string) {', '+  return input.split("\\n");', '+}'], { status: 'added' })], [s], ROOT);
    expect(h).toMatchObject({ match: 'exact', coverage: 1, labels: [] });
    expect(h?.prompt?.id).toBe(P0.id);
    expect(h?.edits.map((e) => e.tool)).toEqual(['Write']);
  });

  it('ignores trailing whitespace differences and failed edits', () => {
    const good = edit(S, P0.id, 'a.ts', 'old();', 'call();   ');
    const failed = edit(S, P1.id, 'a.ts', 'call();', 'other();', { failed: true });
    const s = session(S, [P0, P1], [good, failed]);
    const [h] = attribute([hunk('a.ts', ['-old();', '+call();'])], [s], ROOT);
    expect(h?.match).toBe('exact');
    expect(h?.prompt?.id).toBe(P0.id);
    expect(h?.edits).toHaveLength(1);
  });

  it('lets the latest edit win when the same line was introduced twice', () => {
    const first = edit(S, P0.id, 'a.ts', 'x = 1;', 'x = 2;');
    const second = edit(S, P1.id, 'a.ts', 'x = 3;', 'x = 2;'); // human changed it to 3, agent set 2 again
    const s = session(S, [P0, P1], [first, second]);
    const result = attribute([hunk('a.ts', ['-x = 1;', '+x = 2;'])], [s], ROOT);
    // Prompt 0 removed the old line; prompt 1 wrote the final one: two segments.
    expect(result.map((r) => [r.hunk.id, r.prompt?.id, r.edits.map((e) => e.id), texts(r)])).toEqual([
      ['h1.1', P0.id, [first.id], ['-x = 1;']],
      ['h1.2', P1.id, [second.id], ['+x = 2;']],
    ]);

    // A later edit that merely re-applies the identical text introduced nothing.
    const noop = edit(S, P1.id, 'b.ts', 'y = 2;', 'y = 2;');
    const [g] = attribute([hunk('b.ts', ['-y = 1;', '+y = 2;'])], [session(S, [P0, P1], [edit(S, P0.id, 'b.ts', 'y = 1;', 'y = 2;'), noop])], ROOT);
    expect(g?.prompt?.id).toBe(P0.id);
  });

  it('splits a hunk whose lines come from different prompts into one segment per prompt', () => {
    const big = edit(S, P0.id, 'a.ts', null, 'line one\nline two\nline three\nline four\n');
    const small = edit(S, P1.id, 'a.ts', 'line four', 'line FOUR');
    const s = session(S, [P0, P1], [big, small]);
    const result = attribute([hunk('a.ts', ['+line one', '+line two', '+line three', '+line FOUR'], { status: 'added' })], [s], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.id])).toEqual([
      ['h1.1', 'exact', 1, P0.id],
      ['h1.2', 'exact', 1, P1.id],
    ]);
    expect(texts(result[0])).toEqual(['+line one', '+line two', '+line three']);
    expect(texts(result[1])).toEqual(['+line FOUR']);
    expect(result[0]?.hunk.header).toBe('@@ -0,0 +1,3 @@');
    expect(result[1]?.hunk.header).toBe('@@ -0,0 +4 @@');
    expect(result[0]?.edits.map((e) => e.id)).toEqual([big.id]);
    expect(result[1]?.edits.map((e) => e.id)).toEqual([small.id]);
  });

  it('credits a line carried as unchanged context in a later edit to the edit that introduced it (bug 1)', () => {
    const blockA = edit(S, P0.id, 'a.ts', null, 'function a() {\n  return 1;\n}\n');
    // blockB's old_string/new_string both contain all of a(): it only introduced b().
    const blockB = edit(S, P1.id, 'a.ts', 'function a() {\n  return 1;\n}', 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}');
    const s = session(S, [P0, P1], [blockA, blockB]);
    const result = attribute([hunk('a.ts', ['+function a() {', '+  return 1;', '+}', '+', '+function b() {', '+  return 2;', '+}'], { status: 'added' })], [s], ROOT);
    expect(result.map((r) => [r.hunk.id, r.prompt?.id])).toEqual([
      ['h1.1', P0.id],
      ['h1.2', P1.id],
    ]);
    expect(texts(result[0])).toEqual(['+function a() {', '+  return 1;', '+}', '+']);
    expect(texts(result[1])).toEqual(['+function b() {', '+  return 2;', '+}']);
  });

  it('splits off lines the human added afterwards as an unattributed segment (bug 2)', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', null, 'alpha\nbeta\n')]);
    const result = attribute([hunk('a.ts', ['+alpha', '+beta', '+gamma', '+delta'], { status: 'added' })], [s], ROOT);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ match: 'exact', coverage: 1, labels: [] });
    expect(result[0]?.prompt?.id).toBe(P0.id);
    expect(result[1]).toMatchObject({ match: 'none', coverage: 0, edits: [] });
    expect(result[1]?.prompt).toBeUndefined();
    expect(result[1]?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['unattributed:warn']);
    expect(texts(result[1])).toEqual(['+gamma', '+delta']);
  });

  it('falls back to whitespace-insensitive matching after a formatter run, capped at partial', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', null, 'const a = {b:1, c:2};\nexport default a\n')]);
    const [h] = attribute([hunk('a.ts', ['+const a = { b: 1, c: 2 };', '+export default a;'], { status: 'added' })], [s], ROOT);
    expect(h?.match).toBe('partial');
    expect(h?.coverage).toBe(1);
    expect(h?.prompt?.id).toBe(P0.id);
  });

  it('explains pure deletions through the edit whose oldText contained the removed lines', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', 'function legacy() {\n  return 0;\n}\n', '')]);
    const [h] = attribute([hunk('a.ts', ['-function legacy() {', '-  return 0;', '-}'])], [s], ROOT);
    expect(h).toMatchObject({ match: 'exact', coverage: 1 });
    expect(h?.prompt?.id).toBe(P0.id);
  });

  it("explains a Write-update's deletions via the file's previous content", () => {
    const previous = 'old line 1\nold line 2\n';
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', previous, 'new line\n', { kind: 'write', tool: 'Write' })]);
    const [h] = attribute([hunk('a.ts', ['-old line 1', '-old line 2', '+new line'])], [s], ROOT);
    expect(h?.match).toBe('exact');
    expect(h?.coverage).toBe(1);
  });

  it('gives file-only + bash-edit when only a shell command touched the file', () => {
    const bash = edit(S, P1.id, 'package.json', null, null, { kind: 'bash', tool: 'Bash', command: "sed -i '' 's/1.0.0/1.1.0/' package.json" });
    const s = session(S, [P0, P1], [bash]);
    const [h] = attribute([hunk('package.json', ['-  "version": "1.0.0",', '+  "version": "1.1.0",'])], [s], ROOT);
    expect(h?.match).toBe('file-only');
    expect(h?.coverage).toBe(0);
    expect(h?.prompt?.id).toBe(P1.id);
    expect(h?.labels.map((l) => l.kind)).toEqual(['bash-edit']);
    expect(h?.labels[0]?.detail).toContain('sed -i');
  });

  it('matches bash edits on a directory or glob to files beneath it', () => {
    const fmt = edit(S, P0.id, 'src', null, null, { kind: 'bash', tool: 'Bash', command: 'npx prettier --write src' });
    const glob = edit(S, P1.id, 'lib/**/*.ts', null, null, { kind: 'bash', tool: 'Bash', command: 'perl -pi -e s/a/b/ lib/**/*.ts' });
    const s = session(S, [P0, P1], [fmt, glob]);
    const hunks = [
      hunk('src/deep/file.ts', ['+x']),
      hunk('lib/a/b.ts', ['+y']),
      hunk('docs/readme.md', ['+z']),
    ].map((h, i) => ({ ...h, id: `h${i + 1}` }));
    const result = attribute(hunks, [s], ROOT);
    expect(result.map((r) => r.match)).toEqual(['file-only', 'file-only', 'none']);
    expect(result[0]?.prompt?.id).toBe(P0.id);
    expect(result[1]?.prompt?.id).toBe(P1.id);
  });

  it('labels hunks nobody explains as unattributed', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'other.ts', null, 'unrelated\n')]);
    const [h] = attribute([hunk('README.md', ['+Written by a human'])], [s], ROOT);
    expect(h).toMatchObject({ match: 'none', coverage: 0, edits: [] });
    expect(h?.prompt).toBeUndefined();
    expect(h?.labels).toEqual([{ kind: 'unattributed', severity: 'warn', detail: expect.stringContaining('No agent edit') }]);
  });

  it('labels a touched file whose hunk text was not found as unattributed (info)', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', 'foo', 'bar')]);
    const [h] = attribute([hunk('a.ts', ['+completely different'])], [s], ROOT);
    expect(h?.match).toBe('file-only');
    expect(h?.labels[0]).toMatchObject({ kind: 'unattributed', severity: 'info' });
  });

  it('looks at the old path of a renamed file', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'src/old.ts', 'a', 'b')]);
    const [h] = attribute([hunk('src/new.ts', ['-a', '+b'], { oldFile: 'src/old.ts', status: 'renamed' })], [s], ROOT);
    expect(h?.match).toBe('exact');
  });

  it('lets trivial lines (blank, braces) inherit their neighbour instead of matching anything', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', null, 'if (x) {\n  go();\n}\n')]);
    const [h] = attribute([hunk('a.ts', ['+if (x) {', '+  go();', '+}', '+', '+}'], { status: 'added' })], [s], ROOT);
    // The dangling "}" at the end has an explained neighbour, so it is inherited too.
    expect(h?.coverage).toBe(1);
    const [lonely] = attribute([hunk('b.ts', ['+}'], { status: 'added' })], [session(S, [P0], [edit(S, P0.id, 'b.ts', null, '}\n')])], ROOT);
    expect(lonely?.match).toBe('file-only');
  });

  it('credits heredoc content written through bash as an exact bash-edit', () => {
    const bash = edit(S, P0.id, 'CHANGELOG.md', null, '# Changelog\n\n- first\n', { kind: 'bash', tool: 'Bash', command: "cat > CHANGELOG.md <<'EOF'\n# Changelog\n\n- first\nEOF" });
    const [h] = attribute([hunk('CHANGELOG.md', ['+# Changelog', '+', '+- first'], { status: 'added' })], [session(S, [P0], [bash])], ROOT);
    expect(h?.match).toBe('exact');
    expect(h?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['bash-edit:info']);
  });

  it('keeps hunk order and handles an empty mode-change hunk', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'run.sh', null, null, { kind: 'bash', tool: 'Bash', command: 'chmod +x run.sh' })]);
    const mode: Hunk = { id: 'h1', file: 'run.sh', status: 'modified', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, header: 'mode change 100644 => 100755', lines: [] };
    const [h] = attribute([mode], [s], ROOT);
    expect(h).toMatchObject({ match: 'file-only', coverage: 0 });
  });

  it('merges edits from several sessions, one segment per owning prompt', () => {
    const s1 = session('s1', [prompt('s1', 0, 'one')], [edit('s1', 's1:0', 'a.ts', null, 'from one\n')]);
    // s2 carried "from one" as context and introduced "from two".
    const s2 = session('s2', [prompt('s2', 0, 'two')], [edit('s2', 's2:0', 'a.ts', 'from one', 'from one\nfrom two')]);
    const result = attribute([hunk('a.ts', ['+from one', '+from two'], { status: 'added' })], [s1, s2], ROOT);
    expect(result.map((r) => [r.hunk.id, r.prompt?.id, r.edits.map((e) => e.sessionId)])).toEqual([
      ['h1.1', 's1:0', ['s1']],
      ['h1.2', 's2:0', ['s2']],
    ]);

    // The same line re-introduced by a later edit goes to that later edit.
    const s3 = session('s3', [prompt('s3', 0, 'three')], [edit('s3', 's3:0', 'b.ts', null, 'shared\n')]);
    const s4 = session('s4', [prompt('s4', 0, 'four')], [edit('s4', 's4:0', 'b.ts', 'other', 'shared')]);
    const [h] = attribute([hunk('b.ts', ['+shared'], { status: 'added' })], [s3, s4], ROOT);
    expect(h?.hunk.id).toBe('h1');
    expect(h?.prompt?.id).toBe('s4:0');
  });
});

describe('attribute: ownership and segment mechanics', () => {
  it('owns a deletion by the edit that removed the line, not by the neighbouring addition', () => {
    const remover = edit(S, P0.id, 'a.ts', 'gone();\nkeep();', 'keep();');
    const adder = edit(S, P1.id, 'a.ts', 'keep();', 'keep();\nadded();');
    const s = session(S, [P0, P1], [remover, adder]);
    const result = attribute([hunk('a.ts', [' before();', '-gone();', ' keep();', '+added();', ' after();'])], [s], ROOT);
    // Context never crosses another owner's changed line: segment 2 starts at keep().
    expect(result.map((r) => [r.hunk.id, r.prompt?.id, texts(r)])).toEqual([
      ['h1.1', P0.id, [' before();', '-gone();', ' keep();']],
      ['h1.2', P1.id, [' keep();', '+added();', ' after();']],
    ]);
  });

  it('recomputes ranges and headers for segments and keeps at most two context lines each', () => {
    const first = edit(S, P0.id, 'a.ts', 'old1', 'new1');
    const second = edit(S, P1.id, 'a.ts', 'old2', 'new2');
    const s = session(S, [P0, P1], [first, second]);
    const h = hunk('a.ts', [' c1', ' c2', ' c3', '-old1', '+new1', ' c4', ' c5', ' c6', ' c7', '-old2', '+new2', ' c8', ' c9', ' c10'], {
      header: '@@ -10,13 +10,13 @@ export function area()',
    });
    // Renumber from line 10 like a real mid-file hunk.
    for (const l of h.lines) {
      if (l.oldNo !== undefined) l.oldNo += 9;
      if (l.newNo !== undefined) l.newNo += 9;
    }
    const result = attribute([h], [s], ROOT);
    expect(result.map((r) => r.hunk.header)).toEqual(['@@ -11,5 +11,5 @@ export function area()', '@@ -16,5 +16,5 @@ export function area()']);
    expect(texts(result[0])).toEqual([' c2', ' c3', '-old1', '+new1', ' c4', ' c5']);
    expect(texts(result[1])).toEqual([' c6', ' c7', '-old2', '+new2', ' c8', ' c9']);
    expect(result[0]?.hunk).toMatchObject({ file: 'a.ts', status: 'modified', oldStart: 11, oldLines: 5, newStart: 11, newLines: 5 });
    expect(result[1]?.hunk).toMatchObject({ oldStart: 16, oldLines: 5, newStart: 16, newLines: 5 });
    // Context lines in the segment keep their original numbering.
    expect(result[1]?.hunk.lines[0]).toEqual({ type: 'ctx', text: 'c6', oldNo: 16, newNo: 16 });
    expect(result[1]?.hunk.lines[2]).toEqual({ type: 'del', text: 'old2', oldNo: 18 });
  });

  it('keeps same-owner changes separated by context inside one segment', () => {
    const e = edit(S, P0.id, 'a.ts', 'x1\nmid\nx2', 'y1\nmid\ny2');
    const human = [] as FileEdit[];
    const s = session(S, [P0], [e, ...human]);
    const result = attribute([hunk('a.ts', ['-x1', '+y1', ' mid', '-x2', '+y2', ' tail', '+human'])], [s], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, texts(r)])).toEqual([
      ['h1.1', 'exact', ['-x1', '+y1', ' mid', '-x2', '+y2', ' tail']],
      ['h1.2', 'none', [' tail', '+human']],
    ]);
  });

  it('keeps a hunk whole when a single prompt owns every changed line', () => {
    const a = edit(S, P0.id, 'a.ts', 'x', 'y');
    const b = edit(S, P0.id, 'a.ts', 'p', 'q');
    const [h, ...rest] = attribute([hunk('a.ts', ['-x', '+y', ' mid', '-p', '+q'])], [session(S, [P0], [a, b])], ROOT);
    expect(rest).toEqual([]);
    expect(h?.hunk.id).toBe('h1');
    expect(h?.edits.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('treats whole-file overwrites (heredoc, Write) as removing the lines they replaced', () => {
    const heredoc = edit(S, P0.id, 'notes.md', null, '# New\n', { kind: 'bash', tool: 'Bash', command: "cat > notes.md <<'EOF'\n# New\nEOF" });
    const [h] = attribute([hunk('notes.md', ['-# Old', '-old body', '+# New'])], [session(S, [P0], [heredoc])], ROOT);
    expect(h).toMatchObject({ match: 'exact', coverage: 1 });
    expect(h?.hunk.id).toBe('h1');
    expect(h?.labels.map((l) => l.kind)).toEqual(['bash-edit']);
  });

  it('reports unexplained lines in a file also touched by an opaque shell command as file-only, not human', () => {
    const typed = edit(S, P0.id, 'a.ts', null, 'from edit\n');
    const sed = edit(S, P1.id, 'a.ts', null, null, { kind: 'bash', tool: 'Bash', command: "sed -i '' 's/foo/bar/' a.ts" });
    const result = attribute([hunk('a.ts', ['+from edit', '+bar'], { status: 'added' })], [session(S, [P0, P1], [typed, sed])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.prompt?.id, r.labels.map((l) => l.kind)])).toEqual([
      ['h1.1', 'exact', P0.id, []],
      ['h1.2', 'file-only', P1.id, ['bash-edit']],
    ]);
  });

  it('keeps summary counts exact after splitting', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', 'old', 'alpha\nbeta')]);
    const result = attribute([hunk('a.ts', [' ctx', '-old', '+alpha', '+beta', '+gamma'])], [s], ROOT);
    const summary = summarize(result, [s]);
    expect(summary).toMatchObject({ hunks: 2, files: 1, addedLines: 3, removedLines: 1, agentLines: 2, unattributedLines: 1, labels: { unattributed: 1 } });
  });
});

describe('attribute: segment merging', () => {
  const written = 'one\ntwo\nthree\nfour\n';

  it('folds a gap of fewer than 3 unexplained lines between runs of one owner into a partial hunk with an info label', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', 'old', written)]);
    const result = attribute([hunk('a.ts', ['-old', '+one', '+two', '+human', '+three', '+four'])], [s], ROOT);
    expect(result).toHaveLength(1);
    const [h] = result;
    expect(h?.hunk.id).toBe('h1');
    expect(h?.prompt?.id).toBe(P0.id);
    expect(h?.match).toBe('partial');
    expect(h?.coverage).toBeCloseTo(4 / 5);
    expect(h?.labels).toEqual([{ kind: 'unattributed', severity: 'info', detail: expect.stringContaining('1 of 6 changed lines (L3) match no agent edit') }]);
    expect(summarize(result, [s])).toMatchObject({ addedLines: 5, agentLines: 4, unattributedLines: 1 });
  });

  it('keeps an unexplained run of 3 or more lines as its own segment', () => {
    const s = session(S, [P0], [edit(S, P0.id, 'a.ts', 'old', written)]);
    const result = attribute([hunk('a.ts', ['-old', '+one', '+two', '+h1', '+h2', '+h3', '+three', '+four'])], [s], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.prompt?.id ?? null, texts(r).filter((l) => !l.startsWith(' '))])).toEqual([
      ['h1.1', 'exact', P0.id, ['-old', '+one', '+two']],
      ['h1.2', 'none', null, ['+h1', '+h2', '+h3']],
      ['h1.3', 'exact', P0.id, ['+three', '+four']],
    ]);
    expect(result[1]?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['unattributed:warn']);
  });

  it('folds a short run of another prompt between runs of one owner, keeping its edit listed', () => {
    const big = edit(S, P0.id, 'a.ts', 'old', written);
    const small = edit(S, P1.id, 'a.ts', 'two', 'TWO');
    const result = attribute([hunk('a.ts', ['-old', '+one', '+TWO', '+three', '+four'])], [session(S, [P0, P1], [big, small])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.prompt?.id, r.match, r.coverage])).toEqual([['h1', P0.id, 'exact', 1]]);
    expect(result[0]?.editIds).toEqual([big.id, small.id]);
    // three lines of the other prompt are a block of their own
    const bigger = edit(S, P1.id, 'a.ts', 'two', 'TWO\nTWO-b\nTWO-c');
    const split = attribute([hunk('a.ts', ['-old', '+one', '+TWO', '+TWO-b', '+TWO-c', '+three', '+four'])], [session(S, [P0, P1], [big, bigger])], ROOT);
    expect(split.map((r) => [r.hunk.id, r.prompt?.id])).toEqual([
      ['h1.1', P0.id],
      ['h1.2', P1.id],
      ['h1.3', P0.id],
    ]);
  });

  it('does not let one or two incidental matches inside human work create agent segments', () => {
    // A new test file written by something unrecorded; two lines happen to equal lines of an agent edit elsewhere in the file.
    const agent = edit(S, P0.id, 'x.test.ts', null, "import { test } from 'vitest';\nconst url = '/api';\n");
    const body = ['+human 1', '+human 2', '+human 3', '+human 4', "+import { test } from 'vitest';", '+human 5', '+human 6', '+human 7', "+const url = '/api';", '+human 8', '+human 9', '+human 10'];
    const result = attribute([hunk('x.test.ts', body, { status: 'added' })], [session(S, [P0], [agent])], ROOT);
    expect(result).toHaveLength(1);
    const [h] = result;
    expect(h?.prompt).toBeUndefined();
    expect(h?.match).toBe('partial');
    expect(h?.coverage).toBeCloseTo(2 / 12);
    expect(h?.editIds).toEqual([agent.id]);
    expect(h?.labels).toEqual([{ kind: 'unattributed', severity: 'warn', detail: expect.stringContaining('10 of 12 changed lines match no agent edit (human edit or unrecorded tool)') }]);
    // such a segment is not "agent work" for the labels module either
    const [labelled] = labelHunks(result, { prompts: [P0], repoRoot: ROOT });
    expect(labelled?.labels.find((l) => l.kind === 'test-modified')).toMatchObject({ severity: 'info' });
  });

  it('collapses a hunk that would shatter into many tiny alternating segments into one hunk owned by the majority', () => {
    // Prompt 1 edited some lines; prompt 0 ran a script that reshaped the rest. Owners alternate every 3-4 lines.
    const script = edit(S, P0.id, 'r.mjs', null, null, { kind: 'bash', tool: 'Bash', command: 'node scripts/reshape.mjs r.mjs' });
    const body: string[] = [];
    const typedLines: string[] = [];
    for (let block = 0; block < 10; block++) {
      for (let k = 0; k < 3; k++) {
        const l = `typed ${block}-${k};`;
        typedLines.push(l);
        body.push(`+${l}`);
      }
      for (let k = 0; k < 4; k++) body.push(`+reshaped ${block}-${k};`);
    }
    const typed = edit(S, P1.id, 'r.mjs', 'old', typedLines.join('\n'));
    const result = attribute([hunk('r.mjs', ['-old', ...body])], [session(S, [P0, P1], [script, typed])], ROOT);
    expect(result).toHaveLength(1);
    const [h] = result;
    expect(h?.hunk.id).toBe('h1');
    expect(h?.prompt?.id).toBe(P0.id); // 40 lines via the script vs 31 typed
    expect(h?.match).toBe('partial');
    expect(h?.coverage).toBeCloseTo(30 / 70);
    expect(h?.editIds).toEqual([script.id, typed.id]);
    expect(h?.labels).toEqual([{ kind: 'bash-edit', severity: 'info', detail: expect.stringContaining('40 of 71 changed lines match no recorded edit; the file was also touched by a shell command (node scripts/reshape.mjs r.mjs)') }]);
  });

  it('keeps a new file dominated by one prompt whole, carving out only unexplained runs of 3+ lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1).padStart(2, '0')};`);
    const write = edit(S, P0.id, 'new.ts', null, `${lines.join('\n')}\n`);
    const tweak = edit(S, P1.id, 'new.ts', 'line 10;', 'line 10; // tweaked');
    const body = lines.map((l) => `+${l === 'line 10;' ? 'line 10; // tweaked' : l}`);
    body.splice(5, 0, '+human();'); // one unexplained line inside: absorbed
    body.push('+human1();', '+human2();', '+human3();'); // three at the end: carved out
    const result = attribute([hunk('new.ts', body, { status: 'added' })], [session(S, [P0, P1], [write, tweak])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.prompt?.id ?? null, r.hunk.lines.length])).toEqual([
      ['h1.1', 'partial', P0.id, 51],
      ['h1.2', 'none', null, 3],
    ]);
    const main = result[0];
    expect(main?.editIds).toEqual([write.id, tweak.id]); // the minor owner's edit is still listed
    expect(main?.coverage).toBeCloseTo(50 / 51);
    expect(main?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['unattributed:info']);
    expect(result[1]?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['unattributed:warn']);
  });

  it('still splits a new file by prompt when no owner dominates', () => {
    const a = edit(S, P0.id, 'new.ts', null, 'a1\na2\na3\n');
    const b = edit(S, P1.id, 'new.ts', 'a3', 'a3\nb1\nb2');
    const result = attribute([hunk('new.ts', ['+a1', '+a2', '+a3', '+b1', '+b2'], { status: 'added' })], [session(S, [P0, P1], [a, b])], ROOT);
    expect(result.map((r) => r.prompt?.id)).toEqual([P0.id, P1.id]);
  });

  it('does not split a run when the unexplained lines resolve to the same prompt through an opaque shell command', () => {
    const typed = edit(S, P0.id, 'a.ts', 'old', written);
    const fmt = edit(S, P0.id, 'a.ts', null, null, { kind: 'bash', tool: 'Bash', command: 'npx prettier --write a.ts' });
    const result = attribute([hunk('a.ts', ['-old', '+one', '+two', '+formatted', '+three', '+four'])], [session(S, [P0], [typed, fmt])], ROOT);
    expect(result).toHaveLength(1);
    const [h] = result;
    expect(h?.hunk.id).toBe('h1');
    expect(h?.match).toBe('partial');
    expect(h?.prompt?.id).toBe(P0.id);
    expect(h?.editIds).toEqual([typed.id, fmt.id]);
    expect(h?.labels).toEqual([{ kind: 'bash-edit', severity: 'info', detail: expect.stringContaining('1 of 6 changed lines match no recorded edit; the file was also touched by a shell command (npx prettier --write a.ts)') }]);
  });

  it('lists at most the 8 most recent edits for a file-only match', () => {
    const seds = Array.from({ length: 10 }, (_, i) =>
      edit(S, P0.id, 'a.ts', null, null, { kind: 'bash', tool: 'Bash', command: `sed -i '' 's/v${i}/v${i + 1}/' a.ts`, at: `2026-10-31T11:${String(i).padStart(2, '0')}:00.000Z` }));
    const [h] = attribute([hunk('a.ts', ['-v0', '+v10'])], [session(S, [P0], seds)], ROOT);
    expect(h?.match).toBe('file-only');
    expect(h?.editIds).toEqual(seds.slice(-8).map((e) => e.id));
    expect(h?.edits.map((e) => e.id)).toEqual(h?.editIds);
    expect(h?.labels[0]?.detail).toContain('v9/v10');
  });

  it('carries text-free edit refs alongside editIds', () => {
    const e = edit(S, P0.id, 'a.ts', null, written, { command: 'x'.repeat(1000), rationale: 'because' });
    const [h] = attribute([hunk('a.ts', ['+one', '+two', '+three', '+four'], { status: 'added' })], [session(S, [P0], [e])], ROOT);
    expect(h?.editIds).toEqual([e.id]);
    expect(h?.edits[0]).not.toHaveProperty('oldText');
    expect(h?.edits[0]).not.toHaveProperty('newText');
    expect(h?.edits[0]).not.toHaveProperty('command');
    expect(h?.edits[0]).toMatchObject({ id: e.id, tool: 'Write', kind: 'write', at: e.at, promptId: P0.id, rationale: 'because' });
  });
});

describe('attribute: wording for lines no edit explains', () => {
  const script = (promptId: string, command: string, at?: string): FileEdit =>
    edit(S, promptId, 'scripts/out.log', null, null, { kind: 'bash', tool: 'Bash', command, ...(at ? { at } : {}) });

  it('is informational when a shell command in the window named the file, in a split segment and in a whole hunk', () => {
    const typed = edit(S, P0.id, 'src/a.ts', null, 'x\n');
    const s = session(S, [P0], [typed, script(P0.id, 'node scripts/fix.mjs src/a.ts src/b.ts > scripts/out.log')]);
    const [, seg] = attribute([hunk('src/a.ts', ['+x', '+y1', '+y2', '+y3'], { status: 'added' })], [s], ROOT);
    expect(seg?.match).toBe('none');
    expect(seg?.labels).toEqual([{ kind: 'unattributed', severity: 'info', detail: 'Not traced to a specific edit (the file was also changed by agent shell commands).' }]);
    const [whole] = attribute([hunk('src/b.ts', ['-p', '+q'])], [s], ROOT);
    expect(whole?.match).toBe('none');
    expect(whole?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['unattributed:info']);
  });

  it('warns about a human edit or unrecorded tool when no shell command touched the file', () => {
    const typed = edit(S, P0.id, 'src/a.ts', null, 'x\n');
    const s = session(S, [P0], [typed, script(P0.id, 'node scripts/fix.mjs src/other.ts vendor/src/a.ts src/a.ts.bak')]);
    const [, seg] = attribute([hunk('src/a.ts', ['+x', '+y1', '+y2', '+y3'], { status: 'added' })], [s], ROOT);
    expect(seg?.labels).toEqual([{ kind: 'unattributed', severity: 'warn', detail: expect.stringContaining('human edit or unrecorded tool') }]);
    const [whole] = attribute([hunk('src/c.ts', ['-p', '+q'])], [s], ROOT);
    expect(whole?.labels).toEqual([{ kind: 'unattributed', severity: 'warn', detail: 'No agent edit in the analysed sessions explains this hunk.' }]);
  });

  it('matches the file by absolute path or ./ prefix, but ignores shell commands older than the window', () => {
    const s = session(S, [P0], [script(P0.id, `python3 fix.py ${ROOT}/src/a.ts`), script(P0.id, 'prettier --write ./src/b.ts')]);
    expect(attribute([hunk('src/a.ts', ['+q'])], [s], ROOT)[0]?.labels[0]?.severity).toBe('info');
    expect(attribute([hunk('src/b.ts', ['+q'])], [s], ROOT)[0]?.labels[0]?.severity).toBe('info');
    const old = session(S, [P0], [script(P0.id, 'node fix.mjs src/a.ts', '2026-10-01T10:00:00.000Z')]);
    expect(attribute([hunk('src/a.ts', ['+q'])], [old], ROOT, { since: new Date('2026-10-05T00:00:00.000Z') })[0]?.labels[0]?.severity).toBe('warn');
  });
});

describe('attribute: time window', () => {
  it('does not use edits older than the window for file-only matches, but still for content matches', () => {
    const old = edit(S, P0.id, 'gen/report.json', null, null, { kind: 'bash', tool: 'Bash', command: 'node gen.js > gen/report.json', at: '2026-10-01T10:00:00.000Z' });
    const wrote = edit(S, P0.id, 'src/a.ts', null, 'written long ago\n', { at: '2026-10-01T10:00:00.000Z' });
    const s = session(S, [P0], [old, wrote]);
    const since = new Date('2026-10-05T00:00:00.000Z');
    const [h] = attribute([hunk('gen/report.json', ['-"a": 1', '+"a": 2'])], [s], ROOT, { since });
    expect(h?.match).toBe('none');
    expect(attribute([hunk('gen/report.json', ['-"a": 1', '+"a": 2'])], [s], ROOT)[0]?.match).toBe('file-only');
    const [c] = attribute([hunk('src/a.ts', ['+written long ago'], { status: 'added' })], [s], ROOT, { since });
    expect(c?.match).toBe('exact');
  });
});

describe('attribute: edits made in other worktrees of the repo', () => {
  const at = (file: string, sessionId = S, promptId = P0.id): FileEdit => ({ ...edit(sessionId, promptId, 'x', null, 'export const a = 1;\nexport const b = 2;\n'), filePath: file });

  it('maps an edit in an out-of-repo worktree onto the repo path of the same file', () => {
    const wt = '/tmp/scratch/wt-a54';
    const s = session(S, [P0], [at(`${wt}/src/lib/a.ts`), { ...at(`${wt}/README.md`), newText: 'readme line\n' }]);
    const [h1, h2] = attribute([
      hunk('src/lib/a.ts', ['+export const a = 1;', '+export const b = 2;'], { status: 'added' }),
      { ...hunk('README.md', ['+readme line'], { status: 'added' }), id: 'h2' },
    ], [s], ROOT);
    expect(h1?.match).toBe('exact');
    expect(h1?.prompt?.id).toBe(P0.id);
    // A top-level file alone does not establish a worktree, but it is remapped once a nested file did.
    expect(h2?.match).toBe('exact');
  });

  it('maps edits inside a nested .claude/worktrees/<name>/ checkout', () => {
    const s = session(S, [P0], [at(`${ROOT}/.claude/worktrees/agent-1/src/lib/a.ts`)]);
    const [h] = attribute([hunk('src/lib/a.ts', ['+export const a = 1;'], { status: 'added' })], [s], ROOT);
    expect(h?.match).toBe('exact');
  });

  it('does not treat another project as a worktree because of a shared top-level file name', () => {
    const s = session(S, [P0], [{ ...at('/elsewhere/project/package.json'), newText: '{ "name": "x" }\n' }]);
    const [h] = attribute([hunk('package.json', ['+{ "name": "x" }'], { status: 'added' })], [s], ROOT);
    expect(h?.match).toBe('none');
  });
});

describe('repoRelativePath', () => {
  it('relativises absolute paths under the root and rejects outsiders', () => {
    expect(repoRelativePath('/work/repo/src/a.ts', ['/work/repo'])).toBe('src/a.ts');
    expect(repoRelativePath('/work/repo', ['/work/repo'])).toBe('');
    expect(repoRelativePath('/work/repo-2/src/a.ts', ['/work/repo'])).toBeNull();
    expect(repoRelativePath('src/a.ts', ['/work/repo'], '/work/repo/sub')).toBe('sub/src/a.ts');
  });
});

describe('summarize', () => {
  it('aggregates lines, labels, prompts and intent verdicts', () => {
    const s = session(S, [P0, P1], []);
    const hunks: AttributedHunk[] = [
      { hunk: hunk('a.ts', ['+x', '+y', '-z']), match: 'exact', coverage: 1, editIds: [], edits: [], labels: [{ kind: 'test-modified', severity: 'warn', detail: '' }], intent: { verdict: 'requested', reason: '', model: 'm' } },
      { hunk: { ...hunk('b.ts', ['+p', '+q']), id: 'h2' }, match: 'partial', coverage: 0.5, editIds: [], edits: [], labels: [{ kind: 'unattributed', severity: 'info', detail: '' }] },
      { hunk: { ...hunk('a.ts', ['-gone']), id: 'h3' }, match: 'none', coverage: 0, editIds: [], edits: [], labels: [{ kind: 'unattributed', severity: 'warn', detail: '' }] },
    ];
    expect(summarize(hunks, [s])).toEqual({
      hunks: 3,
      files: 2,
      addedLines: 4,
      removedLines: 2,
      agentLines: 3,
      unattributedLines: 1,
      intent: { requested: 1, implied: 0, unrequested: 0, unclear: 0 },
      labels: { 'test-modified': 1, unattributed: 2 },
      touchedTests: true,
      sessions: 0,
      sessionsFound: 1,
      prompts: 0,
    });
    expect(summarize([], []).intent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End to end: real git repo + fixture transcript
// ---------------------------------------------------------------------------

describe('end to end: git diff -> hunks -> Claude sessions -> attribution', () => {
  let repo: string;
  let home: string;
  let result: AttributedHunk[];
  let sessions: Session[];

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const read = (rel: string): string => readFileSync(path.join(repo, rel), 'utf8');
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content);
  };
  const byFile = (file: string): AttributedHunk[] => result.filter((r) => r.hunk.file === file);

  beforeAll(async () => {
    repo = tempDir('why-diff-e2e-');
    cpSync(FIXTURE_REPO, repo, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'base', '--date', '2026-10-31T09:00:00Z');
    repo = await repoRoot(repo); // realpath form, as the CLI would see it

    home = materialiseFixtureHome(repo);
    const adapter = new ClaudeCodeAdapter();
    const paths = await adapter.discover(repo, { home });
    sessions = await Promise.all(paths.map((p) => adapter.parse(p)));
    const main = sessions.find((s) => s.edits.length > 1)!;

    // Replay the agent's edits on disk, in transcript order.
    const byTool = (id: string): FileEdit[] => main.edits.filter((e) => e.toolUseId === id);
    write('src/format.ts', byTool('toolu_01WriteFormat000000001')[0]!.newText!);
    let cart = read('src/cart.ts');
    for (const e of [...byTool('toolu_02EditCart0000000000002'), ...byTool('toolu_03MultiCart000000000003')]) {
      expect(cart).toContain(e.oldText!);
      cart = cart.replace(e.oldText!, () => e.newText!);
    }
    write('src/cart.ts', cart);
    write('package.json', read('package.json').replace('"version": "1.0.0"', '"version": "1.1.0"')); // the sed one-liner
    rmSync(path.join(repo, 'src/legacy.ts')); // rm src/legacy.ts
    write('CHANGELOG.md', byTool('toolu_07BashHeredoc0000000007')[0]!.newText!); // heredoc
    write('test/format.test.ts', byTool('toolu_S1WriteTest0000000000001')[0]!.newText!); // subagent
    // ...and the human adds a line nobody asked for.
    write('README.md', `${read('README.md')}Manually edited by a human.\n`);

    const diff = await getDiff(repo, { workingTree: true, includeUntracked: true });
    const hunks = parseUnifiedDiff(diff);
    result = attribute(hunks, sessions, repo);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('diffs staged, unstaged and untracked changes without touching the index', () => {
    expect(result.map((r) => r.hunk.file).sort()).toEqual(['CHANGELOG.md', 'README.md', 'package.json', 'src/cart.ts', 'src/format.ts', 'src/legacy.ts', 'test/format.test.ts'].sort());
    expect(byFile('src/format.ts')[0]?.hunk.status).toBe('added');
    expect(byFile('src/legacy.ts')[0]?.hunk.status).toBe('deleted');
    expect(git('status', '--porcelain').split('\n').filter((l) => l.startsWith('A '))).toEqual([]); // nothing staged
  });

  it('attributes agent-written files exactly, to the right prompt and tool', () => {
    const [format] = byFile('src/format.ts');
    expect(format).toMatchObject({ match: 'exact', coverage: 1, labels: [] });
    expect(format?.prompt?.index).toBe(0);
    expect(format?.edits.map((e) => e.tool)).toEqual(['Write']);

    for (const cartHunk of byFile('src/cart.ts')) {
      expect(cartHunk.match).toBe('exact');
      expect(cartHunk.prompt?.index).toBe(0);
      expect(cartHunk.edits.every((e) => ['Edit', 'MultiEdit'].includes(e.tool))).toBe(true);
    }
    expect(byFile('src/cart.ts').flatMap((h) => h.edits).some((e) => e.failed)).toBe(false);
  });

  it('attributes the subagent-written test to the prompt that launched the Agent', () => {
    const [test] = byFile('test/format.test.ts');
    expect(test).toMatchObject({ match: 'exact', coverage: 1 });
    expect(test?.prompt?.index).toBe(0);
    expect(test?.edits[0]?.toolUseId).toBe('toolu_S1WriteTest0000000000001');
  });

  it('attributes shell mutations as file-only bash edits with their prompt', () => {
    const [pkg] = byFile('package.json');
    expect(pkg).toMatchObject({ match: 'file-only', coverage: 0 });
    expect(pkg?.prompt?.index).toBe(1);
    expect(pkg?.labels.map((l) => l.kind)).toEqual(['bash-edit']);

    const [legacy] = byFile('src/legacy.ts');
    expect(legacy).toMatchObject({ match: 'file-only' });
    expect(legacy?.prompt?.index).toBe(1);
    const legacyEdit = sessions.flatMap((x) => x.edits).find((e) => e.id === legacy?.editIds[0]);
    expect(legacyEdit?.command).toContain('rm src/legacy.ts');
    expect(legacy?.edits[0]).not.toHaveProperty('command'); // refs are text-free; the command lives in report.edits

    const [changelog] = byFile('CHANGELOG.md');
    expect(changelog).toMatchObject({ match: 'exact', coverage: 1 });
    expect(changelog?.prompt?.index).toBe(2);
    expect(changelog?.labels.map((l) => `${l.kind}:${l.severity}`)).toEqual(['bash-edit:info']);
  });

  it('flags the human edit as unattributed', () => {
    const [readme] = byFile('README.md');
    expect(readme).toMatchObject({ match: 'none', coverage: 0, edits: [] });
    expect(readme?.prompt).toBeUndefined();
    expect(readme?.labels.map((l) => l.kind)).toEqual(['unattributed']);
  });

  it('summarises the report header', () => {
    const summary = summarize(result, sessions);
    expect(summary.hunks).toBe(result.length);
    expect(summary.files).toBe(7);
    // Two sessions were parsed, but only the main one contributed edits; the sub-directory session is read-only.
    expect(summary.sessionsFound).toBe(2);
    expect(summary.sessions).toBe(1);
    // Prompts are counted only when they own a hunk, not every prompt typed in the window.
    const owning = new Set(result.map((r) => r.prompt?.id).filter(Boolean));
    expect(summary.prompts).toBe(owning.size);
    expect(summary.prompts).toBeLessThan(sessions.reduce((n, s) => n + s.prompts.length, 0));
    // README (1 human line) + package.json (1 line, bash, text unknown) stay unattributed.
    expect(summary.unattributedLines).toBe(2);
    expect(summary.agentLines).toBe(summary.addedLines - 2);
    expect(summary.labels).toEqual({ unattributed: 1, 'bash-edit': 3 });
    expect(summary.touchedTests).toBe(false);
  });

  it('builds a compact report: an edits table, text-free refs and contributing sessions only', async () => {
    const report = await buildReport({ cwd: repo, workingTree: true, home, harnesses: ['claude-code'] });
    const ids = new Set(report.hunks.flatMap((h) => h.editIds));
    expect(ids.size).toBeGreaterThan(3);
    for (const id of ids) expect(report.edits[id]?.id).toBe(id);
    expect(Object.keys(report.edits)).toHaveLength(ids.size);
    for (const h of report.hunks) {
      expect(h.edits.map((e) => e.id)).toEqual(h.editIds);
      for (const e of h.edits) {
        expect(e).not.toHaveProperty('oldText');
        expect(e).not.toHaveProperty('newText');
      }
    }
    expect(report.summary.sessionsFound).toBe(2);
    expect(report.summary.sessions).toBe(1);
    expect(report.sessions.map((s) => s.id)).toEqual([sessions.find((s) => s.edits.length > 1)!.id]);
    expect(report.prompts.length).toBe(report.summary.prompts);
    expect(report.prompts.every((p) => report.hunks.some((h) => h.prompt?.id === p.id))).toBe(true);
  });

  it('hints at --scan-all when the diff is not empty but no session was found', async () => {
    const messages: string[] = [];
    const emptyHome = tempDir('why-diff-empty-home-');
    try {
      const report = await buildReport({ cwd: repo, workingTree: true, home: emptyHome, harnesses: ['claude-code'], onProgress: (m) => messages.push(m) });
      expect(report.summary.sessionsFound).toBe(0);
      expect(messages.some((m) => m.includes('--scan-all'))).toBe(true);
      expect(messages.find((m) => m.includes('--scan-all'))).toContain('no agent sessions found');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('exposes git helpers: branch, default target and time window', async () => {
    expect(await currentBranch(repo)).toBe('main');
    const resolved = await resolveDefaultTarget(repo);
    expect(resolved.label).toBe('working tree');
    const window = await commitTimes(repo, resolved.target);
    expect(window.since.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect(window.commits).toBe(0);

    git('checkout', '-q', '-b', 'feature');
    git('add', 'src/format.ts');
    git('commit', '-q', '-m', 'add formatter', '--date', '2026-10-31T10:05:00Z');
    const onBranch = await resolveDefaultTarget(repo);
    expect(onBranch).toMatchObject({ base: 'main', label: 'main...HEAD + working tree' });
    const branchWindow = await commitTimes(repo, onBranch.target);
    expect(branchWindow.commits).toBe(1);
    // The window opens at the base commit: the edits in "add formatter" predate that commit.
    expect(branchWindow.since.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect((await commitTimes(repo, 'main...HEAD')).since.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect((await commitTimes(repo, 'main..HEAD')).commits).toBe(1);
    expect((await commitTimes(repo, 'HEAD')).commits).toBe(0);
    // Committed + uncommitted work shows up in one diff, with no duplicate hunks.
    const combined = parseUnifiedDiff(await getDiff(repo, onBranch.target));
    expect(combined.filter((h) => h.file === 'src/format.ts')).toHaveLength(1);
    expect(combined.some((h) => h.file === 'README.md')).toBe(true);
    const rangeOnly = parseUnifiedDiff(await getDiff(repo, 'main...HEAD'));
    expect(rangeOnly.map((h) => h.file)).toEqual(['src/format.ts']);
  });
});

// ---------------------------------------------------------------------------
// Regression: the "tiny-shop" demo. One git hunk mixes prompt 1 (discount
// fix), prompt 2 (money() + receipt) and a human TODO line; prompt 2's Edit
// carries prompt 1's line as unchanged context in old_string/new_string.
// ---------------------------------------------------------------------------

describe('regression: mixed-owner hunk with context carried by a later edit', () => {
  const BASE = `export function lineTotal(item) {
  return item.price * item.qty;
}

export function cartTotal(items, discountPercent = 0) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  // BUG: discount is applied as a whole number instead of a percentage
  return subtotal - discountPercent;
}

export function receipt(items, discountPercent = 0) {
  const lines = items.map((i) => \`\${i.name} x\${i.qty}  \${lineTotal(i)}\`);
  lines.push(\`TOTAL  \${cartTotal(items, discountPercent)}\`);
  return lines.join('\\n');
}
`;
  const DISCOUNT_FIX = '  return subtotal * (1 - discountPercent / 100);';
  const EDIT_1 = {
    old_string: '  // BUG: discount is applied as a whole number instead of a percentage\n  return subtotal - discountPercent;',
    new_string: DISCOUNT_FIX,
  };
  const EDIT_2 = {
    old_string: `${DISCOUNT_FIX}\n}\n\nexport function receipt(items, discountPercent = 0) {\n  const lines = items.map((i) => \`\${i.name} x\${i.qty}  \${lineTotal(i)}\`);\n  lines.push(\`TOTAL  \${cartTotal(items, discountPercent)}\`);`,
    new_string: `${DISCOUNT_FIX}\n}\n\nfunction money(amount) {\n  return \`$\${amount.toFixed(2)}\`;\n}\n\nexport function receipt(items, discountPercent = 0) {\n  const lines = items.map((i) => \`\${i.name} x\${i.qty}  \${money(lineTotal(i))}\`);\n  lines.push(\`TOTAL  \${money(cartTotal(items, discountPercent))}\`);`,
  };
  const HUMAN_LINE = '// TODO: ask product about rounding rules';

  let repo: string;
  let home: string;
  let result: AttributedHunk[];
  let sessions: Session[];

  beforeAll(async () => {
    repo = tempDir('why-diff-regress-');
    const file = path.join(repo, 'src/cart.js');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, BASE);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    execFileSync('git', ['add', '-A'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'tiny-shop: initial'], { cwd: repo, env });
    repo = await repoRoot(repo);

    home = tempDir('why-diff-regress-home-');
    const cartPath = path.join(repo, 'src/cart.js');
    writeSyntheticTranscript(home, repo, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', [
      {
        prompt: 'fix discount test',
        at: '2026-10-31T15:33:00.000Z',
        calls: [{ tool: 'Edit', at: '2026-10-31T15:33:39.000Z', text: 'The discount is subtracted as a whole number; it should be a percentage.', input: { replace_all: false, file_path: cartPath, ...EDIT_1 } }],
      },
      {
        prompt: 'receipt with $ and 2 decimals',
        at: '2026-10-31T15:34:00.000Z',
        calls: [{ tool: 'Edit', at: '2026-10-31T15:34:28.000Z', text: 'Adding a money() helper and using it in the receipt.', input: { replace_all: false, file_path: cartPath, ...EDIT_2 } }],
      },
    ]);

    let content = BASE;
    for (const e of [EDIT_1, EDIT_2]) {
      expect(content).toContain(e.old_string);
      // Function form: a string replacement would interpret `$$` in the money() line.
      content = content.replace(e.old_string, () => e.new_string);
    }
    writeFileSync(cartPath, `${content}${HUMAN_LINE}\n`);

    const adapter = new ClaudeCodeAdapter();
    sessions = await Promise.all((await adapter.discover(repo, { home })).map((p) => adapter.parse(p)));
    const hunks = parseUnifiedDiff(await getDiff(repo, { workingTree: true }));
    expect(hunks).toHaveLength(1); // git folds everything into one hunk; that is the point
    result = attribute(hunks, sessions, repo);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('parses both prompts and both edits from the synthetic transcript', () => {
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.prompts.map((p) => p.text)).toEqual(['fix discount test', 'receipt with $ and 2 decimals']);
    expect(sessions[0]?.edits.map((e) => [e.tool, e.promptId])).toEqual([
      ['Edit', `${sessions[0]?.id}:0`],
      ['Edit', `${sessions[0]?.id}:1`],
    ]);
  });

  it('splits the hunk into prompt 1, prompt 2 and the human line', () => {
    expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.index ?? null])).toEqual([
      ['h1.1', 'exact', 1, 0],
      ['h1.2', 'exact', 1, 1],
      ['h1.3', 'none', 0, null],
    ]);
    expect(result.every((r) => r.hunk.file === 'src/cart.js' && r.hunk.status === 'modified')).toBe(true);
  });

  it('credits the discount line to prompt 1 although prompt 2 carried it as context (bug 1)', () => {
    const changed = (h: AttributedHunk | undefined): string[] => texts(h).filter((l) => !l.startsWith(' '));
    expect(changed(result[0])).toEqual([
      '-  // BUG: discount is applied as a whole number instead of a percentage',
      '-  return subtotal - discountPercent;',
      `+${DISCOUNT_FIX}`,
      ...changed(result[0]).slice(3), // trailing trivial lines (`}`, blank) may attach here depending on git's alignment
    ]);
    expect(changed(result[0]).slice(3).every((l) => /^\+[\s{}]*$/.test(l))).toBe(true);
    expect(changed(result[1]).filter((l) => !/^[+-][\s{}]*$/.test(l))).toEqual([
      '+function money(amount) {',
      '+  return `$${amount.toFixed(2)}`;',
      '-  const lines = items.map((i) => `${i.name} x${i.qty}  ${lineTotal(i)}`);',
      '-  lines.push(`TOTAL  ${cartTotal(items, discountPercent)}`);',
      '+  const lines = items.map((i) => `${i.name} x${i.qty}  ${money(lineTotal(i))}`);',
      '+  lines.push(`TOTAL  ${money(cartTotal(items, discountPercent))}`);',
    ]);
    expect(result[0]?.edits.map((e) => e.rationale)).toEqual(['The discount is subtracted as a whole number; it should be a percentage.']);
  });

  it('surfaces the human TODO as its own unattributed segment with context (bug 2)', () => {
    const human = result[2];
    expect(texts(human)).toEqual(["   return lines.join('\\n');", ' }', `+${HUMAN_LINE}`]);
    expect(human?.labels.map((l) => l.kind)).toEqual(['unattributed']);
    expect(human?.edits).toEqual([]);
    expect(human?.hunk.header).toMatch(/^@@ -\d+,2 \+\d+,3 @@/);
  });

  it('summarises one unattributed line and no partial hunks', () => {
    const summary = summarize(result, sessions);
    expect(summary.unattributedLines).toBe(1);
    expect(summary.agentLines).toBe(summary.addedLines - 1);
    expect(summary.labels).toEqual({ unattributed: 1 });
    expect(result.some((r) => r.match === 'partial')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-line (fragment) edits: Claude Code's Edit tool replaces substrings, so
// old_string/new_string often start and end in the middle of a line.
// ---------------------------------------------------------------------------

describe('attribute: sub-line fragment edits', () => {
  it('attributes a single-line infix replacement by rebuilding the removed line (exact)', () => {
    const e = edit(S, P0.id, 'src/cart.js', 'Math.round(sub * taxRate)', 'Math.round(discounted * taxRate)');
    const result = attribute([hunk('src/cart.js', [' const discounted = sub - discount;', '-  const tax = Math.round(sub * taxRate);', '+  const tax = Math.round(discounted * taxRate);', ' return discounted + tax;'])], [session(S, [P0], [e])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.id, r.editIds])).toEqual([['h1', 'exact', 1, P0.id, [e.id]]]);
  });

  it('handles a multi-line edit that starts and ends mid-line (suffix and prefix fragments)', () => {
    const e = edit(
      S,
      P0.id,
      'a.js',
      'lines.push(`TOTAL  ${cartTotal(items)}`);\n  return lines',
      'lines.push(`TOTAL  ${money(cartTotal(items))}`);\n  logged = true;\n  return lines',
    );
    const result = attribute(
      [hunk('a.js', [' const lines = [];', '-  lines.push(`TOTAL  ${cartTotal(items)}`);', '+  lines.push(`TOTAL  ${money(cartTotal(items))}`);', '+  logged = true;', " return lines.join('\\n');"])],
      [session(S, [P0], [e])],
      ROOT,
    );
    expect(result.map((r) => [r.hunk.id, r.match, r.prompt?.id])).toEqual([['h1', 'exact', P0.id]]);

    // Prefix fragment on the last line of new_string, verified via the removed line.
    const tail = edit(S, P1.id, 'b.js', 'const a = 1;\nconst b', 'const a = 1;\nconst bb');
    const [h] = attribute([hunk('b.js', [' const a = 1;', '-const b = 2;', '+const bb = 2;'])], [session(S, [P1], [tail])], ROOT);
    expect(h).toMatchObject({ match: 'exact', coverage: 1 });
    expect(h?.prompt?.id).toBe(P1.id);
  });

  it('handles replace_all fragments occurring in several lines, several times per line', () => {
    const e = edit(S, P0.id, 'a.js', 'qty', 'quantity', { tool: 'Edit' });
    const result = attribute(
      [hunk('a.js', ['-  return item.price * item.qty;', '+  return item.price * item.quantity;', ' //', '-  label(i.qty, max(i.qty, 1));', '+  label(i.quantity, max(i.quantity, 1));'])],
      [session(S, [P0], [e])],
      ROOT,
    );
    expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.id])).toEqual([['h1', 'exact', 1, P0.id]]);
  });

  it('never lets trivial fragments (x, ), ;) claim lines', () => {
    const tiny = edit(S, P0.id, 'a.js', 'x', 'y');
    const paren = edit(S, P0.id, 'a.js', ')', '))');
    const result = attribute([hunk('a.js', ['-  const x = f(1);', '+  const y = f(1));'])], [session(S, [P0], [tiny, paren])], ROOT);
    expect(result).toHaveLength(1);
    expect(result[0]?.match).toBe('file-only'); // the file was touched, but nothing claims the text
    expect(result[0]?.coverage).toBe(0);
  });

  it('treats containment without a rebuildable counterpart as partial', () => {
    const e = edit(S, P0.id, 'a.js', 'foo(a)', 'foo(a, b)');
    // The human also renamed the variable on the same line, so the removed line cannot be rebuilt.
    const [h] = attribute([hunk('a.js', ['-  const result = foo(a) + 1;', '+  const total = foo(a, b) + 1;'])], [session(S, [P0], [e])], ROOT);
    expect(h?.match).toBe('partial');
    expect(h?.prompt?.id).toBe(P0.id);
    expect(h?.editIds).toEqual([e.id]);
  });

  it('applies the introduced rule at fragment level: unchanged fragments carried in old_string claim nothing', () => {
    // keep(a) is in both old and new text; only changed() was introduced.
    const e = edit(S, P0.id, 'a.js', 'keep(a)\n  other()', 'keep(a)\n  changed()');
    const result = attribute([hunk('a.js', ['+  x = keep(a);', ' mid();', '-  other();', '+  changed();'])], [session(S, [P0], [e])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.prompt?.id ?? null, texts(r)])).toEqual([
      ['h1.1', 'none', null, ['+  x = keep(a);', ' mid();']],
      ['h1.2', 'exact', P0.id, [' mid();', '-  other();', '+  changed();']],
    ]);
  });

  it('keeps precedence: an introducing fragment edit beats a later edit carrying the whole line as context', () => {
    const fragment = edit(S, P0.id, 'a.js', 'sub * taxRate', 'discounted * taxRate');
    const later = edit(S, P1.id, 'a.js', '  const tax = Math.round(discounted * taxRate);\n  return tax;', '  const tax = Math.round(discounted * taxRate);\n  return tax + fee;');
    const result = attribute(
      [hunk('a.js', ['-  const tax = Math.round(sub * taxRate);', '+  const tax = Math.round(discounted * taxRate);', '-  return tax;', '+  return tax + fee;'])],
      [session(S, [P0, P1], [fragment, later])],
      ROOT,
    );
    expect(result.map((r) => [r.hunk.id, r.prompt?.id, texts(r).filter((l) => !l.startsWith(' '))])).toEqual([
      ['h1.1', P0.id, ['-  const tax = Math.round(sub * taxRate);', '+  const tax = Math.round(discounted * taxRate);']],
      ['h1.2', P1.id, ['-  return tax;', '+  return tax + fee;']],
    ]);
  });

  it('does not apply fragment semantics to whole-file writes', () => {
    const write = edit(S, P0.id, 'a.js', null, 'export const sub = 1;\n');
    const [h] = attribute([hunk('a.js', ['+const total = export const sub = 1; + 2;'], { status: 'added' })], [session(S, [P0], [write])], ROOT);
    expect(h?.match).toBe('file-only');
  });
});

// ---------------------------------------------------------------------------
// Regression (benchmark t01-cart-coupon): the Edit's old_string ends mid-line
// with a trailing space (`"/**\n * Grand total: "`) and new_string ends with
// `" * Grand total:"`, so the post-edit file has a composite line
// ` * Grand total:the discount (...)`. It must be attributed, not split off.
// ---------------------------------------------------------------------------

describe('regression: Edit ending mid-line produces a composite line', () => {
  const NEW_BLOCK = [
    ' * Subtotal after applying a coupon `{ code, type: \'percent\' | \'fixed\', value }`.',
    ' * \'percent\': value is 0-100, discount rounded to the nearest cent.',
    ' */',
    'export function applyCoupon(items, coupon) {',
    '  const sub = subtotal(items);',
    '  return sub - Math.round((sub * coupon.value) / 100);',
    '}',
    '',
    '/**',
  ];
  const OLD_STRING = '/**\n * Grand total: ';
  const NEW_STRING = ['/**', ...NEW_BLOCK, ' * Grand total:'].join('\n');
  const REST = 'the discount (fraction, e.g. 0.1) comes off the subtotal first,';
  const patchLines = [' }', ' ', ' /**', `- * Grand total: ${REST}`, ...NEW_BLOCK.map((l) => `+${l}`), `+ * Grand total:${REST}`, '  * then tax (fraction) is applied to the discounted amount.', '  */'];
  const theHunk = (): Hunk => hunk('src/cart.js', patchLines.map((l) => (l.startsWith('+') || l.startsWith('-') ? l : ` ${l.slice(1)}`)));

  it('is resolved from raw old_string/new_string by whitespace-aware fragment rebuilding (no result data)', () => {
    const e = edit(S, P0.id, 'src/cart.js', OLD_STRING, NEW_STRING);
    const result = attribute([theHunk()], [session(S, [P0], [e])], ROOT);
    expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.id])).toEqual([['h1', 'exact', 1, P0.id]]);
  });

  it('is resolved from whole lines when the adapter had a structuredPatch', async () => {
    const home = tempDir('why-diff-composite-home-');
    const cwd = '/home/dev/coupon';
    try {
      writeSyntheticTranscript(home, cwd, 'abababab-1111-4222-8333-777777777777', [
        {
          prompt: 'add coupons',
          at: '2026-10-31T12:00:00.000Z',
          calls: [
            {
              tool: 'Edit',
              at: '2026-10-31T12:00:05.000Z',
              input: { file_path: `${cwd}/src/cart.js`, old_string: OLD_STRING, new_string: NEW_STRING },
              result: { filePath: `${cwd}/src/cart.js`, oldString: OLD_STRING, newString: NEW_STRING, originalFile: 'irrelevant here', structuredPatch: [{ oldStart: 13, oldLines: 6, newStart: 13, newLines: 16, lines: patchLines }], userModified: false, replaceAll: false },
            },
          ],
        },
      ]);
      const adapter = new ClaudeCodeAdapter();
      const [file] = await adapter.discover(cwd, { home });
      const s = await adapter.parse(file!);
      expect(s.edits[0]?.newText).toContain(` * Grand total:${REST}`);
      expect(s.edits[0]?.oldText).toContain(` * Grand total: ${REST}`);
      const result = attribute([theHunk()], [s], cwd);
      expect(result.map((r) => [r.hunk.id, r.match, r.coverage, r.prompt?.index])).toEqual([['h1', 'exact', 1, 0]]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
