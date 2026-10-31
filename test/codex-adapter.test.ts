import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { codexAdapter, extractHumanText, readCodexMeta } from '../src/adapters/codex.js';
import {
  findJsToolCalls,
  jsStringArg,
  parseApplyPatch,
  parseUnifiedHunks,
  patchOpsToEdits,
  shellWriteTargets,
} from '../src/adapters/patch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, 'fixtures', 'codex', 'home');
const SESSIONS = path.join(HOME, '.codex', 'sessions');
const CLASSIC = path.join(SESSIONS, '2026/10/20/rollout-2026-10-20T10-00-00-0199aaaa-1111-7222-8333-444455556666.jsonl');
const CODE_MODE = path.join(SESSIONS, '2026/10/21/rollout-2026-10-21T09-00-00-0199bbbb-2222-7333-8444-555566667777.jsonl');
const OTHER_REPO = path.join(SESSIONS, '2026/10/21/rollout-2026-10-21T12-00-00-0199cccc-3333-7444-8555-666677778888.jsonl');
const OLD = path.join(SESSIONS, '2026/01/05/rollout-2026-01-05T09-00-00-0199dddd-4444-7555-8666-777788889999.jsonl');
const REPO = '/work/demo-repo';

describe('apply_patch parser', () => {
  it('splits update chunks into old/new snippets and reads added files', () => {
    const ops = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@ function f() {',
        '-  return 1;',
        '+  return 2;',
        ' }',
        '@@',
        '+// tail',
        '*** Add File: b.ts',
        '+line 1',
        '+line 2',
        '*** Delete File: c.ts',
        '*** End Patch',
      ].join('\n'),
    );
    expect(ops).toEqual([
      {
        kind: 'update',
        path: 'a.ts',
        hunks: [
          { oldText: '  return 1;\n}', newText: '  return 2;\n}' },
          { oldText: '', newText: '// tail' },
        ],
      },
      { kind: 'add', path: 'b.ts', content: 'line 1\nline 2\n' },
      { kind: 'delete', path: 'c.ts' },
    ]);
  });

  it('handles Move to, End of File markers and heredoc wrappers', () => {
    const ops = parseApplyPatch(
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End of File\n*** End Patch\nEOF",
    );
    expect(ops).toEqual([{ kind: 'update', path: 'old.ts', movePath: 'new.ts', hunks: [{ oldText: 'a', newText: 'b' }] }]);
    expect(patchOpsToEdits(ops, '/r')).toEqual([{ kind: 'patch', filePath: '/r/new.ts', oldText: 'a', newText: 'b' }]);
  });

  it('maps add/delete to write edits with absolute paths', () => {
    const edits = patchOpsToEdits(
      [
        { kind: 'add', path: 'x/y.ts', content: 'hi\n' },
        { kind: 'delete', path: '/abs/z.ts' },
      ],
      '/repo',
    );
    expect(edits).toEqual([
      { kind: 'write', filePath: '/repo/x/y.ts', oldText: null, newText: 'hi\n' },
      { kind: 'write', filePath: '/abs/z.ts', oldText: null, newText: '' },
    ]);
  });

  it('parses unified diff hunks', () => {
    expect(parseUnifiedHunks('--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n@@ -9 +9,2 @@\n+x\n')).toEqual([
      { oldText: 'ctx\nold', newText: 'ctx\nnew' },
      { oldText: '', newText: 'x' },
    ]);
  });
});

describe('shellWriteTargets', () => {
  it.each([
    ["sed -i '' 's/a/b/' src/a.ts src/b.ts", ['src/a.ts', 'src/b.ts']],
    ["sed -i -e 's/a/b/' f.txt", ['f.txt']],
    ['echo hi > out.txt 2>/dev/null', ['out.txt']],
    ['cat >> log.md <<EOF\nline > not-a-file\nEOF', ['log.md']],
    ['printf x | tee -a a.txt b.txt', ['a.txt', 'b.txt']],
    ['mv a.ts b.ts', ['a.ts', 'b.ts']],
    ['cp -r src dist', ['dist']],
    ['rm -f tmp.json', ['tmp.json']],
    ['cd packages/app && npm add zod', ['packages/app/package.json']],
    ['cd sub && echo 1 > x.txt', ['sub/x.txt']],
    ['npx prettier --write src/a.ts', ['src/a.ts']],
    ['git checkout -- src/a.ts', ['src/a.ts']],
  ])('%s', (cmd, targets) => {
    expect(shellWriteTargets(cmd)).toEqual({ mutating: true, targets });
  });

  it.each(['cat a.ts', 'grep -r foo src', 'npm test', 'git diff', 'ls 2>&1', 'node build.js > /dev/null', "echo '>' quoted"])(
    'not mutating: %s',
    (cmd) => {
      expect(shellWriteTargets(cmd).mutating).toBe(false);
    },
  );

  it('flags git apply as mutating without a known target', () => {
    expect(shellWriteTargets('git apply fix.patch')).toEqual({ mutating: true, targets: [] });
  });
});

