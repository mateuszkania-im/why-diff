import { nat } from './helpers/claude-fixture.js';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opencodeAdapter, opencodeHumanText, opencodeToolEdits } from '../src/adapters/opencode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, 'fixtures', 'opencode', 'home');
const STORAGE = path.join(HOME, '.local', 'share', 'opencode', 'storage');
const SESSION_FILE = path.join(STORAGE, 'session', 'prj_demo', 'ses_01demoA.json');
const REPO = '/work/demo-repo';

describe('opencode helpers', () => {
  it('keeps only human-typed text parts', () => {
    expect(
      opencodeHumanText([
        { type: 'text', text: 'Do it' },
        { type: 'text', text: 'injected', synthetic: true },
        { type: 'text', text: 'hidden', ignored: true },
        { type: 'file', url: 'file:///x' },
      ]),
    ).toBe('Do it');
  });

  it('maps tool inputs to edit bodies', () => {
    expect(opencodeToolEdits('edit', { filePath: 'a.ts', oldString: 'x', newString: 'y' }, '/r')).toEqual([
      { kind: 'edit', filePath: nat('/r/a.ts'), oldText: 'x', newText: 'y' },
    ]);
    expect(opencodeToolEdits('patch', { patchText: '*** Begin Patch\n*** Add File: n.ts\n+n\n*** End Patch' }, '/r')).toEqual([
      { kind: 'write', filePath: nat('/r/n.ts'), oldText: null, newText: 'n\n' },
    ]);
    expect(opencodeToolEdits('bash', { command: 'echo x > out.txt', workdir: 'pkg' }, '/r')).toEqual([
      { kind: 'bash', filePath: nat('/r/pkg/out.txt'), oldText: null, newText: null },
    ]);
    expect(opencodeToolEdits('read', { filePath: nat('/r/a.ts') }, '/r')).toEqual([]);
  });
});

describe('opencodeAdapter (JSON storage)', () => {
  it('includes sessions from extra roots (git worktrees)', async () => {
    const found = await opencodeAdapter.discover(REPO, { home: HOME, extraRoots: ['/work/other-repo'] });
    expect(found).toHaveLength(2);
    expect(found).toContain(SESSION_FILE);
  });

  it('discovers sessions inside the repo', async () => {
    expect(await opencodeAdapter.discover(REPO, { home: HOME })).toEqual([SESSION_FILE]);
    expect(await opencodeAdapter.discover(path.join(REPO, 'src'), { home: HOME })).toEqual([]);
    expect(await opencodeAdapter.discover('/work', { home: HOME })).toHaveLength(2);
  });

  it('applies the time window', async () => {
    expect(await opencodeAdapter.discover(REPO, { home: HOME, since: new Date('2026-10-23T00:00:00Z') })).toEqual([]);
    expect(await opencodeAdapter.discover(REPO, { home: HOME, until: new Date('2026-10-22T08:00:00Z') })).toEqual([]);
    expect(
      await opencodeAdapter.discover(REPO, { home: HOME, since: new Date('2026-10-22T09:05:00Z'), until: new Date('2026-10-22T09:06:00Z') }),
    ).toEqual([SESSION_FILE]);
  });

  it('parses prompts and session metadata', async () => {
    const s = await opencodeAdapter.parse(SESSION_FILE);
    expect(s).toMatchObject({
      id: 'ses_01demoA',
      harness: 'opencode',
      cwd: REPO,
      path: SESSION_FILE,
      title: 'Add greeting helper',
      startedAt: '2026-10-22T09:00:00.000Z',
      endedAt: '2026-10-22T09:10:00.000Z',
    });
    expect(s.prompts.map((p) => [p.id, p.text, p.at])).toEqual([
      ['ses_01demoA:0', 'Add a greet(name) helper in src/greet.ts', '2026-10-22T09:00:00.000Z'],
      ['ses_01demoA:1', 'Rename the helper file to greeting.ts', '2026-10-22T09:05:00.000Z'],
    ]);
  });

  it('turns edit/write/multiedit/apply_patch/bash tool parts into edits', async () => {
    const s = await opencodeAdapter.parse(SESSION_FILE);
    expect(
      s.edits.map((e) => [e.id, e.tool, e.kind, path.relative(REPO, e.filePath).split(path.sep).join('/'), e.promptId, e.failed ?? false]),
    ).toEqual([
      ['ses_01demoA:call_write_1:0', 'write', 'write', 'src/greet.ts', 'ses_01demoA:0', false],
      ['ses_01demoA:call_edit_1:0', 'edit', 'edit', 'src/index.ts', 'ses_01demoA:0', false],
      ['ses_01demoA:call_edit_2:0', 'edit', 'edit', 'src/missing.ts', 'ses_01demoA:0', true],
      ['ses_01demoA:call_bash_1:0', 'bash', 'bash', 'docs/greet.md', 'ses_01demoA:0', false],
      ['ses_01demoA:call_patch_1:0', 'apply_patch', 'patch', 'src/greeting.ts', 'ses_01demoA:1', false],
      ['ses_01demoA:call_multi_1:0', 'multiedit', 'edit', 'src/index.ts', 'ses_01demoA:1', false],
      ['ses_01demoA:call_multi_1:1', 'multiedit', 'edit', 'src/index.ts', 'ses_01demoA:1', false],
      ['ses_01demoA:call_write_2:0', 'write', 'write', 'CHANGELOG.md', 'ses_01demoA:1', true],
    ]);
    const [write, edit, , bash, patch] = s.edits;
    expect(write).toMatchObject({
      oldText: null,
      newText: 'export const greet = (n: string) => `Hello ${n}`;\n',
      at: '2026-10-22T09:00:02.000Z',
      rationale: 'Creating src/greet.ts with the helper.',
    });
    expect(edit).toMatchObject({ oldText: 'export {};', newText: "export { greet } from './greet';" });
    expect(bash).toMatchObject({ command: 'mkdir -p docs && echo "# Greet" > docs/greet.md', oldText: null, newText: null });
    expect(patch).toMatchObject({
      oldText: 'export const greet = (n: string) => `Hello ${n}`;',
      newText: 'export const greeting = (n: string) => `Hello ${n}`;',
    });
    expect(patch?.rationale).toBeUndefined();
  });
});

