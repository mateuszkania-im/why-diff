import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter, cleanPromptText, encodeProjectDir, humanPromptText } from '../src/adapters/claude.js';
import type { FileEdit } from '../src/types.js';
import { FIXTURE_CWD, FIXTURE_HOME, FIXTURE_SESSION, FIXTURE_SUBDIR_SESSION, materialiseFixtureHome, tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const adapter = new ClaudeCodeAdapter();
const MAIN = path.join(FIXTURE_HOME, '.claude', 'projects', encodeProjectDir(FIXTURE_CWD), `${FIXTURE_SESSION}.jsonl`);

const byTool = (edits: FileEdit[], toolUseId: string): FileEdit[] => edits.filter((e) => e.toolUseId === toolUseId);

describe('ClaudeCodeAdapter.discover', () => {
  it('finds sessions whose cwd is the repo or a directory inside it, rejecting look-alike siblings', async () => {
    const found = await adapter.discover(FIXTURE_CWD, { home: FIXTURE_HOME });
    expect(found.map((f) => path.basename(f))).toEqual([`${FIXTURE_SESSION}.jsonl`, `${FIXTURE_SUBDIR_SESSION}.jsonl`]);
    expect(found.some((f) => f.includes('acme-shop-2'))).toBe(false);
  });

  it('finds a session started in a sibling git worktree only when it is passed as an extra root', async () => {
    const home = tempDir('why-diff-home-');
    const repo = '/work/shop';
    const wt = '/work/shop-wt';
    writeSyntheticTranscript(home, wt, 'wt-1', [{ prompt: 'do it', at: '2026-10-20T10:00:00Z', calls: [{ tool: 'Write', at: '2026-10-20T10:00:05Z', input: { file_path: `${wt}/a.js`, content: 'x\n' } }] }]);
    expect(await adapter.discover(repo, { home })).toEqual([]);
    const found = await adapter.discover(repo, { home, extraRoots: [wt] });
    expect(found.map((f) => path.basename(f))).toEqual(['wt-1.jsonl']);
  });

  it('does not return subagent transcripts as sessions', async () => {
    const found = await adapter.discover(FIXTURE_CWD, { home: FIXTURE_HOME });
    expect(found.some((f) => f.includes('subagents'))).toBe(false);
  });

  it('filters by time window', async () => {
    const future = new Date('2030-01-01T00:00:00Z');
    expect(await adapter.discover(FIXTURE_CWD, { home: FIXTURE_HOME, since: future })).toEqual([]);
    const past = new Date('2020-01-01T00:00:00Z');
    expect(await adapter.discover(FIXTURE_CWD, { home: FIXTURE_HOME, until: past })).toEqual([]);
    const around = await adapter.discover(FIXTURE_CWD, { home: FIXTURE_HOME, since: past, until: future });
    expect(around).toHaveLength(2);
  });

  it('encodes project directories like Claude Code: everything outside [A-Za-z0-9-] becomes "-"', () => {
    expect(encodeProjectDir('/x/f01-cart-total__baseline__r1')).toBe('-x-f01-cart-total--baseline--r1');
    expect(encodeProjectDir('/Users/dev/my.app/sub dir')).toBe('-Users-dev-my-app-sub-dir');
    expect(encodeProjectDir('C:\\work\\repo')).toBe('C--work-repo');
  });

  it('discovers sessions whose cwd contains underscores and dots', async () => {
    const home = tempDir('why-diff-underscore-home-');
    const cwd = '/x/f01-cart-total__baseline__r1';
    writeSyntheticTranscript(home, cwd, 'dddddddd-1111-4222-8333-444444444444', [
      { prompt: 'fix the tax', at: '2026-10-31T12:00:00.000Z', calls: [{ tool: 'Edit', at: '2026-10-31T12:00:05.000Z', input: { file_path: `${cwd}/src/cart.js`, old_string: 'a', new_string: 'b' } }] },
    ]);
    try {
      expect(path.basename(path.dirname(path.join(home, '.claude', 'projects', encodeProjectDir(cwd), 'x')))).toBe('-x-f01-cart-total--baseline--r1');
      const found = await adapter.discover(cwd, { home });
      expect(found).toHaveLength(1);
      const session = await adapter.parse(found[0]!);
      expect(session.cwd).toBe(cwd);
      expect(session.prompts.map((p) => p.text)).toEqual(['fix the tax']);
      // A look-alike that encodes to the same prefix but has another cwd is rejected by the cwd check.
      expect(await adapter.discover('/x/f01-cart-total__baseline__r2', { home })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns nothing for an unknown home or repo', async () => {
    expect(await adapter.discover(FIXTURE_CWD, { home: '/nonexistent/home' })).toEqual([]);
    expect(await adapter.discover('/home/dev/other-project', { home: FIXTURE_HOME })).toEqual([]);
  });

  it('matches the repo by cwd even when the path has a trailing slash or a different form', async () => {
    expect(await adapter.discover(`${FIXTURE_CWD}/`, { home: FIXTURE_HOME })).toHaveLength(2);
  });
});

describe('ClaudeCodeAdapter.parse', () => {
  it('extracts human prompts only, with system reminders stripped', async () => {
    const session = await adapter.parse(MAIN);
    expect(session.id).toBe(FIXTURE_SESSION);
    expect(session.harness).toBe('claude-code');
    expect(session.cwd).toBe(FIXTURE_CWD);
    expect(session.title).toBe('Price formatter and version bump');
    expect(session.startedAt).toBe('2026-10-31T10:00:00.000Z');
    expect(session.endedAt).toBe('2026-10-31T10:03:05.000Z');

    expect(session.prompts.map((p) => p.text)).toEqual([
      'Add a price formatter in src/format.ts and use it in src/cart.ts.',
      'Bump the version to 1.1.0 with a shell one-liner and delete src/legacy.ts.',
      'Also add a CHANGELOG with a heredoc.',
      '/review src/cart.ts',
    ]);
    expect(session.prompts.map((p) => p.id)).toEqual([0, 1, 2, 3].map((i) => `${FIXTURE_SESSION}:${i}`));
    expect(session.prompts[1]?.at).toBe('2026-10-31T10:01:00.000Z');
    expect(session.prompts.every((p) => !p.text.includes('system-reminder'))).toBe(true);
  });

  it('normalises Write, Edit and MultiEdit calls into FileEdits with rationale', async () => {
    const { edits, prompts } = await adapter.parse(MAIN);
    const firstPrompt = prompts[0]!.id;

    const [write] = byTool(edits, 'toolu_01WriteFormat000000001');
    expect(write).toMatchObject({
      id: `${FIXTURE_SESSION}:toolu_01WriteFormat000000001:0`,
      tool: 'Write',
      kind: 'write',
      filePath: `${FIXTURE_CWD}/src/format.ts`,
      promptId: firstPrompt,
      oldText: null,
      at: '2026-10-31T10:00:10.000Z',
      rationale: "I'll add the formatter first, then wire it into the cart total.",
    });
    expect(write?.newText).toContain('export function formatPrice(amount: number): string {');
    expect(write?.failed).toBeUndefined();

    const [edit] = byTool(edits, 'toolu_02EditCart0000000000002');
    // The result's structuredPatch gives the edited region as whole lines (context on both sides).
    expect(edit).toMatchObject({
      tool: 'Edit',
      kind: 'edit',
      oldText: '    total += item.price * item.qty;\n  }\n  return total;\n}',
      newText: '    total += item.price * item.qty;\n  }\n  return formatPrice(total);\n}',
      promptId: firstPrompt,
    });
    // No text block in that message: rationale falls back to the previous assistant message.
    expect(edit?.rationale).toBe("I'll add the formatter first, then wire it into the cart total.");

    const multi = byTool(edits, 'toolu_03MultiCart000000000003');
    expect(multi.map((e) => e.id)).toEqual([
      `${FIXTURE_SESSION}:toolu_03MultiCart000000000003:0`,
      `${FIXTURE_SESSION}:toolu_03MultiCart000000000003:1`,
    ]);
    expect(multi[0]).toMatchObject({ tool: 'MultiEdit', kind: 'edit', oldText: 'export function cartTotal(items: CartItem[]): number {', rationale: 'Now the import and the return type.' });
    expect(multi[1]?.newText).toBe("import { formatPrice } from './format.js';\n\nexport interface CartItem {");
  });

  it('marks rejected edits as failed', async () => {
    const { edits } = await adapter.parse(MAIN);
    const [failed] = byTool(edits, 'toolu_04FailedEdit00000000004');
    expect(failed).toMatchObject({ tool: 'Edit', failed: true, oldText: 'function legacyTotal' });
  });

  it('turns file-mutating Bash commands into bash edits attributed to their prompt', async () => {
    const { edits, prompts } = await adapter.parse(MAIN);
    const sed = byTool(edits, 'toolu_06BashSed000000000000006');
    expect(sed.map((e) => [e.kind, path.relative(FIXTURE_CWD, e.filePath)])).toEqual([
      ['bash', 'package.json'],
      ['bash', 'src/legacy.ts'],
    ]);
    expect(sed[0]).toMatchObject({ tool: 'Bash', promptId: prompts[1]!.id, oldText: null, newText: null, rationale: 'Using sed for the bump, then removing the legacy helper.' });
    expect(sed[0]?.command).toContain("sed -i ''");

    const [heredoc] = byTool(edits, 'toolu_07BashHeredoc0000000007');
    expect(heredoc).toMatchObject({ kind: 'bash', filePath: `${FIXTURE_CWD}/CHANGELOG.md`, promptId: prompts[2]!.id });
    expect(heredoc?.newText).toBe('# Changelog\n\n## 1.1.0\n\n- Add formatPrice helper\n');
  });

  it('includes subagent edits, attributed to the prompt that launched the Agent call', async () => {
    const { edits, prompts } = await adapter.parse(MAIN);
    const [sub] = byTool(edits, 'toolu_S1WriteTest0000000000001');
    expect(sub).toMatchObject({ tool: 'Write', kind: 'write', filePath: `${FIXTURE_CWD}/test/format.test.ts`, sessionId: FIXTURE_SESSION });
    // The subagent ran after the second human prompt, yet belongs to the first one.
    expect(sub?.promptId).toBe(prompts[0]!.id);
    expect(sub?.rationale).toBe('Writing the test file.');
  });

  it('does not count sidechain, command, hook or meta user lines as prompts', async () => {
    const { prompts } = await adapter.parse(MAIN);
    expect(prompts).toHaveLength(4);
    expect(prompts.some((p) => p.text.includes('subagent'))).toBe(false);
    expect(prompts.some((p) => p.text.includes('task-notification'))).toBe(false);
    expect(prompts.some((p) => p.text.includes('/status'))).toBe(false);
  });

  it('produces exactly the expected set of edits', async () => {
    const { edits } = await adapter.parse(MAIN);
    expect(edits.map((e) => e.id)).toEqual([
      `${FIXTURE_SESSION}:toolu_01WriteFormat000000001:0`,
      `${FIXTURE_SESSION}:toolu_02EditCart0000000000002:0`,
      `${FIXTURE_SESSION}:toolu_03MultiCart000000000003:0`,
      `${FIXTURE_SESSION}:toolu_03MultiCart000000000003:1`,
      `${FIXTURE_SESSION}:toolu_04FailedEdit00000000004:0`,
      `${FIXTURE_SESSION}:toolu_06BashSed000000000000006:0`,
      `${FIXTURE_SESSION}:toolu_06BashSed000000000000006:1`,
      `${FIXTURE_SESSION}:toolu_07BashHeredoc0000000007:0`,
      `${FIXTURE_SESSION}:toolu_S1WriteTest0000000000001:0`,
    ]);
  });
});

describe('ClaudeCodeAdapter.parse: line handling', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  it('parses CRLF transcripts and skips huge tool results of calls that cannot edit, with the same result', async () => {
    const dir = tempDir('why-diff-lines-');
    created.push(dir);
    const copy = path.join(dir, `${FIXTURE_SESSION}.jsonl`);
    cpSync(path.join(path.dirname(MAIN), FIXTURE_SESSION), path.join(dir, FIXTURE_SESSION), { recursive: true });
    const lines = readFileSync(MAIN, 'utf8').split('\n').filter(Boolean);
    const huge = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_screenshot', content: 'x'.repeat(200_000) }] } });
    lines.splice(3, 0, huge);
    writeFileSync(copy, lines.join('\r\n') + '\r\n');
    const original = await adapter.parse(MAIN);
    const parsed = await adapter.parse(copy);
    expect(parsed.prompts).toEqual(original.prompts);
    expect(parsed.edits.map(({ id, filePath, failed, newText }) => ({ id, filePath, failed, newText }))).toEqual(
      original.edits.map(({ id, filePath, failed, newText }) => ({ id, filePath, failed, newText })),
    );
  });
});

describe('ClaudeCodeAdapter.discover: sessions started in a parent folder', () => {
  it('includes a parent-folder session only when it mentions the repo', async () => {
    const home = tempDir('why-diff-parent-');
    const repo = '/work/space/app';
    const turn = (file: string) => [{ prompt: 'fix it', at: '2026-10-31T10:00:00.000Z', calls: [{ tool: 'Write', at: '2026-10-31T10:00:05.000Z', input: { file_path: file, content: 'x\n' } }] }];
    writeSyntheticTranscript(home, '/work/space', 'aaaaaaaa-0000-4000-8000-000000000001', turn(`${repo}/src/a.ts`) as never);
    writeSyntheticTranscript(home, '/work/space', 'aaaaaaaa-0000-4000-8000-000000000002', turn('/work/space/other/src/a.ts') as never);
    mkdirSync(path.join(home, '.claude', 'projects', encodeProjectDir('/work/space/app-old')), { recursive: true });
    const found = await adapter.discover(repo, { home });
    rmSync(home, { recursive: true, force: true });
    expect(found.map((f) => path.basename(f))).toEqual(['aaaaaaaa-0000-4000-8000-000000000001.jsonl']);
  });
});

describe('ClaudeCodeAdapter.discover: --scan-all', () => {
  it('finds a sibling-folder session that edited the repo by absolute path, but only when asked', async () => {
    const home = tempDir('why-diff-scanall-');
    const repo = '/work/space/app';
    const turn = (file: string) => [{ prompt: 'fix it', at: '2026-10-31T10:00:00.000Z', calls: [{ tool: 'Write', at: '2026-10-31T10:00:05.000Z', input: { file_path: file, content: 'x\n' } }] }];
    writeSyntheticTranscript(home, '/work/space/sibling', 'cccccccc-0000-4000-8000-000000000001', turn(`${repo}/src/a.ts`) as never);
    writeSyntheticTranscript(home, '/work/space/sibling', 'cccccccc-0000-4000-8000-000000000002', turn('/work/space/sibling/src/a.ts') as never);
    writeSyntheticTranscript(home, '/work/space/app-old', 'cccccccc-0000-4000-8000-000000000003', turn('/work/space/app-old/src/a.ts') as never);
    writeSyntheticTranscript(home, repo, 'cccccccc-0000-4000-8000-000000000004', turn(`${repo}/src/b.ts`) as never);
    const names = (files: string[]): string[] => files.map((f) => path.basename(f, '.jsonl').slice(-1)).sort();
    try {
      expect(names(await adapter.discover(repo, { home }))).toEqual(['4']);
      expect(names(await adapter.discover(repo, { home, scanAll: true }))).toEqual(['1', '4']);
      // the time window still applies to scanned transcripts
      expect(await adapter.discover(repo, { home, scanAll: true, since: new Date(Date.now() + 3_600_000) })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('whole-line reconstruction of Edit regions', () => {
  const CWD = '/home/dev/stitch';
  const ORIGINAL = `export function subtotal(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n\n/**\n * Grand total: the discount comes off first,\n * then tax.\n */\nexport function total(items) {\n  const sub = subtotal(items);\n  return sub;\n}\n`;
  const parseWith = async (calls: Parameters<typeof writeSyntheticTranscript>[3][number]['calls']): Promise<FileEdit[]> => {
    const home = tempDir('why-diff-stitch-home-');
    try {
      writeSyntheticTranscript(home, CWD, 'eeeeeeee-1111-4222-8333-555555555555', [{ prompt: 'edit', at: '2026-10-31T12:00:00.000Z', calls }]);
      const [file] = await adapter.discover(CWD, { home });
      return (await adapter.parse(file!)).edits;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  const at = '2026-10-31T12:00:05.000Z';
  const file_path = `${CWD}/src/cart.js`;

  it('prefers structuredPatch lines: context on both sides, "-" old, "+" new, "\\" markers skipped', async () => {
    const [e] = await parseWith([
      {
        tool: 'Edit',
        at,
        input: { file_path, old_string: 'return sub;', new_string: 'return sub + tax;' },
        result: {
          filePath: file_path,
          oldString: 'return sub;',
          newString: 'return sub + tax;',
          originalFile: ORIGINAL,
          structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: ['   const sub = subtotal(items);', '-  return sub;', '+  return sub + tax;', ' }', '\\ No newline at end of file'] }],
          userModified: false,
          replaceAll: false,
        },
      },
    ]);
    expect(e?.oldText).toBe('  const sub = subtotal(items);\n  return sub;\n}');
    expect(e?.newText).toBe('  const sub = subtotal(items);\n  return sub + tax;\n}');
  });

  it('stitches a mid-line old_string/new_string into originalFile when no structuredPatch is present', async () => {
    const [e] = await parseWith([
      {
        tool: 'Edit',
        at,
        input: { file_path, old_string: '/**\n * Grand total: ', new_string: '/**\n * Coupons first.\n */\nexport function applyCoupon() {}\n\n/**\n * Grand total:' },
        result: { filePath: file_path, originalFile: ORIGINAL, structuredPatch: [], userModified: false, replaceAll: false },
      },
    ]);
    // The remainder of the original line is carried over, producing the real composite line.
    expect(e?.oldText).toBe('/**\n * Grand total: the discount comes off first,');
    expect(e?.newText).toBe('/**\n * Coupons first.\n */\nexport function applyCoupon() {}\n\n/**\n * Grand total:the discount comes off first,');
  });

  it('stitches replace_all occurrences, merging ranges that share a line', async () => {
    const [e] = await parseWith([
      {
        tool: 'Edit',
        at,
        input: { file_path, old_string: 'sub', new_string: 'base', replace_all: true },
        result: { filePath: file_path, oldString: 'sub', newString: 'base', originalFile: ORIGINAL, structuredPatch: [], userModified: false, replaceAll: true },
      },
    ]);
    expect(e?.oldText).toBe('export function subtotal(items) {\n  const sub = subtotal(items);\n  return sub;');
    expect(e?.newText).toBe('export function basetotal(items) {\n  const base = basetotal(items);\n  return base;');
  });

  it('stitches MultiEdit sub-edits sequentially against originalFileContents', async () => {
    const edits = await parseWith([
      {
        tool: 'Edit',
        at,
        input: {},
        result: {},
      },
    ]);
    expect(edits).toHaveLength(0); // an Edit without a file path yields nothing

    const home = tempDir('why-diff-stitch-home-');
    try {
      const file = writeSyntheticTranscript(home, CWD, 'ffffffff-1111-4222-8333-666666666666', [{ prompt: 'multi', at: '2026-10-31T12:00:00.000Z', calls: [] }]);
      // Hand-write a MultiEdit call + result (the helper only knows Edit/Write/Bash).
      const base = { isSidechain: false, cwd: CWD, sessionId: 'ffffffff-1111-4222-8333-666666666666', version: '2.1.310', userType: 'external', entrypoint: 'cli' };
      const multi = { file_path, edits: [
        { old_string: 'return sub;', new_string: 'return sub + 1;' },
        { old_string: 'sub + 1;\n}', new_string: 'sub + 2;\n}\n// done' },
      ] };
      const lines = [
        { ...base, type: 'assistant', uuid: 'u1', parentUuid: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_multi', name: 'MultiEdit', input: multi }] } },
        { ...base, type: 'user', uuid: 'u2', parentUuid: 'u1', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_multi', content: 'Applied 2 edits' }] }, toolUseResult: { filePath: file_path, edits: multi.edits, originalFileContents: ORIGINAL, structuredPatch: [], userModified: false } },
      ];
      writeFileSync(file, `${readFileSync(file, 'utf8')}${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      const session = await adapter.parse(file);
      expect(session.edits.map((e) => [e.oldText, e.newText])).toEqual([
        ['  return sub;', '  return sub + 1;'],
        ['  return sub + 1;\n}', '  return sub + 2;\n}\n// done'],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to the raw strings when neither structuredPatch nor originalFile is available', async () => {
    const [e] = await parseWith([{ tool: 'Edit', at, input: { file_path, old_string: 'return sub;', new_string: 'return sub + tax;' }, result: { filePath: file_path } }]);
    expect(e).toMatchObject({ oldText: 'return sub;', newText: 'return sub + tax;' });
  });
});

describe('humanPromptText heuristics', () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: content as string }, ...extra });

  it('trusts origin/promptSource when present', () => {
    expect(humanPromptText(user('hello', { origin: { kind: 'human' }, promptSource: 'typed' }))).toBe('hello');
    expect(humanPromptText(user('hello', { origin: { kind: 'human' }, promptSource: 'queued' }))).toBe('hello');
    // Agent SDK / `claude -p` sessions: the caller's prompt is the human prompt.
    expect(humanPromptText(user('Convert all recipes to metric.', { promptSource: 'sdk' }))).toBe('Convert all recipes to metric.');
    expect(humanPromptText(user('hello', { origin: { kind: 'task-notification' }, promptSource: 'system' }))).toBeNull();
    expect(humanPromptText(user('hello', { promptSource: 'system' }))).toBeNull();
    expect(humanPromptText(user('hello', { isMeta: true }))).toBeNull();
    expect(humanPromptText(user('hello', { isSidechain: true }))).toBeNull();
  });

  it('falls back to content heuristics for older transcripts', () => {
    expect(humanPromptText(user('fix the bug'))).toBe('fix the bug');
    expect(humanPromptText(user([{ type: 'text', text: 'array form' }]))).toBe('array form');
    expect(humanPromptText(user('<command-name>/clear</command-name>'))).toBeNull();
    expect(humanPromptText(user('<local-command-stdout>x</local-command-stdout>'))).toBeNull();
    expect(humanPromptText(user('Caveat: The messages below were generated by the user while running local commands.'))).toBeNull();
    expect(humanPromptText(user('<system-reminder>only noise</system-reminder>'))).toBeNull();
    expect(humanPromptText(user([{ type: 'tool_result', tool_use_id: 'x' }]))).toBeNull();
    expect(humanPromptText(user('[Request interrupted by user]'))).toBeNull();
  });

  it('renders slash commands the human typed as "/name args"', () => {
    const slash = '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>';
    expect(humanPromptText(user(slash, { origin: { kind: 'human' } }))).toBe('/review src/a.ts');
  });

  it('keeps built-in slash commands with arguments (no origin in 2.1.x) but not session commands', () => {
    const goal = '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>finish the eval project</command-args>';
    expect(humanPromptText(user(goal))).toBe('/goal finish the eval project');
    expect(humanPromptText(user('<command-name>/compact</command-name>\n<command-args>focus on tests</command-args>'))).toBeNull();
    expect(humanPromptText(user('<command-name>/clear</command-name>\n<command-args></command-args>'))).toBeNull();
    expect(humanPromptText(user(goal, { origin: { kind: 'task-notification' } }))).toBeNull();
  });

  it('strips system reminders anywhere in the text', () => {
    expect(cleanPromptText('a <system-reminder>\nnoise\n</system-reminder> b\n\n\n\nc')).toBe('a  b\n\nc');
  });
});

describe('fixture materialisation', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  it('re-points the fixture at another repository path', async () => {
    const repo = tempDir('why-diff-repo-');
    const home = materialiseFixtureHome(repo);
    created.push(repo, home);
    const found = await adapter.discover(repo, { home });
    expect(found).toHaveLength(2);
    const session = await adapter.parse(found[0]!);
    expect(session.cwd).toBe(repo);
    expect(session.edits[0]?.filePath).toBe(path.join(repo, 'src/format.ts'));
  });
});

describe('prompt cleaning on pasted blobs', () => {
  it('strips system reminders and reads slash commands in linear time on unclosed tags', async () => {
    const { bestOf, expectScalesSubQuadratically } = await import('./helpers/perf.js');
    const blob = (tag: string, n: number) => tag.repeat(Math.floor(n / tag.length));
    const clean = (n: number) => () => cleanPromptText(blob('<system-reminder>', n));
    expect(bestOf(clean(200_000), 3)).toBeLessThan(1000);
    expectScalesSubQuadratically(clean(50_000), clean(200_000));
    const cmd = (n: number) => () => humanPromptText({ type: 'user', message: { role: 'user', content: `<command-name>/goal</command-name>${blob('<command-args>', n)}` } } as never);
    expect(bestOf(cmd(200_000), 3)).toBeLessThan(1000);
    expectScalesSubQuadratically(cmd(50_000), cmd(200_000));
  }, 30_000);

  it('still strips closed reminders and reads command arguments', () => {
    expect(cleanPromptText('fix it<system-reminder>noise</system-reminder>\n\n\n\nnow<system-reminder>more')).toBe('fix it\n\nnow<system-reminder>more');
    expect(humanPromptText({ type: 'user', message: { role: 'user', content: '<command-name>/goal</command-name><command-args>ship it</command-args>' } } as never)).toBe('/goal ship it');
  });
});

describe('ClaudeCodeAdapter.parse: shell windows', () => {
  it('records one window per Bash call, from the tool_use line to its tool_result line', async () => {
    const home = tempDir('why-diff-home-');
    const file = writeSyntheticTranscript(home, '/work/shop', 'win-1', [{
      prompt: 'fix the tests',
      at: '2026-10-20T10:00:00.000Z',
      calls: [
        { tool: 'Bash', at: '2026-10-20T10:00:05.000Z', resultAt: '2026-10-20T10:00:09.000Z', input: { command: 'node fix.js' } },
        { tool: 'Edit', at: '2026-10-20T10:00:10.000Z', input: { file_path: '/work/shop/a.js', old_string: 'a', new_string: 'b' } },
        { tool: 'Bash', at: '2026-10-20T10:00:20.000Z', input: { command: 'npm test' }, isError: true },
      ],
    }]);
    const s = await adapter.parse(file);
    expect(s.shellWindows).toEqual([
      { callId: 'toolu_0101xxxxxxxxxxxxxxxx', start: '2026-10-20T10:00:05.000Z', end: '2026-10-20T10:00:09.000Z' },
      // a failing command (non-zero exit) may still have changed files
      { callId: 'toolu_0103xxxxxxxxxxxxxxxx', start: '2026-10-20T10:00:20.000Z', end: '2026-10-20T10:00:21.000Z' },
    ]);
  });

  it('records no window for a Bash call that never got a result or was denied', async () => {
    const home = tempDir('why-diff-home-');
    const file = writeSyntheticTranscript(home, '/work/shop', 'win-2', [{
      prompt: 'clean up',
      at: '2026-10-20T10:00:00.000Z',
      calls: [{ tool: 'Bash', at: '2026-10-20T10:00:05.000Z', input: { command: 'node wipe.js' }, isError: true, result: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.' }],
    }]);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    // make the result text the real rejection message
    const last = lines[lines.length - 1] as { message: { content: Array<{ content: string }> } };
    last.message.content[0]!.content = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.';
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    expect((await adapter.parse(file)).shellWindows ?? []).toEqual([]);

    const unfinished = writeSyntheticTranscript(home, '/work/shop', 'win-3', [{ prompt: 'x', at: '2026-10-20T10:00:00.000Z', calls: [{ tool: 'Bash', at: '2026-10-20T10:00:05.000Z', input: { command: 'node a.js' } }] }]);
    const kept = readFileSync(unfinished, 'utf8').split('\n').filter(Boolean).slice(0, -1);
    writeFileSync(unfinished, `${kept.join('\n')}\n`);
    expect((await adapter.parse(unfinished)).shellWindows ?? []).toEqual([]);
  });
});
