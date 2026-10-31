/**
 * Backend for any OpenAI-compatible Chat Completions endpoint
 * (`POST {base}/chat/completions`): OpenAI, Azure-style proxies, Ollama
 * (`OPENAI_BASE_URL=http://localhost:11434/v1`), LM Studio, vLLM, ...
 * The API key is optional so local servers work without one.
 */
import { ClassifierCallError, ClassifierUnavailableError, type CompletionBackend, type CompletionRequest } from './llm.js';
import { isRecord } from './prompt.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiOptions {
  apiKey?: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAiBackend implements CompletionBackend {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    if (!this.apiKey && this.baseUrl === DEFAULT_OPENAI_BASE_URL) {
      throw new ClassifierUnavailableError('OPENAI_API_KEY is not set (or point OPENAI_BASE_URL at a local server).');
    }
    this.model = opts.model ?? DEFAULT_OPENAI_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const msg = isRecord(body) && isRecord(body.error) ? String(body.error.message) : res.statusText;
      const ErrorType = res.status === 401 || res.status === 403 ? ClassifierUnavailableError : ClassifierCallError;
      throw new ErrorType(`OpenAI-compatible API ${res.status}: ${msg}`);
    }
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const content = isRecord(choice) && isRecord(choice.message) ? choice.message.content : undefined;
    if (typeof content !== 'string') throw new ClassifierCallError('OpenAI-compatible API returned no message content');
    return content;
  }
}
