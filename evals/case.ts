/**
 * Eval glue: turns one dataset row (evals/dataset.jsonl) into the same inputs
 * why-diff produces at runtime (Prompt[] + AttributedHunk) and classifies it
 * with a real backend. Used by the promptfoo provider and by evals/run.ts.
 */
import { readFile } from 'node:fs/promises';
import { createClassifier, type ClassifierKind } from '../src/classify/index.js';
import type { AttributedHunk, DiffLine, FileEdit, IntentClassifier, IntentVerdict, Prompt } from '../src/types.js';

/** One hand-labelled case. */
export interface EvalCase {
  id: string;
  lang: string;
  tags: string[];
  /** All human prompts of the synthetic session, in order */
  prompts: string[];
  /** Index into `prompts` of the prompt the edit answered */
  linked: number;
  file: string;
  status: 'modified' | 'added' | 'deleted';
  /** Agent's explanation before the edit (may be empty) */
  rationale: string;
  /** One unified-diff hunk: `@@ ... @@` header plus ' ', '+', '-' lines */
  diff: string;
  label: IntentVerdict['verdict'];
  /** Why the gold label is what it is */
  note: string;
}

export async function loadDataset(path: string): Promise<EvalCase[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as EvalCase;
      } catch (err) {
        throw new Error(`${path}:${i + 1}: ${(err as Error).message}`);
      }
    });
}

/** Build the runtime inputs for one case. */
export function toInput(c: EvalCase): { prompts: Prompt[]; hunk: AttributedHunk } {
  const sessionId = `eval-${c.id}`;
  const prompts: Prompt[] = c.prompts.map((text, index) => ({
    id: `${sessionId}:${index}`,
    sessionId,
    harness: 'claude-code',
    index,
    at: new Date(Date.UTC(2026, 9, 31, 10, index)).toISOString(),
    text,
  }));
  const linked = prompts[c.linked] ?? prompts[0];
  const [header = '@@ -1,1 +1,1 @@', ...body] = c.diff.split('\n');
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  const lines: DiffLine[] = body.map((l) => ({
    type: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx',
    text: l.slice(1),
  }));
  const edit: FileEdit | undefined = linked && {
    id: `${sessionId}:toolu_1:0`,
    sessionId,
    harness: 'claude-code',
    toolUseId: 'toolu_1',
    tool: 'Edit',
    kind: 'edit',
    filePath: `/repo/${c.file}`,
    at: linked.at,
    promptId: linked.id,
    oldText: null,
    newText: null,
    rationale: c.rationale || undefined,
  };
  const hunk: AttributedHunk = {
    hunk: {
      id: c.id,
      file: c.file,
      status: c.status,
      oldStart: Number(m?.[1] ?? 1),
      oldLines: Number(m?.[2] ?? 1),
      newStart: Number(m?.[3] ?? 1),
      newLines: Number(m?.[4] ?? 1),
      header,
      lines,
    },
    match: 'exact',
    coverage: 1,
    edits: edit ? [edit] : [],
    prompt: linked,
    labels: [],
  };
  return { prompts, hunk };
}

export function makeClassifier(kind: ClassifierKind, model?: string): IntentClassifier {
  // One case per call: cases are independent sessions, batching them would leak
  // one case's prompts into another's context.
  const c = createClassifier(kind, { model, batchSize: 1, concurrency: 1 });
  if (!c) throw new Error(`classifier backend "${kind}" is not available`);
  return c;
}

/** Classify one case; a hunk without a verdict comes back as `unclear`. */
export async function classifyCase(classifier: IntentClassifier, c: EvalCase): Promise<IntentVerdict> {
  const { prompts, hunk } = toInput(c);
  const out = await classifier.classify({ prompts, hunks: [hunk] });
  return out.get(hunk.hunk.id) ?? { verdict: 'unclear', reason: 'no verdict returned', model: classifier.name };
}
