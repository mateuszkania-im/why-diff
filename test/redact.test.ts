import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bestOf, expectScalesSubQuadratically } from './helpers/perf.js';
import type { AttributedHunk, Report } from '../src/types.js';
import { redactKeys, redactReport, redactSecrets, SECRET_RULES } from '../src/redact.js';
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

/** 200 KB of `unit` within a generous ceiling, and 4x the input (50 KB -> 200 KB) at most 10x the time. */
function expectFastAndLinear(unit: string): void {
  const small = unit.repeat(Math.ceil(50_000 / unit.length));
  const large = unit.repeat(Math.ceil(200_000 / unit.length));
  expect(bestOf(() => redactSecrets(large), 3)).toBeLessThan(1000);
  expectScalesSubQuadratically(() => redactSecrets(small), () => redactSecrets(large));
}

describe('redactSecrets: performance', () => {
  it.each(['a.', 'a-', 'ab_', 'token ', 'Basic ', 'Basic dXNlcjpwYXNz '])('200 KB of %j is fast and scales sub-quadratically', (unit) => {
    expectFastAndLinear(unit);
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
  it.each(['a:"', "a:'a ", 'password="', 'a=" b', 'token:a ', '{token:a ', 'token:a,', '{"token":a '])('200 KB of %j is fast and scales sub-quadratically', (unit) => {
    expectFastAndLinear(unit);
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
    ['DB_PASSWORD=my.dotted.word', 'my.dotted.word'],
    ['export PASSWORD=foo.bar', 'foo.bar'],
    ['  password: foo.bar', 'foo.bar'],
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
    'const password = event.target.value;',
    'const password = e.target.value;',
    'password: input.value,',
    'secret = response.data',
    'pwd = path.sep',
    'password = body.pass',
    'const secret = crypto.webcrypto',
    'let password=form.value;',
  ])('keeps code references in code mode (edit bodies): %s', (t) => {
    expect(redactSecrets(t, 'code')).toBe(t);
  });
  it.each([
    ['use password = my.secret.pass; then deploy', 'my.secret.pass'],
    ['password: hunter.two, and', 'hunter.two'],
    ['set pwd=alpha.beta, then run', 'alpha.beta'],
    ['the secret is secret = open.sesame;', 'open.sesame'],
  ])('strict mode (prompts, the default) masks dotted values whatever the shape: %s', (t, leak) => {
    expect(redactSecrets(t)).not.toContain(leak);
    expect(redactSecrets(t, 'strict')).not.toContain(leak);
  });
  it.each([
    'password = body.pass',
    'password = event.target.value',
    'password = e.target.value;',
    'secret = response.data',
    'password = req.body',
    'password = config.db.password',
    'password = getPassword()',
  ])('strict mode keeps code roots and calls: %s', (t) => {
    expect(redactSecrets(t)).toBe(t);
  });
  it('redactReport masks prompts strictly and edit bodies in code mode', () => {
    const report = {
      prompts: [{ id: 'p', index: 0, text: 'use password = my.secret.pass; then deploy' }],
      sessions: [],
      edits: { e: { id: 'e', oldText: null, newText: 'const password = e.target.value;', command: 'echo ok' } },
      hunks: [],
    } as unknown as Report;
    const out = redactReport(report, 'secrets');
    expect(out.prompts[0]?.text).not.toContain('my.secret.pass');
    expect(out.edits.e?.newText).toBe('const password = e.target.value;');
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

describe('redactSecrets: audit 2', () => {
  it.each(['strict', 'code'] as const)('keeps module.function references after a secret name (%s)', (mode) => {
    for (const t of ['db.connect(user="x", password=getpass.getpass)', 'password = getpass.getpass()', 'token=keyring.get_password', 'secret = vault.read', 'password=secrets.token_hex', 'password=os.environ']) {
      expect(redactSecrets(t, mode), t).toBe(t);
    }
  });

  it('keeps type annotations in code mode', () => {
    for (const t of ['interface Auth {\n  token: Token;\n  password: Password;\n  secret: Buffer;\n}', 'def login(password: str) -> None:', 'class A:\n    password: str\n', 'type T = { token: AccessToken, secret: SecretBox | null }']) {
      expect(redactSecrets(t, 'code'), t).toBe(t);
    }
  });

  it('does not treat an scp-style git remote as an e-mail address, but still masks e-mail addresses', () => {
    expect(redactSecrets('git clone git@github.com:acme/repo.git')).toBe('git clone git@github.com:acme/repo.git');
    expect(redactSecrets('deploy to deploy@web1.example.com:/var/www')).toBe('deploy to deploy@web1.example.com:/var/www');
    expect(redactSecrets('Contact ops@acme.com: thanks')).toBe('Contact [email redacted]: thanks');
  });

  it('masks a PGP private key block and labels it', () => {
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFsecretmaterial\n-----END PGP PRIVATE KEY BLOCK-----';
    for (const mode of ['strict', 'code'] as const) expect(redactSecrets(block, mode)).not.toContain('lQOYBF');
    expect(redactKeys(block)).not.toContain('lQOYBF');
    expect(SECRET_RULES.some((r) => r.re.test('-----BEGIN PGP PRIVATE KEY BLOCK-----'))).toBe(true);
  });

  it.each(['strict', 'code'] as const)('masks credentials on mysql, curl and PGPASSWORD command lines (%s)', (mode) => {
    expect(redactSecrets('mysql -u root -phunter2 db', mode)).not.toContain('hunter2');
    expect(redactSecrets('mysqldump -h db -u root -pS3cr3t app', mode)).not.toContain('S3cr3t');
    expect(redactSecrets('curl -u admin:S3cretPass https://x', mode)).not.toContain('S3cretPass');
    expect(redactSecrets('curl --user admin:S3cretPass https://x', mode)).toContain('admin:');
    expect(redactSecrets('curl --user admin:S3cretPass https://x', mode)).not.toContain('S3cretPass');
    expect(redactSecrets('PGPASSWORD=x psql -h db', mode)).not.toMatch(/PGPASSWORD=x\b/);
    expect(redactSecrets('export PGPASSWORD=hunter', mode)).not.toContain('hunter');
  });

  it('leaves look-alike command lines alone', () => {
    for (const t of ['docker run -u 1000:1000 app', 'git push -u origin main', 'mysql -p db', 'ssh -p 2222 host', 'grep -pattern file']) {
      expect(redactSecrets(t), t).toBe(t);
      expect(redactSecrets(t, 'code'), t).toBe(t);
    }
  });

  it.each(['mysql -phunter2 ', 'curl -u a:b ', 'git@github.com:', 'password=getpass.getpass ', 'token: Token;\n', 'PGPASSWORD=x ', 'curl '])('200 KB of %j is fast and scales sub-quadratically', (unit) => {
    expectFastAndLinear(unit);
    const small = unit.repeat(Math.ceil(50_000 / unit.length));
    const large = unit.repeat(Math.ceil(200_000 / unit.length));
    expectScalesSubQuadratically(() => redactSecrets(small, 'code'), () => redactSecrets(large, 'code'));
  });
});