type Sqlite = typeof import('node:sqlite');
async function trySqlite(): Promise<Sqlite | null> {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}
const sqlite = await trySqlite();

describe.skipIf(!sqlite)('opencodeAdapter (opencode.db, v1.2+)', () => {
  let home = '';
  let dbPath = '';

  beforeAll(async () => {
    if (!sqlite) return;
    home = await mkdtemp(path.join(os.tmpdir(), 'why-diff-opencode-'));
    const dataDir = path.join(home, '.local', 'share', 'opencode');
    // Leftover JSON storage from before the migration: ses_01demoA must be reported once (from the DB).
    await cp(STORAGE, path.join(dataDir, 'storage'), { recursive: true });
    dbPath = path.join(dataDir, 'opencode.db');
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const t0 = Date.UTC(2026, 9, 25, 12, 0, 0);
    const ins = (sql: string, ...v: (string | number | null)[]): void => {
      db.prepare(sql).run(...v);
    };
    ins('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)', 'ses_01demoA', 'prj_demo', null, 'demo', REPO, 'Migrated', '1.2.0', t0 - 1000, t0 - 500);
    ins('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)', 'ses_02db', 'prj_demo', null, 'db', `${REPO}/packages/api`, 'DB session', '1.2.0', t0, t0 + 60_000);
    ins('INSERT INTO message VALUES (?,?,?,?,?)', 'msg_a1', 'ses_02db', t0, t0, JSON.stringify({ role: 'user', time: { created: t0 } }));
    ins('INSERT INTO message VALUES (?,?,?,?,?)', 'msg_a2', 'ses_02db', t0 + 1000, t0 + 1000, JSON.stringify({ role: 'assistant', time: { created: t0 + 1000 } }));
    ins('INSERT INTO part VALUES (?,?,?,?,?,?)', 'prt_a1', 'msg_a1', 'ses_02db', t0, t0, JSON.stringify({ type: 'text', text: 'Add a health route' }));
    ins('INSERT INTO part VALUES (?,?,?,?,?,?)', 'prt_a2', 'msg_a2', 'ses_02db', t0 + 1000, t0 + 1000, JSON.stringify({ type: 'text', text: 'Adding GET /health.' }));
    ins(
      'INSERT INTO part VALUES (?,?,?,?,?,?)',
      'prt_a3',
      'msg_a2',
      'ses_02db',
      t0 + 2000,
      t0 + 2000,
      JSON.stringify({
        type: 'tool',
        callID: 'call_db_1',
        tool: 'edit',
        state: { status: 'completed', input: { filePath: 'src/routes.ts', oldString: '// routes', newString: "app.get('/health', ok);" }, output: '', title: '', metadata: {}, time: { start: t0 + 2000, end: t0 + 2010 } },
      }),
    );
    db.close();
  });

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('discovers DB sessions and de-duplicates leftover JSON copies', async () => {
    const found = await opencodeAdapter.discover(REPO, { home });
    expect(found.sort()).toEqual([`${dbPath}#ses_01demoA`, `${dbPath}#ses_02db`].sort());
  });

  it('parses a DB session', async () => {
    const s = await opencodeAdapter.parse(`${dbPath}#ses_02db`);
    expect(s).toMatchObject({ id: 'ses_02db', cwd: `${REPO}/packages/api`, title: 'DB session', path: `${dbPath}#ses_02db` });
    expect(s.prompts.map((p) => p.text)).toEqual(['Add a health route']);
    expect(s.edits).toEqual([
      {
        id: 'ses_02db:call_db_1:0',
        sessionId: 'ses_02db',
        harness: 'opencode',
        toolUseId: 'call_db_1',
        tool: 'edit',
        kind: 'edit',
        filePath: nat(`${REPO}/packages/api/src/routes.ts`),
        at: '2026-10-25T12:00:02.000Z',
        promptId: 'ses_02db:0',
        oldText: '// routes',
        newText: "app.get('/health', ok);",
        rationale: 'Adding GET /health.',
      },
    ]);
  });

  it('rejects unknown DB session ids', async () => {
    await expect(opencodeAdapter.parse(`${dbPath}#ses_missing`)).rejects.toThrow(/not found/);
  });
});
