/**
 * Report compaction: the shapes that keep a report for a large diff at a few
 * megabytes instead of tens.
 *
 * - Edits are stored once, in `Report.edits`, with their text bodies cut to
 *   `EDIT_TEXT_CAP`; hunks only reference them (`editIds` + `EditRef`s).
 * - Diff line text is cut to `EDIT_TEXT_CAP` too: a minified bundle or a data
 *   blob on one line is not reviewable anyway, and two such lines can be
 *   bigger than the rest of the report put together.
 *
 * Attribution, labelling and the intent check all run on the full data
 * before this step, so caps never change a verdict, only what is embedded.
 */

import { EDIT_TEXT_CAP, type AttributedHunk, type FileEdit, type ReportEdit, type Session } from './types.js';

/** Cut `text` to `max` characters, marking the cut with an ellipsis. */
export function capText(text: string, max = EDIT_TEXT_CAP): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Every edit referenced by a hunk, keyed by id, with texts capped. Edits no session knows are skipped. */
export function editTable(hunks: AttributedHunk[], sessions: Session[]): Record<string, ReportEdit> {
  const wanted = new Set<string>();
  for (const h of hunks) for (const id of h.editIds) wanted.add(id);
  const table: Record<string, ReportEdit> = {};
  for (const s of sessions) {
    for (const e of s.edits) {
      if (!wanted.has(e.id) || table[e.id]) continue;
      table[e.id] = compactEdit(e);
    }
  }
  return table;
}

export function compactEdit(edit: FileEdit): ReportEdit {
  const out: ReportEdit = { ...edit };
  let truncated = false;
  if (edit.oldText !== null && edit.oldText.length > EDIT_TEXT_CAP) {
    out.oldText = capText(edit.oldText);
    truncated = true;
  }
  if (edit.newText !== null && edit.newText.length > EDIT_TEXT_CAP) {
    out.newText = capText(edit.newText);
    truncated = true;
  }
  if (edit.command !== undefined && edit.command.length > EDIT_TEXT_CAP) {
    out.command = capText(edit.command);
    truncated = true;
  }
  if (truncated) out.truncated = true;
  return out;
}

/** Hunks with over-long line texts cut (new objects only where something changed). */
export function compactHunks(hunks: AttributedHunk[]): AttributedHunk[] {
  return hunks.map((a) => {
    if (!a.hunk.lines.some((l) => l.text.length > EDIT_TEXT_CAP)) return a;
    const lines = a.hunk.lines.map((l) => (l.text.length > EDIT_TEXT_CAP ? { ...l, text: capText(l.text), truncated: true } : l));
    return { ...a, hunk: { ...a.hunk, lines } };
  });
}
