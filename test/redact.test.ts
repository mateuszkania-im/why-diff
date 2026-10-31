import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AttributedHunk, Report } from '../src/types.js';
import { redactReport, redactSecrets } from '../src/redact.js';
import { renderReport } from '../src/report/index.js';
import { buildClassificationPrompt } from '../src/classify/prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample: Report = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-report.json'), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('redactSecrets', () => {
  it('keeps the public prefix of an API key and masks the rest', () => {
    const out = redactSecrets('use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz now');
    expect(out).toContain('sk-ant-');
    expect(out).not.toContain('abcdefghij');
    expect(out).toContain('•');
    expect(out.endsWith(' now')).toBe(true);
  });
  it('masks password assignments and URL credentials', () => {
    expect(redactSecrets('password=hunter2xyz')).not.toContain('hunter2xyz');
    const url = redactSecrets('DATABASE_URL=postgres://admin:Hunter2Secret@db.internal.acme.com/prod');
    expect(url).not.toContain('Hunter2Secret');
    expect(url).not.toContain('admin');
    expect(url).toContain('db.internal.acme.com/prod');
    expect(redactSecrets('DATABASE_URL=postgres://u:p@h/db')).not.toContain('u:p');
  });
  it('masks email addresses', () => {
    const out = redactSecrets('customer jan.kowalski@client.pl called');
    expect(out).not.toContain('kowalski');
    expect(out).toContain('called');
  });
  it('masks private key blocks', () => {
    const out = redactSecrets('k:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\nok');
    expect(out).not.toContain('MIIEabc');
    expect(out.endsWith('ok')).toBe(true);
  });
  it('leaves ordinary text alone and is idempotent', () => {
    const t = 'Fix the token refresh in auth.ts, then add a password field to the form. See https://example.com/a?b=c';
    expect(redactSecrets(t)).toBe(t);
    const once = redactSecrets('password=hunter2xyz and sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(redactSecrets(once)).toBe(once);
  });
});

function leaky(): Report {
  const r = clone(sample);
  const secret = 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  r.prompts[0]!.text = `fix login, key ${secret}`;
  const h = r.hunks[0] as AttributedHunk;
  h.prompt = { ...r.prompts[0]! };
  if (h.edits[0]) h.edits[0].rationale = `used ${secret}`;
  const id = Object.keys(r.edits)[0]!;
  r.edits[id] = { ...r.edits[id]!, newText: `k = "${secret}"`, command: `curl -H "x: ${secret}"`, rationale: `used ${secret}` };
  return r;
}

describe('redactReport', () => {
  it.each(['md', 'json', 'html'] as const)('secrets mode removes the key from %s output', (fmt) => {
    const out = renderReport(redactReport(leaky(), 'secrets'), fmt, { verbose: true });
    expect(out).not.toContain('XXXX');
    expect(out).toContain('sk-ant-');
  });
  it('does not mutate the input', () => {
    const r = leaky();
    redactReport(r, 'secrets');
    expect(r.prompts[0]!.text).toContain('XXXX');
  });
  it('prompts mode drops all prompt text and rationales', () => {
    const r = leaky();
    const red = redactReport(r, 'prompts');
    expect(red.prompts[0]!.text).toMatch(/^\[prompt \d+ redacted\]$/);
    const json = renderReport(red, 'json');
    expect(json).not.toContain('fix login');
    expect(json).not.toContain('XXXX');
    expect(JSON.stringify(red.hunks.flatMap((h) => h.edits.map((e) => e.rationale)).filter(Boolean))).toBe('[]');
    expect(Object.values(red.edits).every((e) => e.rationale === undefined)).toBe(true);
    for (const fmt of ['md', 'html', 'terminal'] as const) {
      expect(renderReport(red, fmt, { verbose: true })).not.toContain('fix login');
    }
  });
});

describe('classifier input', () => {
  it('does not send secrets from prompts or rationales to the model', () => {
    const r = leaky();
    const h = r.hunks[0] as AttributedHunk;
    const built = buildClassificationPrompt([r.prompts[0]!], [h]);
    expect(built.user).not.toContain('XXXX');
  });
});

describe('redactSecrets: ordinary code stays unchanged', () => {
  it.each([
    'max_tokens=4096',
    'if (token == x) go()',
    'if (token === other) go()',
    'const tokenizer = new Tokenizer()',
    'const secretary = hire(person)',
    'password=$ENV_PASS',
    'password=${DB_PASSWORD}',
    'the token: it expires daily',
    'set tokenCount = items.length',
    'passwordField = render(input)',
  ])('%s', (t) => {
    expect(redactSecrets(t)).toBe(t);
  });
});

describe('redactSecrets: more secret shapes', () => {
  it.each([
    ['password="hunter 2 x"', 'hunter'],
    ["password = 'my secret phrase'", 'phrase'],
    ['{"apiKey": "abcd1234efgh"}', 'abcd1234efgh'],
    ['api_key: abcd1234efgh', 'abcd1234efgh'],
    ['token := "abcd1234efgh"', 'abcd1234efgh'],
    ["secret => 'abcd1234efgh'", 'abcd1234efgh'],
    ['Authorization: Bearer abcDEF123456xyz', 'abcDEF123456xyz'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fw ok', 'SflKxwRJSMeKKF2QT4fw'],
    ['postgres://u:p@ss@host/db', 'ss@'],
    ['password=$ecret123', 'ecret123'],
    ['--token=abc123def', 'abc123def'],
  ])('%s', (t, leak) => {
    expect(redactSecrets(t)).not.toContain(leak);
  });
  it('keeps the host of a URL with an @ in the password', () => {
    expect(redactSecrets('postgres://u:p@ss@host/db')).toContain('host/db');
  });
});

describe('redactSecrets: performance', () => {
  it.each(['a.', 'a-', 'ab_', 'token '])('200 KB of %j is fast', (unit) => {
    const input = unit.repeat(Math.ceil(200_000 / unit.length));
    const t0 = performance.now();
    redactSecrets(input);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('redaction of diff lines and intent reasons', () => {
  it.each(['md', 'json', 'html'] as const)('diff line key is masked in %s', (fmt) => {
    const r = clone(sample);
    r.hunks[0]!.hunk.lines.push({ type: 'add', text: 'const k = "sk-ant-api03-XXXXXXXXXXXXXXXXXXXX"', newNo: 999 });
    const out = renderReport(redactReport(r, 'secrets'), fmt, { verbose: true });
    expect(out).not.toContain('XXXXXXXX');
  });
  it('does not mask assignments inside diff lines', () => {
    const r = clone(sample);
    r.hunks[0]!.hunk.lines.push({ type: 'add', text: 'password = readInput()', newNo: 999 });
    expect(JSON.stringify(redactReport(r, 'secrets'))).toContain('password = readInput()');
  });
  it('masks secrets quoted in an intent reason', () => {
    const r = clone(sample);
    r.hunks[0]!.intent = { verdict: 'unclear', reason: 'prompt said password=hunter2xyz', model: 'm' };
    expect(JSON.stringify(redactReport(r, 'prompts'))).not.toContain('hunter2xyz');
  });
});

describe('redactSecrets: round 2', () => {
  it.each([
    ['password=hunter2', 'hunter2'],
    ['pwd=abc123', 'abc123'],
    ['password: hunter2', 'hunter2'],
    ['token: abc123', 'abc123'],
    ['secret := x9', 'x9'],
    ['password=p.ss.w0rd', 'p.ss.w0rd'],
    ['token=YWJjZGVmZ2g=', 'YWJjZGVmZ2g'],
    ['DBPASSWORD="x"', '"x"'],
    ['AWSSecretKey: "abcdEFGH1234"', 'abcdEFGH1234'],
    ['MYAPITOKEN=abc12345', 'abc12345'],
    ['password: hunter', 'hunter'],
    [`password = "${'a'.repeat(300)}b1"`, 'aaaaaaaaaa'],
    ['{"password": "x", "n": 1}', '"x"'],
  ])('masks %s', (t, leak) => {
    expect(redactSecrets(t)).not.toContain(leak);
  });
  it.each([
    'max_tokens=4096',
    'max_tokens: "4096"',
    'const tokenizer = new Tokenizer()',
    'secretary = hire(p)',
    'tokenCount = items.length',
    'password=process.env.DB_PASS',
    'password = config.db.password',
    'password = getPassword()',
    'token = new Token()',
    'password: string;',
    'token: null',
    'the token: it expires daily',
    'Note the token: expires soon, refresh it',
  ])('keeps %s', (t) => {
    expect(redactSecrets(t)).toBe(t);
  });
  it.each(['a:"', "a:'a ", 'password="', 'a=" b', 'token:a ', '{token:a ', 'token:a,', '{"token":a '])('200 KB of %j is fast', (unit) => {
    const input = unit.repeat(Math.ceil(200_000 / unit.length));
    const t0 = performance.now();
    redactSecrets(input);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('redactSecrets: residuals (0.2.1)', () => {
  it('masks `password: word` after more than 200 characters of leading whitespace', () => {
    const t = `${' '.repeat(250)}password: hunter`;
    expect(redactSecrets(t)).not.toContain('hunter');
    const nl = `config:\n${' '.repeat(250)}password: hunter`;
    expect(redactSecrets(nl)).not.toContain('hunter');
  });
  it('keeps prose with more than 200 characters before `token: word` on the same line', () => {
    const t = `${'some words here '.repeat(15)}the token: expires`;
    expect(redactSecrets(t)).toBe(t);
  });
  it.each([
    ['password=foo.bar', 'foo.bar'],
    ['pwd=alpha.beta', 'alpha.beta'],
    ['secret=open.sesame', 'open.sesame'],
    ['passwd = "x" ; passwd=correct.horse', 'correct.horse'],
  ])('masks a dotted all-letter value after an exact secret name: %s', (t, leak) => {
    expect(redactSecrets(t)).not.toContain(leak);
  });
  it.each([
    'password = config.db.password',
    'password=process.env.DB_PASS',
    'password = settings.password',
    'password = this.password',
    'password = os.environ.get',
    'password = user.password',
    'password = form.values.password',
    'password = hash.update(x)',
    'apiVersion = foo.bar',
  ])('keeps code references: %s', (t) => {
    expect(redactSecrets(t)).toBe(t);
  });
  it('masks a bare Basic credential without digits when it decodes to user:pass', () => {
    expect(Buffer.from('dXNlcjpwYXNz', 'base64').toString()).toBe('user:pass');
    expect(redactSecrets('curl -H "Basic dXNlcjpwYXNz" https://x')).not.toContain('dXNlcjpwYXNz');
    expect(redactSecrets('Basic YWRtaW46c2VjcmV0')).not.toContain('YWRtaW46c2VjcmV0');
  });
  it.each([
    'Basic installation steps are in the README',
    'Basic authentication is supported',
    'Basic configuration',
    'Basic HelloWorldExample',
  ])('keeps prose: %s', (t) => {
    expect(redactSecrets(t)).toBe(t);
  });
});
