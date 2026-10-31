import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicBackend,
  ClassifierUnavailableError,
  ClaudeCliBackend,
  LlmIntentClassifier,
  OpenAiBackend,
  buildClassificationPrompt,
  classifyHunks,
  createClassifier,
  parseVerdicts,
  planBatches,
  renderHunkDiff,
  summarizeIntent,
  type CompletionBackend,
  type CompletionRequest,
  type ProcessRunner,
} from '../src/classify/index.js';
import { parseClaudeCliOutput } from '../src/classify/claude-cli.js';
import type { AttributedHunk, DiffLine, FileEdit, IntentClassifier, IntentVerdict, Prompt } from '../src/types.js';

// ---------------------------------------------------------------- fixtures

function prompt(index: number, text: string, sessionId = 's1'): Prompt {
  return { id: `${sessionId}:${index}`, sessionId, harness: 'claude-code', index, at: `2026-10-31T10:0${index}:00Z`, text };
}

function edit(p: Prompt, rationale?: string): FileEdit {
  return {
    id: `${p.sessionId}:toolu_${p.index}:0`,
    sessionId: p.sessionId,
    harness: 'claude-code',
    toolUseId: `toolu_${p.index}`,
    tool: 'Edit',
    kind: 'edit',
    filePath: '/repo/src/x.ts',
    at: p.at,
    promptId: p.id,
    oldText: 'a',
    newText: 'b',
    rationale,
  };
}

function hunk(id: string, p: Prompt | undefined, lines: DiffLine[] = [{ type: 'add', text: `// ${id}` }], rationale?: string): AttributedHunk {
  return {
    hunk: {
      id,
      file: `src/${id}.ts`,
      status: 'modified',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      header: '@@ -1,1 +1,2 @@',
      lines,
    },
    match: p ? 'exact' : 'none',
    coverage: p ? 1 : 0,
    editIds: p ? [`${p.sessionId}:toolu_${p.index}:0`] : [],
    edits: p ? [edit(p, rationale)] : [],
    prompt: p,
    labels: [],
  };
}

/** Backend that answers from a script of canned responses and records requests. */
class ScriptedBackend implements CompletionBackend {
  readonly name = 'fake';
  readonly model = 'fake-1';
  readonly calls: CompletionRequest[] = [];
  constructor(private readonly answer: (req: CompletionRequest, call: number) => string | Error) {}
  async complete(req: CompletionRequest): Promise<string> {
    this.calls.push(req);
    const a = this.answer(req, this.calls.length);
    if (a instanceof Error) throw a;
    return a;
  }
}

/** Answer every ref in the request with the given verdict. */
function answerAll(req: CompletionRequest, verdict = 'requested'): string {
  const refs = [...req.user.matchAll(/^\[\[(h\d+)\]\]/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((r) => [r, { verdict, reason: `because ${r}` }])));
}

const p0 = prompt(0, 'add a --json flag to the export command');
const p1 = prompt(1, 'also fix the off-by-one in paginate()');

// ---------------------------------------------------------------- prompt.ts

describe('planBatches', () => {
  it('groups by prompt and caps batch size', () => {
    const hs = [hunk('h1', p0), hunk('h2', p1), hunk('h3', p0), hunk('h4', p1), hunk('h5', undefined)];
    const batches = planBatches(hs, 3);
    expect(batches.map((b) => b.map((h) => h.hunk.id))).toEqual([['h1', 'h3'], ['h2', 'h4', 'h5']]);
  });

  it('splits a group larger than the cap', () => {
    const hs = Array.from({ length: 60 }, (_, i) => hunk(`h${i}`, p0));
    const sizes = planBatches(hs).map((b) => b.length);
    expect(sizes).toEqual([25, 25, 10]);
  });
});

describe('renderHunkDiff', () => {
  it('elides the middle of long hunks', () => {
    const lines: DiffLine[] = Array.from({ length: 200 }, (_, i) => ({ type: 'add', text: `line ${i}` }));
    const out = renderHunkDiff(hunk('h1', p0, lines).hunk).split('\n');
    expect(out).toHaveLength(61); // header + 60
    expect(out[0]).toBe('@@ -1,1 +1,2 @@');
    expect(out.some((l) => /\[\d+ lines elided\]/.test(l))).toBe(true);
    expect(out.at(-1)).toBe('+line 199');
  });

  it('prefixes lines with diff signs', () => {
    const out = renderHunkDiff(
      hunk('h1', p0, [
        { type: 'ctx', text: 'a' },
        { type: 'del', text: 'b' },
        { type: 'add', text: 'c' },
      ]).hunk,
    );
    expect(out.split('\n').slice(1)).toEqual([' a', '-b', '+c']);
  });
});

