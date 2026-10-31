/**
 * Report-header aggregates computed from attributed hunks.
 */

import { FILE_LEVEL_LABELS, type AttributedHunk, type IntentVerdict, type LabelKind, type Session, type Summary } from './types.js';

const TEST_LABELS: ReadonlySet<LabelKind> = new Set<LabelKind>(['test-modified', 'test-skip-added', 'assertion-removed', 'tests-disabled']);

/** Ids of the sessions that own at least one hunk's prompt or one referenced edit. */
export function contributingSessionIds(hunks: AttributedHunk[]): Set<string> {
  const ids = new Set<string>();
  for (const h of hunks) {
    if (h.prompt) ids.add(h.prompt.sessionId);
    for (const e of h.edits) ids.add(e.sessionId);
  }
  return ids;
}

/**
 * Summarise attributed hunks. Agent/unattributed line counts are derived from
 * each hunk's coverage, so pure-deletion hunks contribute no added lines.
 * `sessions` are the sessions that were discovered and parsed; only those
 * that contributed to the diff are counted in `sessions`, the rest only in
 * `sessionsFound`. Likewise `prompts` counts prompts owning a hunk, not every
 * prompt typed in the window.
 */
export function summarize(hunks: AttributedHunk[], sessions: Session[]): Summary {
  const files = new Set<string>();
  let addedLines = 0;
  let removedLines = 0;
  let agentLines = 0;
  const labels: Partial<Record<LabelKind, number>> = {};
  const fileLabels = new Set<string>();
  let intent: Record<IntentVerdict['verdict'], number> | undefined;
  let touchedTests = false;
  const promptIds = new Set<string>();

  for (const { hunk, coverage, labels: hunkLabels, intent: verdict, prompt } of hunks) {
    files.add(hunk.file);
    if (prompt) promptIds.add(prompt.id);
    let added = 0;
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'del') removedLines++;
    }
    addedLines += added;
    agentLines += Math.round(coverage * added);

    for (const label of hunkLabels) {
      if (TEST_LABELS.has(label.kind)) touchedTests = true;
      if (FILE_LEVEL_LABELS.has(label.kind)) {
        const key = `${hunk.file}\0${label.kind}`;
        if (fileLabels.has(key)) continue;
        fileLabels.add(key);
      }
      labels[label.kind] = (labels[label.kind] ?? 0) + 1;
    }
    if (verdict) {
      intent ??= { requested: 0, implied: 0, unrequested: 0, unclear: 0 };
      intent[verdict.verdict]++;
    }
  }

  const contributing = contributingSessionIds(hunks);
  const known = new Set(sessions.map((s) => s.id));
  let contributingKnown = 0;
  for (const id of contributing) if (known.has(id)) contributingKnown++;

  return {
    hunks: hunks.length,
    files: files.size,
    addedLines,
    removedLines,
    agentLines,
    unattributedLines: addedLines - agentLines,
    ...(intent ? { intent } : {}),
    labels,
    touchedTests,
    sessions: contributingKnown,
    sessionsFound: sessions.length,
    prompts: promptIds.size,
  };
}