describe('code-mode JS extraction', () => {
  it('finds tools.* calls and reads string literals', () => {
    const js = 'text(await tools.exec_command({cmd:"echo \\"a(b)\\" > f.txt", workdir:\'/w\'}));\nawait tools.apply_patch(`*** Begin Patch\n*** End Patch`);';
    const exec = findJsToolCalls(js, 'exec_command');
    expect(exec).toHaveLength(1);
    expect(jsStringArg(exec[0]?.args ?? '', ['cmd'])).toBe('echo "a(b)" > f.txt');
    expect(jsStringArg(exec[0]?.args ?? '', ['workdir'])).toBe('/w');
    const patch = findJsToolCalls(js, 'apply_patch');
    expect(jsStringArg(patch[0]?.args ?? '', ['input'])).toBe('*** Begin Patch\n*** End Patch');
  });

  it('returns null for non-literal arguments', () => {
    expect(jsStringArg('p', ['input'])).toBeNull();
    expect(jsStringArg('`x ${y}`', ['input'])).toBeNull();
  });
});

describe('extractHumanText', () => {
  it('drops injected context and keeps the request after an attachment preamble', () => {
    const text = extractHumanText([
      { type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>' },
      { type: 'input_text', text: '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nhi\n</INSTRUCTIONS>' },
      { type: 'input_text', text: '# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request for Codex:\nFix the bug' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' },
    ]);
    expect(text).toBe('Fix the bug');
  });

  it('returns empty for purely injected messages', () => {
    expect(extractHumanText([{ type: 'input_text', text: '<turn_aborted>\nstopped\n</turn_aborted>' }])).toBe('');
  });
});

describe('codexAdapter.discover', () => {
  beforeAll(async () => {
    // `since` filtering uses the file mtime (last write); age the old session.
    const old = new Date('2026-01-05T09:00:00Z');
    await utimes(OLD, old, old);
    const recent = new Date('2026-10-21T12:00:00Z');
    for (const f of [CLASSIC, CODE_MODE, OTHER_REPO]) await utimes(f, recent, recent);
  });

  it('reads session_meta from the first line', async () => {
    expect(await readCodexMeta(CLASSIC)).toEqual({
      id: '0199aaaa-1111-7222-8333-444455556666',
      cwd: REPO,
      timestamp: '2026-10-20T08:00:00.000Z',
    });
  });

  it('keeps sessions whose cwd is inside the repo', async () => {
    const found = await codexAdapter.discover(REPO, { home: HOME });
    expect(found.sort()).toEqual([OLD, CLASSIC, CODE_MODE].sort());
  });

  it('filters by time window', async () => {
    const found = await codexAdapter.discover(REPO, { home: HOME, since: new Date('2026-10-01T00:00:00Z') });
    expect(found.sort()).toEqual([CLASSIC, CODE_MODE].sort());
    const until = await codexAdapter.discover(REPO, { home: HOME, until: new Date('2026-10-20T23:00:00Z') });
    expect(until.sort()).toEqual([OLD, CLASSIC].sort());
  });

  it('returns nothing for an unrelated repo or a missing home', async () => {
    expect(await codexAdapter.discover('/work/nope', { home: HOME })).toEqual([]);
    expect(await codexAdapter.discover(REPO, { home: path.join(HOME, 'missing') })).toEqual([]);
  });

  it('with scanAll, keeps a rollout started elsewhere whose bytes mention a path under the repo', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'why-diff-codex-scan-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '21');
    mkdirSync(dir, { recursive: true });
    const moved = path.join(dir, path.basename(CODE_MODE));
    const lines = readFileSync(CODE_MODE, 'utf8').split('\n');
    expect(lines[0]).toContain('"cwd":"/work/demo-repo/packages/app"');
    lines[0] = (lines[0] as string).replace('"cwd":"/work/demo-repo/packages/app"', '"cwd":"/work/elsewhere"');
    writeFileSync(moved, lines.join('\n'));
    writeFileSync(path.join(dir, path.basename(OTHER_REPO)), readFileSync(OTHER_REPO));
    try {
      expect(await codexAdapter.discover(REPO, { home })).toEqual([]);
      expect(await codexAdapter.discover(REPO, { home, scanAll: true })).toEqual([moved]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('codexAdapter.parse (classic tools)', () => {
  it('extracts session metadata and human prompts only', async () => {
    const s = await codexAdapter.parse(CLASSIC);
    expect(s).toMatchObject({
      id: '0199aaaa-1111-7222-8333-444455556666',
      harness: 'codex',
      cwd: REPO,
      path: CLASSIC,
      startedAt: '2026-10-20T08:00:00.000Z',
      endedAt: '2026-10-20T08:05:03.000Z',
    });
    expect(s.prompts.map((p) => [p.id, p.index, p.at, p.text])).toEqual([
      ['0199aaaa-1111-7222-8333-444455556666:0', 0, '2026-10-20T08:00:01.200Z', 'Add a greet(name) function to src/greet.ts and export it'],
      ['0199aaaa-1111-7222-8333-444455556666:1', 1, '2026-10-20T08:05:00.100Z', 'Rename greet to greeting and delete old.txt'],
    ]);
  });

  it('turns apply_patch, exec_command, shell and local_shell calls into edits', async () => {
    const s = await codexAdapter.parse(CLASSIC);
    const sid = s.id;
    const compact = s.edits.map((e) => ({
      id: e.id.replace(`${sid}:`, ''),
      tool: e.tool,
      kind: e.kind,
      file: path.relative(REPO, e.filePath),
      prompt: e.promptId.replace(`${sid}:`, ''),
      failed: e.failed ?? false,
    }));
    expect(compact).toEqual([
      { id: 'call_patch_1:0', tool: 'apply_patch', kind: 'patch', file: 'src/greet.ts', prompt: '0', failed: false },
      { id: 'call_patch_1:1', tool: 'apply_patch', kind: 'patch', file: 'src/greet.ts', prompt: '0', failed: false },
      { id: 'call_patch_1:2', tool: 'apply_patch', kind: 'write', file: 'src/index.ts', prompt: '0', failed: false },
      { id: 'call_exec_1:0', tool: 'exec_command', kind: 'bash', file: 'src/legacy.ts', prompt: '0', failed: false },
      { id: 'call_patch_bad:0', tool: 'apply_patch', kind: 'patch', file: 'src/missing.ts', prompt: '0', failed: true },
      { id: 'call_patch_move:0', tool: 'apply_patch', kind: 'patch', file: 'src/greeting.ts', prompt: '1', failed: false },
      { id: 'call_shell_patch:0', tool: 'apply_patch', kind: 'write', file: 'old.txt', prompt: '1', failed: true },
      { id: 'call_local_1:0', tool: 'local_shell', kind: 'bash', file: 'README.md', prompt: '1', failed: false },
    ]);
  });

  it('keeps patch text, commands and rationale', async () => {
    const s = await codexAdapter.parse(CLASSIC);
    const [first, second, add, sed] = s.edits;
    expect(first).toMatchObject({ oldText: "  return 'hi';\n}", newText: "  return 'hello';\n}", at: '2026-10-20T08:00:04.000Z' });
    expect(second?.newText).toBe('export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}');
    expect(add).toMatchObject({ oldText: null, newText: "export { greet } from './greet';\n" });
    expect(sed).toMatchObject({ oldText: null, newText: null, command: "sed -i '' 's/hi/hey/' src/legacy.ts && cat src/legacy.ts" });
    expect(first?.rationale).toBe('I will add greet() and re-export it from src/index.ts.');
    // Rationale does not leak across prompts.
    expect(s.edits.find((e) => e.toolUseId === 'call_patch_move')?.rationale).toBeUndefined();
  });
});

describe('codexAdapter.parse (code mode exec cells)', () => {
  it('extracts tools.apply_patch / tools.exec_command from the JS cell', async () => {
    const s = await codexAdapter.parse(CODE_MODE);
    expect(s.cwd).toBe('/work/demo-repo/packages/app');
    expect(s.prompts.map((p) => p.text)).toEqual(['Make the primary button blue and add clsx', 'Add a test for the button']);
    const [patch, pnpm] = s.edits;
    expect(patch).toMatchObject({
      toolUseId: 'call_cell_1',
      tool: 'apply_patch',
      kind: 'patch',
      filePath: '/work/demo-repo/packages/app/src/Button.tsx',
      // The `@@ const styles = {` header is an anchor, not part of the hunk body.
      oldText: "  color: 'red',\n};",
      newText: "  color: 'blue',\n};",
      rationale: 'Switching the button colour, then adding clsx.',
      promptId: `${s.id}:0`,
    });
    expect(patch?.failed).toBeUndefined();
    expect(pnpm).toMatchObject({ toolUseId: 'call_cell_1', kind: 'bash', filePath: '/work/demo-repo/packages/app/package.json', command: 'pnpm add clsx' });
  });

  it('synthesises edits from FileChange events it cannot tie to a parsed call', async () => {
    const s = await codexAdapter.parse(CODE_MODE);
    expect(s.edits).toHaveLength(4);
    const [, , added, failed] = s.edits;
    expect(added).toMatchObject({
      toolUseId: 'exec-dddd',
      kind: 'write',
      filePath: '/work/demo-repo/packages/app/test/Button.test.tsx',
      newText: "import { it } from 'vitest';\nit('renders', () => {});\n",
      promptId: `${s.id}:1`,
      at: '2026-10-21T07:10:02.500Z',
    });
    expect(failed).toMatchObject({ toolUseId: 'exec-eeee', kind: 'patch', oldText: "import a from 'a';", newText: "import b from 'b';", failed: true });
  });

  it('ids are unique and stable', async () => {
    const a = await codexAdapter.parse(CODE_MODE);
    const b = await codexAdapter.parse(CODE_MODE);
    expect(new Set(a.edits.map((e) => e.id)).size).toBe(a.edits.length);
    expect(a.edits.map((e) => e.id)).toEqual(b.edits.map((e) => e.id));
  });
});