describe('buildClassificationPrompt', () => {
  it('uses reference ids, marks the linked prompt and maps refs back', () => {
    const other = prompt(0, 'unrelated session prompt', 's2');
    const built = buildClassificationPrompt([p0, p1, other], [hunk('h7', p1, undefined, 'Fix the loop bound.')]);
    expect(built.user).toContain('[[p0]] add a --json flag');
    expect(built.user).toContain('[[p1]] (linked) also fix the off-by-one');
    expect(built.user).not.toContain('unrelated session prompt');
    expect(built.user).toContain('[[h1]] file: src/h7.ts');
    expect(built.user).toContain('linked prompt: [[p1]]');
    expect(built.user).toContain('agent rationale: Fix the loop bound.');
    expect(built.refs.get('h1')).toBe('h7');
    expect(built.system).toContain('"verdict":"requested|implied|unrequested|unclear"');
  });

  it('handles hunks with no linked prompt', () => {
    const built = buildClassificationPrompt([p0], [hunk('h1', undefined)]);
    expect(built.user).toContain('linked prompt: none');
  });
});

describe('parseVerdicts', () => {
  it('parses fenced JSON with prose and odd keys', () => {
    const text = 'Sure!\n```json\n{"[[h1]]":{"verdict":"Implied","reason":"needed {import}"},"h2":"unrequested"}\n```';
    const { verdicts, missing } = parseVerdicts(text, ['h1', 'h2', 'h3']);
    expect(verdicts.get('h1')).toEqual({ verdict: 'implied', reason: 'needed {import}' });
    expect(verdicts.get('h2')?.verdict).toBe('unrequested');
    expect(missing).toEqual(['h3']);
  });

  it('treats invalid verdicts and garbage as missing', () => {
    expect(parseVerdicts('{"h1":{"verdict":"maybe"}}', ['h1']).missing).toEqual(['h1']);
    expect(parseVerdicts('not json at all {', ['h1']).missing).toEqual(['h1']);
  });

  it('clips long reasons', () => {
    const { verdicts } = parseVerdicts(JSON.stringify({ h1: { verdict: 'unclear', reason: 'x'.repeat(500) } }), ['h1']);
    expect(verdicts.get('h1')?.reason.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------- llm.ts

describe('LlmIntentClassifier', () => {
  it('classifies and maps verdicts to hunk ids with the model name', async () => {
    const backend = new ScriptedBackend((req) => answerAll(req, 'implied'));
    const c = new LlmIntentClassifier(backend);
    const out = await c.classify({ prompts: [p0], hunks: [hunk('h9', p0), hunk('h10', p0)] });
    expect(out.get('h9')).toEqual({ verdict: 'implied', reason: 'because h1', model: 'fake-1' });
    expect(out.get('h10')?.reason).toBe('because h2');
    expect(backend.calls).toHaveLength(1);
    expect(c.name).toBe('fake:fake-1');
  });

  it('retries once with only the missing hunks after a partial answer', async () => {
    const backend = new ScriptedBackend((req, call) =>
      call === 1 ? '{"h1":{"verdict":"requested","reason":"ok"}} trailing' : answerAll(req, 'unrequested'),
    );
    const out = await new LlmIntentClassifier(backend).classify({ prompts: [p0], hunks: [hunk('a', p0), hunk('b', p0)] });
    expect(out.get('a')?.verdict).toBe('requested');
    expect(out.get('b')?.verdict).toBe('unrequested');
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]?.user).toContain('[[h1]] file: src/b.ts');
    expect(backend.calls[1]?.user).toContain('previous answer was not valid JSON');
  });

  it('gives up after one retry and leaves hunks out', async () => {
    const backend = new ScriptedBackend(() => 'I cannot do that');
    const out = await new LlmIntentClassifier(backend).classify({ prompts: [p0], hunks: [hunk('a', p0)] });
    expect(out.size).toBe(0);
    expect(backend.calls).toHaveLength(2);
  });

  it('retries a thrown call error but not an unavailable backend', async () => {
    const flaky = new ScriptedBackend((req, call) => (call === 1 ? new Error('boom') : answerAll(req)));
    expect((await new LlmIntentClassifier(flaky).classify({ prompts: [p0], hunks: [hunk('a', p0)] })).size).toBe(1);

    const dead = new ScriptedBackend(() => new ClassifierUnavailableError('no key'));
    await expect(new LlmIntentClassifier(dead).classify({ prompts: [p0], hunks: [hunk('a', p0)] })).rejects.toThrow('no key');
    expect(dead.calls).toHaveLength(1);
  });

  it('splits work into batches of at most 25', async () => {
    const backend = new ScriptedBackend((req) => answerAll(req));
    const hs = Array.from({ length: 30 }, (_, i) => hunk(`x${i}`, i % 2 ? p0 : p1));
    const out = await new LlmIntentClassifier(backend, { concurrency: 3 }).classify({ prompts: [p0, p1], hunks: hs });
    expect(out.size).toBe(30);
    expect(backend.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- classifyHunks + cache

describe('classifyHunks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'why-diff-classify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Fake classifier that only knows some hunks. */
  function fakeClassifier(known: Record<string, IntentVerdict['verdict']>): IntentClassifier & { seen: string[][] } {
    const seen: string[][] = [];
    return {
      name: 'fake',
      seen,
      async classify({ hunks }) {
        seen.push(hunks.map((h) => h.hunk.id));
        const m = new Map<string, IntentVerdict>();
        for (const h of hunks) {
          const v = known[h.hunk.id];
          if (v) m.set(h.hunk.id, { verdict: v, reason: 'r', model: 'fake' });
        }
        return m;
      },
    };
  }

  it('sets intent, marks missing as unclear and does not mutate input', async () => {
    const input = [hunk('a', p0), hunk('b', p1)];
    const out = await classifyHunks(input, [p0, p1], fakeClassifier({ a: 'requested' }));
    expect(out[0]?.intent?.verdict).toBe('requested');
    expect(out[1]?.intent?.verdict).toBe('unclear');
    expect(out[1]?.intent?.reason).toMatch(/no valid verdict/);
    expect(input[0]?.intent).toBeUndefined();
    expect(summarizeIntent(out)).toEqual({ requested: 1, implied: 0, unrequested: 0, unclear: 1 });
  });

  it('caches real verdicts on disk and reuses them, but not fallbacks', async () => {
    const hs = [hunk('a', p0), hunk('b', p1)];
    const first = fakeClassifier({ a: 'implied' });
    await classifyHunks(hs, [p0, p1], first, { repoRoot: dir });
    const file = JSON.parse(await readFile(join(dir, '.why-diff', 'cache.json'), 'utf8')) as { entries: object };
    expect(Object.keys(file.entries)).toHaveLength(1);

    const second = fakeClassifier({ a: 'unrequested', b: 'requested' });
    const out = await classifyHunks(hs, [p0, p1], second, { repoRoot: dir });
    expect(second.seen).toEqual([['b']]); // `a` came from the cache
    expect(out[0]?.intent?.verdict).toBe('implied');
    expect(out[1]?.intent?.verdict).toBe('requested');
  });

  it('invalidates the cache when the prompt text changes', async () => {
    await classifyHunks([hunk('a', p0)], [p0], fakeClassifier({ a: 'implied' }), { repoRoot: dir });
    const changed = prompt(0, 'something else entirely');
    const c = fakeClassifier({ a: 'unrequested' });
    const out = await classifyHunks([hunk('a', changed)], [changed], c, { repoRoot: dir });
    expect(c.seen).toEqual([['a']]);
    expect(out[0]?.intent?.verdict).toBe('unrequested');
  });
});

// ---------------------------------------------------------------- backends

describe('ClaudeCliBackend', () => {
  it('runs claude headless with the prompt on stdin and returns .result', async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({ type: 'result', is_error: false, result: '{"h1":{"verdict":"requested","reason":"x"}}' }),
      stderr: '',
      code: 0,
    }));
    const b = new ClaudeCliBackend({ runner, bin: '/bin/claude' });
    const text = await b.complete({ system: 'SYS', user: 'USER' });
    expect(text).toContain('"h1"');
    const [file, args, input] = runner.mock.calls[0] ?? [];
    expect(file).toBe('/bin/claude');
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1']));
    expect(args?.[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(input).toBe('USER');
  });

  it('surfaces error results and non-zero exits', async () => {
    const err = new ClaudeCliBackend({
      runner: async () => ({ stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }), stderr: '', code: 1 }),
    });
    await expect(err.complete({ system: '', user: '' })).rejects.toThrow('Not logged in');
    const crash = new ClaudeCliBackend({ runner: async () => ({ stdout: '', stderr: 'segfault', code: 139 }) });
    await expect(crash.complete({ system: '', user: '' })).rejects.toThrow(/code 139: segfault/);
  });

  it('falls back to minimal flags on an older CLI', async () => {
    const runner = vi.fn<ProcessRunner>(async (_f, args, input) =>
      args.includes('--safe-mode')
        ? { stdout: '', stderr: "error: unknown option '--safe-mode'", code: 1 }
        : { stdout: JSON.stringify({ is_error: false, result: input }), stderr: '', code: 0 },
    );
    const b = new ClaudeCliBackend({ runner });
    expect(await b.complete({ system: 'SYS', user: 'USER' })).toBe('SYS\n\n---\n\nUSER');
    expect(await b.complete({ system: 'SYS', user: 'U2' })).toContain('U2');
    expect(runner).toHaveBeenCalledTimes(3); // the flag probe is not repeated
  });

  it('parses JSON-lines output', () => {
    const out = ['{"type":"system"}', '{"type":"result","is_error":false,"result":"ok"}'].join('\n');
    expect(parseClaudeCliOutput(out)).toBe('ok');
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AnthropicBackend', () => {
  it('posts to /v1/messages with the right headers and joins text blocks', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: '{"h1":' }, { type: 'text', text: '"implied"}' }] }),
    );
    const b = new AnthropicBackend({ apiKey: 'sk-test', fetch: fetchMock });
    expect(await b.complete({ system: 'S', user: 'U' })).toBe('{"h1":"implied"}');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body)) as { model: string; system: string; messages: unknown[] };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.system).toBe('S');
    expect(body.messages).toEqual([{ role: 'user', content: 'U' }]);
  });

  it('maps auth failures to ClassifierUnavailableError', async () => {
    const b = new AnthropicBackend({
      apiKey: 'bad',
      fetch: async () => jsonResponse(401, { error: { message: 'invalid x-api-key' } }),
    });
    await expect(b.complete({ system: '', user: '' })).rejects.toBeInstanceOf(ClassifierUnavailableError);
  });
});

