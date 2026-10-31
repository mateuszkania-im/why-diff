import { describe, expect, it } from 'vitest';

import { capText, compactEdit, compactHunks, editTable } from '../src/compact.js';
import { EDIT_TEXT_CAP, type AttributedHunk, type FileEdit, type Session } from '../src/types.js';

function edit(id: string, over: Partial<FileEdit> = {}): FileEdit {
  return {
    id,
    sessionId: 's1',
    harness: 'claude-code',
    toolUseId: id,
    tool: 'Write',
    kind: 'write',
    filePath: '/repo/a.ts',
    at: '2026-10-31T10:00:00.000Z',
    promptId: 's1:0',
    oldText: null,
    newText: 'short',
    ...over,
  };
}

function attributed(id: string, editIds: string[], lineText = 'x'): AttributedHunk {
  return {
    hunk: { id, file: 'a.ts', status: 'modified', oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '@@ -1,0 +1 @@', lines: [{ type: 'add', text: lineText, newNo: 1 }] },
    match: editIds.length ? 'exact' : 'none',
    coverage: editIds.length ? 1 : 0,
    editIds,
    edits: [],
    labels: [],
  };
}

describe('compact', () => {
  const long = 'y'.repeat(EDIT_TEXT_CAP + 500);

  it('caps text at EDIT_TEXT_CAP with an ellipsis and leaves short text alone', () => {
    expect(capText('short')).toBe('short');
    const cut = capText(long);
    expect(cut.length).toBe(EDIT_TEXT_CAP);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('cuts oldText, newText and command of an edit and flags it', () => {
    const e = compactEdit(edit('e1', { oldText: long, newText: long, command: long }));
    expect(e.truncated).toBe(true);
    expect(e.oldText?.length).toBe(EDIT_TEXT_CAP);
    expect(e.newText?.length).toBe(EDIT_TEXT_CAP);
    expect(e.command?.length).toBe(EDIT_TEXT_CAP);
    const small = compactEdit(edit('e2'));
    expect(small).not.toHaveProperty('truncated');
    expect(small).toEqual(edit('e2'));
  });

  it('builds the edit table from referenced edits only, once per id', () => {
    const sessions: Session[] = [
      { id: 's1', harness: 'claude-code', cwd: '/repo', path: '/t/s1.jsonl', startedAt: '', endedAt: '', prompts: [], edits: [edit('e1', { newText: long }), edit('e2'), edit('e3')] },
    ];
    const table = editTable([attributed('h1', ['e1', 'e2']), attributed('h2', ['e2']), attributed('h3', [])], sessions);
    expect(Object.keys(table).sort()).toEqual(['e1', 'e2']);
    expect(table.e1?.truncated).toBe(true);
    expect(table.e1?.newText?.length).toBe(EDIT_TEXT_CAP);
    expect(table.e2).toEqual(edit('e2'));
  });

  it('cuts over-long diff lines, returning the same object when nothing changes', () => {
    const short = attributed('h1', [], 'fine');
    const big = attributed('h2', [], long);
    const [a, b] = compactHunks([short, big]);
    expect(a).toBe(short);
    expect(b).not.toBe(big);
    expect(b?.hunk.lines[0]).toEqual({ type: 'add', text: capText(long), newNo: 1, truncated: true });
    expect(big.hunk.lines[0]?.text).toBe(long); // input untouched
  });
});
