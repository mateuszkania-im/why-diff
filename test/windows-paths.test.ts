import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../src/adapters/claude.js';
import { codexAdapter, isInside } from '../src/adapters/codex.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { filePathNeedles, pathWithin } from '../src/adapters/scan.js';
import { attribute, repoRelativePath, win32Spelling } from '../src/attribute.js';
import type { Hunk, Session } from '../src/types.js';
import { nat, tempDir, writeSyntheticTranscript } from './helpers/claude-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOM = '\uFEFF';

function copyTree(src: string, dst: string, edit: (file: string, text: string) => string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = path.join(src, e);
    const d = path.join(dst, e);
    if (statSync(s).isDirectory()) copyTree(s, d, edit);
    else if (/\.(jsonl?|json)$/.test(e)) writeFileSync(d, edit(d, readFileSync(s, 'utf8')));
    else copyFileSync(s, d);
  }
}

describe('transcripts with a UTF-8 BOM', () => {
  it('Claude Code: the first line (the first prompt) is kept', async () => {
    const home = tempDir('why-diff-bom-');
    const file = writeSyntheticTranscript(home, '/work/repo', 'bom-1', [{ prompt: 'first prompt', at: '2026-10-20T10:00:00Z', calls: [{ tool: 'Write', at: '2026-10-20T10:00:05Z', input: { file_path: '/work/repo/a.js', content: 'x\n' } }] }]);
    const plain = await new ClaudeCodeAdapter().parse(file);
    writeFileSync(file, BOM + readFileSync(file, 'utf8'));
    const withBom = await new ClaudeCodeAdapter().parse(file);
    expect(withBom.prompts.map((p) => p.text)).toEqual(['first prompt']);
    expect(withBom.cwd).toBe(plain.cwd);
    expect(withBom.edits.length).toBe(plain.edits.length);
    expect(withBom.startedAt).toBe(plain.startedAt);
  });

  it('Codex: the session header on line 1 is kept', async () => {
    const dir = tempDir('why-diff-bom-codex-');
    const src = path.join(here, 'fixtures', 'codex', 'home', '.codex', 'sessions', '2026/10/20/rollout-2026-10-20T10-00-00-0199aaaa-1111-7222-8333-444455556666.jsonl');
    const file = path.join(dir, path.basename(src));
    writeFileSync(file, BOM + readFileSync(src, 'utf8'));
    const plain = await codexAdapter.parse(src);
    const withBom = await codexAdapter.parse(file);
    expect(withBom.cwd).toBe(plain.cwd);
    expect(withBom.prompts.map((p) => p.text)).toEqual(plain.prompts.map((p) => p.text));
    expect(withBom.edits.length).toBe(plain.edits.length);
  });

  it('opencode: JSON files with a BOM parse', async () => {
    const home = tempDir('why-diff-bom-oc-');
    copyTree(path.join(here, 'fixtures', 'opencode', 'home'), home, (_f, t) => BOM + t);
    const file = path.join(home, '.local', 'share', 'opencode', 'storage', 'session', 'prj_demo', 'ses_01demoA.json');
    const plain = await opencodeAdapter.parse(path.join(here, 'fixtures', 'opencode', 'home', '.local', 'share', 'opencode', 'storage', 'session', 'prj_demo', 'ses_01demoA.json'));
    const withBom = await opencodeAdapter.parse(file);
    expect(withBom.prompts.map((p) => p.text)).toEqual(plain.prompts.map((p) => p.text));
    expect(withBom.edits.length).toBe(plain.edits.length);
  });
});

