/**
 * Optional LLM intent check: did the human actually ask for this hunk?
 *
 *   const classifier = createClassifier('auto');
 *   if (classifier) report.hunks = await classifyHunks(report.hunks, report.prompts, classifier, { repoRoot });
 *
 * Backends (picked by `auto` in this order):
 *   1. claude-cli  local Claude Code (`claude -p`), uses the user's subscription
 *   2. anthropic   Messages API, needs ANTHROPIC_API_KEY
 *   3. openai      any OpenAI-compatible endpoint, OPENAI_API_KEY / OPENAI_BASE_URL
 * WHY_DIFF_MODEL overrides the model for whichever backend is used.
 */
import type { AttributedHunk, IntentClassifier, IntentVerdict, Prompt } from '../types.js';
import { AnthropicBackend } from './anthropic.js';
import { VerdictCache, cacheKey, cachePath } from './cache.js';
import { ClaudeCliBackend, findOnPath, type ProcessRunner } from './claude-cli.js';
import { ClassifierUnavailableError, LlmIntentClassifier, type LlmClassifierOptions } from './llm.js';
import { OpenAiBackend } from './openai.js';
import { VERDICTS, type Verdict } from './prompt.js';

export type ClassifierKind = 'auto' | 'claude-cli' | 'anthropic' | 'openai' | 'none';

export interface CreateClassifierOptions extends LlmClassifierOptions {
  /** Model override; falls back to $WHY_DIFF_MODEL, then the backend default */
  model?: string;
  /** Environment to read keys/paths from (default process.env) */
  env?: NodeJS.ProcessEnv;
  /** claude binary (default $WHY_DIFF_CLAUDE_BIN or `claude`) */
  claudeBin?: string;
  /** Injected process runner for the claude CLI backend (tests) */
  runner?: ProcessRunner;
  /** Injected fetch for HTTP backends (tests) */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Create an intent classifier. Returns null for `none`, and for `auto` when no
 * backend is available. An explicit backend that cannot run throws
 * ClassifierUnavailableError with a message fit for the terminal.
 */
export function createClassifier(kind: ClassifierKind = 'auto', opts: CreateClassifierOptions = {}): IntentClassifier | null {
  const env = opts.env ?? process.env;
  const model = opts.model ?? (env.WHY_DIFF_MODEL || undefined);
  const claudeBin = opts.claudeBin ?? (env.WHY_DIFF_CLAUDE_BIN || 'claude');
  const wrap = (backend: ConstructorParameters<typeof LlmIntentClassifier>[0]): IntentClassifier =>
    new LlmIntentClassifier(backend, opts);

  const claudeCli = (): IntentClassifier => {
    // With an injected runner the binary is never spawned, so skip the PATH check.
    const bin = opts.runner ? claudeBin : findOnPath(claudeBin, env.PATH ?? '');
    if (!bin) {
      throw new ClassifierUnavailableError(
        `Claude Code CLI ("${claudeBin}") is not on PATH. Install Claude Code and run \`claude\` once to log in, or use --classifier anthropic|openai.`,
      );
    }
    return wrap(new ClaudeCliBackend({ bin, model, runner: opts.runner, timeoutMs: opts.timeoutMs }));
  };
  const anthropic = (): IntentClassifier =>
    wrap(
      new AnthropicBackend({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL || undefined,
        model,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
      }),
    );
  const openai = (): IntentClassifier =>
    wrap(
      new OpenAiBackend({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL || undefined,
        model,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
      }),
    );

  switch (kind) {
    case 'none':
      return null;
    case 'claude-cli':
      return claudeCli();
    case 'anthropic':
      return anthropic();
    case 'openai':
      return openai();
    case 'auto':
      if (opts.runner || findOnPath(claudeBin, env.PATH ?? '')) return claudeCli();
      if (env.ANTHROPIC_API_KEY) return anthropic();
      if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) return openai();
      return null;
  }
}

export interface ClassifyHunksOptions {
  /** Repo root; enables the cache in <repoRoot>/.why-diff/cache.json */
  repoRoot?: string;
  /** Set false to bypass the cache even with repoRoot */
  cache?: boolean;
}

/**
 * Attach an intent verdict to every hunk. Cached verdicts are reused; the rest
 * go to the classifier in one call (it batches internally). Hunks the
 * classifier returns nothing for are marked `unclear` and are not cached, so a
 * later run tries them again. Returns new hunk objects; input is not mutated.
 */
export async function classifyHunks(
  hunks: AttributedHunk[],
  prompts: Prompt[],
  classifier: IntentClassifier,
  opts: ClassifyHunksOptions = {},
): Promise<AttributedHunk[]> {
  const cache = opts.repoRoot && opts.cache !== false ? await VerdictCache.load(cachePath(opts.repoRoot)) : undefined;
  const verdicts = new Map<string, IntentVerdict>();
  const keys = new Map<string, string>();
  const todo: AttributedHunk[] = [];

  for (const h of hunks) {
    const key = cacheKey(classifier.name, h);
    keys.set(h.hunk.id, key);
    const hit = cache?.get(key);
    if (hit) verdicts.set(h.hunk.id, hit);
    else todo.push(h);
  }

  if (todo.length > 0) {
    const fresh = await classifier.classify({ prompts, hunks: todo });
    for (const h of todo) {
      const v = fresh.get(h.hunk.id);
      if (!v) continue;
      verdicts.set(h.hunk.id, v);
      const key = keys.get(h.hunk.id);
      if (cache && key) cache.set(key, v);
    }
    await cache?.save();
  }

  const fallbackModel = classifier.name;
  return hunks.map((h) => ({
    ...h,
    intent: verdicts.get(h.hunk.id) ?? {
      verdict: 'unclear',
      reason: 'The classifier returned no valid verdict for this hunk.',
      model: fallbackModel,
    },
  }));
}

/** Count hunks per verdict, for `Summary.intent`. */
export function summarizeIntent(hunks: AttributedHunk[]): Record<Verdict, number> {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const h of hunks) if (h.intent) counts[h.intent.verdict]++;
  return counts;
}

export { ClaudeCliBackend, findOnPath } from './claude-cli.js';
export type { ProcessRunner, ProcessResult } from './claude-cli.js';
export { AnthropicBackend } from './anthropic.js';
export { OpenAiBackend } from './openai.js';
export {
  ClassifierCallError,
  ClassifierUnavailableError,
  LlmIntentClassifier,
  type CompletionBackend,
  type CompletionRequest,
} from './llm.js';
export {
  SYSTEM_PROMPT,
  VERDICTS,
  buildClassificationPrompt,
  parseVerdicts,
  planBatches,
  renderHunkDiff,
  type Verdict,
} from './prompt.js';
export { VerdictCache, cacheKey, cachePath } from './cache.js';
