/**
 * Backend for the Anthropic Messages API (`POST /v1/messages`) using global
 * fetch. Needs ANTHROPIC_API_KEY; the model defaults to `claude-haiku-4-5` and
 * can be overridden with WHY_DIFF_MODEL.
 */
import { ClassifierCallError, ClassifierUnavailableError, type CompletionBackend, type CompletionRequest } from './llm.js';
import { isRecord } from './prompt.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  /** Default https://api.anthropic.com (or $ANTHROPIC_BASE_URL) */
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class AnthropicBackend implements CompletionBackend {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    if (!opts.apiKey) throw new ClassifierUnavailableError('ANTHROPIC_API_KEY is not set.');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.maxTokens = opts.maxTokens ?? 4096;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const msg = isRecord(body) && isRecord(body.error) ? String(body.error.message) : res.statusText;
      const ErrorType = res.status === 401 || res.status === 403 ? ClassifierUnavailableError : ClassifierCallError;
      throw new ErrorType(`Anthropic API ${res.status}: ${msg}`);
    }
    if (!isRecord(body) || !Array.isArray(body.content)) {
      throw new ClassifierCallError('Anthropic API returned an unexpected body');
    }
    return body.content
      .filter((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
}
