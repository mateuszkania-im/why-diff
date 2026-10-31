/**
 * Backend-agnostic LLM classifier: batching, retry and verdict mapping.
 * Concrete backends (Claude Code CLI, Anthropic API, OpenAI-compatible) only
 * implement `CompletionBackend.complete()`.
 */
import type { AttributedHunk, IntentClassifier, IntentVerdict, Prompt } from '../types.js';
import { MAX_HUNKS_PER_CALL, buildClassificationPrompt, parseVerdicts, planBatches } from './prompt.js';

/** One chat-style request: a system prompt and a single user message. */
export interface CompletionRequest {
  system: string;
  user: string;
}

/** Minimal text-in/text-out LLM backend. */
export interface CompletionBackend {
  /** Backend id, e.g. `claude-cli` */
  readonly name: string;
  /** Model id or alias passed to the provider */
  readonly model: string;
  complete(req: CompletionRequest): Promise<string>;
}

/** The backend cannot run at all (binary missing, no credentials). Never retried. */
export class ClassifierUnavailableError extends Error {
  override name = 'ClassifierUnavailableError';
}

/** A backend call failed (HTTP error, non-zero exit, error result). Retried once. */
export class ClassifierCallError extends Error {
  override name = 'ClassifierCallError';
}

export interface LlmClassifierOptions {
  /** Max hunks per model call (default 25) */
  batchSize?: number;
  /** Parallel model calls (default 2) */
  concurrency?: number;
  /** Called after each batch with (done, total) batch counts */
  onProgress?: (done: number, total: number) => void;
}

const RETRY_NOTE =
  'Your previous answer was not valid JSON or missed some hunks. Answer again with ONLY the JSON object, one entry per key listed above.';

/**
 * IntentClassifier over any CompletionBackend. Each batch is tried once; if the
 * call fails or the JSON is invalid or partial, the hunks without a verdict are
 * asked again once. Hunks still without a verdict are left out of the result
 * (the caller decides how to mark them, see `classifyHunks`).
 */
export class LlmIntentClassifier implements IntentClassifier {
  readonly name: string;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(
    private readonly backend: CompletionBackend,
    private readonly opts: LlmClassifierOptions = {},
  ) {
    this.name = `${backend.name}:${backend.model}`;
    this.batchSize = Math.min(Math.max(1, opts.batchSize ?? MAX_HUNKS_PER_CALL), MAX_HUNKS_PER_CALL);
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  async classify(input: { prompts: Prompt[]; hunks: AttributedHunk[] }): Promise<Map<string, IntentVerdict>> {
    const batches = planBatches(input.hunks, this.batchSize);
    const out = new Map<string, IntentVerdict>();
    let done = 0;
    await mapConcurrent(batches, this.concurrency, async (batch) => {
      const result = await this.classifyBatch(input.prompts, batch);
      for (const [id, v] of result) out.set(id, v);
      this.opts.onProgress?.(++done, batches.length);
    });
    return out;
  }

  private async classifyBatch(prompts: Prompt[], batch: AttributedHunk[]): Promise<Map<string, IntentVerdict>> {
    const out = new Map<string, IntentVerdict>();
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const built = buildClassificationPrompt(prompts, pending, attempt > 0 ? { note: RETRY_NOTE } : {});
      let text: string;
      try {
        text = await this.backend.complete({ system: built.system, user: built.user });
      } catch (err) {
        if (err instanceof ClassifierUnavailableError) throw err;
        continue; // transient failure: the loop retries once
      }
      const { verdicts } = parseVerdicts(text, built.refs.keys());
      for (const [ref, v] of verdicts) {
        const id = built.refs.get(ref);
        if (id !== undefined) out.set(id, { ...v, model: this.backend.model });
      }
      pending = pending.filter((h) => !out.has(h.hunk.id));
    }
    return out;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Rejects on the first error. */
export async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