describe('OpenAiBackend', () => {
  it('calls chat/completions on a custom base URL without a key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { choices: [{ message: { content: '{}' } }] }));
    const b = new OpenAiBackend({ baseUrl: 'http://localhost:11434/v1/', model: 'llama3.1', fetch: fetchMock });
    expect(await b.complete({ system: 'S', user: 'U' })).toBe('{}');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('requires a key for the default OpenAI endpoint', () => {
    expect(() => new OpenAiBackend({})).toThrow(ClassifierUnavailableError);
  });
});

describe('createClassifier', () => {
  const emptyPath = { PATH: '/nonexistent-why-diff' };

  it('returns null for none and for auto without any backend', () => {
    expect(createClassifier('none')).toBeNull();
    expect(createClassifier('auto', { env: emptyPath })).toBeNull();
  });

  it('auto prefers claude CLI, then Anthropic, then OpenAI', () => {
    expect(createClassifier('auto', { env: emptyPath, runner: async () => ({ stdout: '', stderr: '', code: 0 }) })?.name).toBe(
      'claude-cli:haiku',
    );
    expect(createClassifier('auto', { env: { ...emptyPath, ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' } })?.name).toBe(
      'anthropic:claude-haiku-4-5',
    );
    expect(createClassifier('auto', { env: { ...emptyPath, OPENAI_API_KEY: 'o', WHY_DIFF_MODEL: 'gpt-x' } })?.name).toBe(
      'openai:gpt-x',
    );
  });

  it('throws a clear error when an explicit backend is unavailable', () => {
    expect(() => createClassifier('claude-cli', { env: emptyPath })).toThrow(/not on PATH/);
    expect(() => createClassifier('anthropic', { env: emptyPath })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('wires the claude CLI end to end', async () => {
    const runner: ProcessRunner = async (_f, _a, input) => ({
      stdout: JSON.stringify({ is_error: false, result: answerAll({ system: '', user: input }, 'unrequested') }),
      stderr: '',
      code: 0,
    });
    const c = createClassifier('claude-cli', { runner, model: 'sonnet' });
    expect(c).not.toBeNull();
    const out = await classifyHunks([hunk('a', p0)], [p0], c as IntentClassifier);
    expect(out[0]?.intent).toEqual({ verdict: 'unrequested', reason: 'because h1', model: 'sonnet' });
  });
});