describe('Windows-style paths (path logic only)', () => {
  const root = 'C:\\Users\\Dev\\Repo';

  it('resolves drive paths to repo paths whatever the drive-letter case and slash style', () => {
    for (const file of ['C:\\Users\\Dev\\Repo\\src\\a.js', 'c:\\users\\dev\\repo\\src\\a.js', 'C:/Users/Dev/Repo/src/a.js']) {
      expect(repoRelativePath(file, [root], 'C:\\Users\\Dev\\Repo'), file).toBe('src/a.js');
    }
    expect(repoRelativePath('src\\a.js', [root], 'c:/users/dev/repo')).toBe('src/a.js');
    expect(repoRelativePath('C:\\Users\\Dev\\Repo', [root])).toBe('');
    expect(repoRelativePath('C:\\Users\\Dev\\Repo2\\a.js', [root])).toBeNull();
    expect(repoRelativePath('D:\\Users\\Dev\\Repo\\a.js', [root])).toBeNull();
  });

  it('resolves . and .. segments before checking containment', () => {
    expect(repoRelativePath('C:/Users/Dev/Repo/../other/x.js', [root])).toBeNull();
    expect(repoRelativePath('C:\\Users\\Dev\\Repo\\src\\..\\..\\secret', [root])).toBeNull();
    expect(repoRelativePath('..\\..\\secret', [root], root)).toBeNull();
    expect(repoRelativePath('C:/Users/Dev/Repo/./src/a.js', [root])).toBe('src/a.js');
    expect(repoRelativePath('C:\\Users\\Dev\\Repo\\src\\x\\..\\a.js', [root])).toBe('src/a.js');
    expect(repoRelativePath('/work/repo/../other/x.js', ['/work/repo'])).toBeNull();
    expect(repoRelativePath('/work/repo/src/../a.js', ['/work/repo'])).toBe('a.js');
  });

  it('compares session folders case-insensitively on drive paths', () => {
    expect(pathWithin(root, 'c:\\users\\dev\\repo\\sub')).toBe(true);
    expect(pathWithin(root, 'C:/Users/Dev/Repo')).toBe(true);
    expect(pathWithin(root, 'C:\\Users\\Dev\\Repo2')).toBe(false);
    expect(pathWithin('/work/repo', '/work/repo/sub')).toBe(true);
    expect(pathWithin('/work/Repo', '/work/repo')).toBe(false); // POSIX stays case-sensitive
    expect(isInside(root, 'c:/users/dev/repo/x')).toBe(true);
  });

  it('--scan-all needles accept both C:\\ and C:/ forms and either drive-letter case', () => {
    const needles = filePathNeedles([root], '\\');
    const json = (p: string) => JSON.stringify({ file_path: p });
    for (const p of ['C:\\Users\\Dev\\Repo\\a.js', 'C:/Users/Dev/Repo/a.js', 'c:\\Users\\Dev\\Repo\\a.js', 'c:/Users/Dev/Repo/a.js']) {
      expect(needles.some((n) => json(p).includes(n)), p).toBe(true);
    }
  });
});

describe('alias spellings of a Windows path (sec030 #6)', () => {
  const cases: Array<[string, string]> = [
    ['\\\\?\\C:\\r\\test\\f.test.js', 'C:\\r\\test\\f.test.js'],
    ['\\\\.\\C:\\r\\test\\f.test.js', 'C:\\r\\test\\f.test.js'],
    ['//?/C:/r/test/f.test.js', 'C:/r/test/f.test.js'],
    ['\\\\?\\UNC\\srv\\share\\f.js', '\\\\srv\\share\\f.js'],
    ['C:\\r\\test\\f.test.js::$DATA', 'C:\\r\\test\\f.test.js'],
    ['C:\\r\\test\\f.test.js::$data', 'C:\\r\\test\\f.test.js'],
    ['C:\\r\\test\\f.test.js.', 'C:\\r\\test\\f.test.js'],
    ['C:\\r\\test\\f.test.js . .', 'C:\\r\\test\\f.test.js'],
    ['C:\\r\\test. \\f.test.js', 'C:\\r\\test\\f.test.js'],
    ['C:\\r\\..\\r\\f.js', 'C:\\r\\..\\r\\f.js'],
    // a POSIX path keeps its trailing dot, except on Windows where the file system drops it
    ['/home/u/f.js.', process.platform === 'win32' ? '/home/u/f.js' : '/home/u/f.js.'],
  ];
  for (const [input, want] of cases) it(`win32Spelling(${JSON.stringify(input)})`, () => expect(win32Spelling(input)).toBe(want));

  for (const fp of ['\\\\?\\C:\\r\\test\\f.test.js', '\\\\.\\C:\\r\\test\\f.test.js', 'C:\\r\\test\\f.test.js::$DATA', 'C:\\r\\test\\f.test.js.', 'C:\\r\\test\\f.test.js ']) {
    it(`repoRelativePath resolves ${JSON.stringify(fp)} into the repo`, () => expect(repoRelativePath(fp, ['C:/r'], 'C:/r')).toBe('test/f.test.js'));
  }

  it('attribute matches an edit spelled in another case to the diff file when the repo ignores case', () => {
    const hunk: Hunk = { id: 'h1', file: 'test/f.test.js', status: 'modified', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@', lines: [{ type: 'del', text: 'it("a")', oldNo: 1 }, { type: 'add', text: 'it.skip("a")', newNo: 1 }] };
    const session: Session = {
      id: 's', harness: 'claude-code', cwd: nat('/work/r'), path: 'x', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z',
      prompts: [{ id: 's:0', sessionId: 's', harness: 'claude-code', index: 0, at: '2026-01-01T00:00:00Z', text: 'x' }],
      edits: [{ id: 's:e:0', sessionId: 's', harness: 'claude-code', toolUseId: 'e', tool: 'Edit', kind: 'edit', filePath: nat('/work/r/TEST/F.TEST.JS'), at: '2026-01-01T00:00:01Z', promptId: 's:0', oldText: 'it("a")', newText: 'it.skip("a")' }],
    };
    expect(attribute([hunk], [session], nat('/work/r'), { ignoreCase: true })[0]!.match).toBe('exact');
    if (process.platform !== 'win32') expect(attribute([hunk], [session], nat('/work/r'), { ignoreCase: false })[0]!.match).toBe('none');
  });
});

