/**
 * Secret redaction for the text that ends up in reports and in LLM requests:
 * prompts, agent rationales and edit bodies. Deliberately narrow so ordinary
 * prose stays readable: key-shaped tokens, `password=` style assignments, URLs
 * with embedded credentials, private key blocks and email addresses.
 */
import type { Report, ReportEdit } from './types.js';

export interface SecretRule {
  re: RegExp;
  name: string;
}

/** Well-known token formats. Shared with the `secret-like` label. */
export const SECRET_RULES: readonly SecretRule[] = [
  { re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, name: 'private key' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, name: 'AWS access key' },
  { re: /\bsk-(?:proj-|ant-(?:api\d\d-)?)?[A-Za-z0-9_-]{20,}/, name: 'API secret key (sk-)' },
  { re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/, name: 'Stripe live key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/, name: 'GitHub token' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/, name: 'GitLab token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, name: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, name: 'Google API key' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, name: 'npm token' },
];

const DOTS = '••••••••';
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** `scheme://user:password@host`; the password may itself contain `@` (the last `@` before the path wins). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/'"`@:]{1,100}:[^\s/'"`]{1,200}@/gi;
const JWT = /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g;
/** An Authorization header value: scheme is mandatory. */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[^\s"']{8,}/gi;
/** A bare `Bearer <token>` / `Basic <b64>`: needs a digit so prose like "Basic installation" is left alone. */
const BARE_SCHEME = /\b(Bearer|Basic)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/-]{8,}={0,2}/g;
/** A bare `Basic <b64>` with no digit: masked only when it is valid base64 of a printable `user:pass`. */
const BARE_BASIC = /\b(Basic)(\s+)([A-Za-z0-9+/]{12,}={0,2})(?![\w+/=-])/g;

function basicCredential(b64: string): boolean {
  const body = b64.replace(/=+$/, '');
  if (body.length % 4 === 1) return false;
  const buf = Buffer.from(body, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== body) return false;
  const text = buf.toString('latin1');
  return /^[\x20-\x7e]+$/.test(text) && /^[^:]+:./.test(text);
}
/**
 * `name <op> value`. The name is at most 60 chars and starts at a word start
 * (lookbehind), so scanning is linear. Whether the name is secret-sounding and
 * whether the value looks like a literal is decided in the callback.
 */
const NAME_VALUE = /(?<![\w.])((["']?)([A-Za-z_][\w.-]{0,60})\2\s*(:=|=>|===?|!==?|=|:)[ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`,;]+))/g;
/** An e-mail address; an scp-style remote (`git@host:owner/repo`, `user@host:~`, `user@host:/path`) is not one. */
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b(?![\w.-]*:(?:[\w.-]+\/[\w.-]+|~|\/))/g;
/** `mysql ... -pSECRET`: the password glued to -p (a bare `-p` prompts for it). */
const MYSQL_PASSWORD = /\b(mysql(?:dump|admin|import|show|check)?|mariadb(?:-dump)?)\b([^\n|;&]{0,200}?\s)-p(?=[^\s-])([^\s'"`]+)/g;
/** `curl -u user:password` / `--user user:password`. */
const CURL_USER = /\b(curl\b[^\n|;&]{0,300}?\s(?:-u|--user)(?:\s+|=)["']?[^\s:"'`]{1,100}:)([^\s"'`@]{1,200})/g;

const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'credential', 'credentials', 'apikey']);
/** Run-together names (DBPASSWORD, MYAPITOKEN): the keyword ends the name. */
const SECRET_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'credential', 'credentials'];

function nameSegments(name: string): string[] {
  return name.split(/[._-]+/).flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).map((x) => x.toLowerCase());
}

/** True when a name contains a secret keyword as a whole segment (split on _ . - and camelCase / acronyms). */
function secretName(segs: string[]): boolean {
  return segs.some((x, i) => SECRET_WORDS.has(x) || (x === 'api' && segs[i + 1] === 'key') || (x === 'private' && segs[i + 1] === 'key'));
}

/** A keyword ends the last segment of a run-together name, e.g. `dbpassword`. */
function secretSuffix(segs: string[]): boolean {
  const last = segs[segs.length - 1] ?? '';
  return SECRET_SUFFIXES.some((w) => last.endsWith(w));
}

/** Names that are a secret on their own; a dotted all-letter value after them is masked unless it reads as code. */
const EXACT_SECRET_NAMES = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret']);

/**
 * `password=foo.bar`, `DB_PASSWORD=my.dotted.word`: a dotted all-letter value after a secret name
 * is a literal only on a .env / CLI / config-shaped line. Redaction also runs on edit bodies, so
 * ordinary code (`const password = event.target.value;`, `password: input.value,`) must stay
 * as it is. Required: the name ends in an exact secret word; `name=value` with no spaces around
 * `=`, or a YAML `name: value` at the start of a line; no const/let/var/val/def before the name;
 * nothing but whitespace or the line end after the value; no known code root (`config.`,
 * `process.`, ...) and no secret-named last member (`user.password`).
 */
function dottedSecret(segs: string[], v: string, head: string, op: string, text: string, at: number, end: number): boolean {
  if (!EXACT_SECRET_NAMES.has(segs[segs.length - 1] ?? '')) return false;
  if (/\d/.test(v) || CODE_ROOTS.test(v)) return false;
  const last = v.slice(v.lastIndexOf('.') + 1);
  if (secretName(nameSegments(last)) || secretSuffix(nameSegments(last))) return false;
  if (!/^\s|^$/.test(text.slice(end, end + 1))) return false; // `;`, `,`, `)` ... after the value: code
  const back = text.slice(Math.max(0, at - 200), at);
  const prefix = back.slice(back.lastIndexOf('\n') + 1);
  if (/(?:^|[\s;({])(?:const|let|var|val|def)\s+$/.test(prefix)) return false;
  if (op === '=') return !/\s/.test(head);
  if (op === ':') return /^\s*(?:-\s+)?$/.test(prefix);
  return false;
}

const ENV_REF = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]*\}|\{\{.*\}\}|•+)$/;
const CALL = /^[A-Za-z_$][\w$.]*\(/;
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** Roots of obvious code references (`process.env.X2`), excluded even when they contain a digit. */
const CODE_ROOTS = /^(?:process|os|env|config|conf|settings|this|self|ctx|args|params|options|opts|vars|secrets|props|state|req|request)\./i;
const CODE_WORDS = new Set(['new', 'null', 'undefined', 'nil', 'none', 'true', 'false', 'this', 'self', 'await', 'async', 'function', 'return', 'require', 'string', 'number', 'boolean', 'any', 'unknown', 'str', 'int', 'bool', 'object', 'void', 'never', 'optional', 'required']);

/** Rules precise enough to run on source code: token formats, JWTs, auth headers, URL credentials, private keys. */
export function redactKeys(text: string): string {
  if (!text) return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, '-----PRIVATE KEY REDACTED-----');
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${DOTS}@`);
  out = out.replace(JWT, `eyJ${DOTS}`);
  out = out.replace(AUTH_HEADER, (_m, head: string) => `${head}${DOTS}`);
  out = out.replace(BARE_SCHEME, (_m, scheme: string, sp: string) => `${scheme}${sp}${DOTS}`);
  out = out.replace(MYSQL_PASSWORD, (_m, prog: string, mid: string) => `${prog}${mid}-p${DOTS}`);
  out = out.replace(CURL_USER, (_m, head: string) => `${head}${DOTS}`);
  out = out.replace(BARE_BASIC, (m, scheme: string, sp: string, b64: string) => (basicCredential(b64) ? `${scheme}${sp}${DOTS}` : m));
  for (const { re } of SECRET_RULES) {
    if (re.source.includes('PRIVATE KEY')) continue;
    out = out.replace(new RegExp(re.source, 'g'), (m) => `${m.slice(0, m.startsWith('sk-ant-') ? 7 : 4)}${DOTS}`);
  }
  return out;
}

/**
 * How much a dotted value after a secret name (`password = my.secret.pass`) is trusted to be code.
 * - `strict` (default): prompts, rationales, intent reasons, session titles, classifier input.
 *   Masked whatever the spacing and punctuation, unless it starts at a known code root or is a call.
 * - `code`: edit bodies and commands, where such lines are mostly code. Masked only on .env, CLI
 *   and YAML-shaped lines (see {@link dottedSecret}).
 */
export type RedactMode = 'strict' | 'code';

/** Code roots that keep a dotted value in strict mode (`password = body.pass` names a field, not a secret). */
const STRICT_CODE_ROOTS = /^(?:(?:process|config|env|os|self|this|settings|event|req|res|response|body)\.|e\.target\.)/i;

/**
 * Library modules whose values are mostly calls that fetch a secret (`getpass.getpass`). Only the
 * listed members are code; anything else after these roots (`vault.Xk93jQ2v`) is masked.
 */
const LIBRARY_ROOTS = /^(?:getpass|keyring|vault|secrets)\./i;
const LIBRARY_CALLS = new Set([
  'getpass.getpass', 'getpass.getuser',
  'keyring.get_password', 'keyring.get_credential', 'keyring.set_password', 'keyring.delete_password',
  'secrets.token_hex', 'secrets.token_urlsafe', 'secrets.token_bytes', 'secrets.choice', 'secrets.randbelow',
  'vault.read', 'vault.write',
]);

/** Extensions whose `name: Value` lines are configuration, never type annotations. */
const CONFIG_FILE = /(?:\.(?:ya?ml|env|ini|toml|properties|cfg|conf)$|(?:^|\/)\.env(?:\.[\w-]+)?$)/i;

function strictDotted(segs: string[], v: string): boolean {
  return EXACT_SECRET_NAMES.has(segs[segs.length - 1] ?? '') && !/\d/.test(v) && !STRICT_CODE_ROOTS.test(v);
}

/** Mask secrets in free text (prompts, rationales; `code` mode for edit bodies). Idempotent; ordinary text is returned unchanged. */
export function redactSecrets(text: string, mode: RedactMode = 'strict', opts: { file?: string } = {}): string {
  const configFile = opts.file !== undefined && CONFIG_FILE.test(opts.file);
  if (!text) return text;
  let out = redactKeys(text);
  out = out.replace(NAME_VALUE, (m: string, head: string, q: string, name: string, op: string, dq?: string, sq?: string, bare?: string, offset?: number, str?: string) => {
    if (op === '==' || op === '===' || op === '!=' || op === '!==') return m;
    const segs = nameSegments(name);
    const strong = secretName(segs) || /^[A-Z][A-Z0-9]*(?:PASSWORD|PASSWD|PASSPHRASE)$/.test(name);
    const quoted = dq ?? sq;
    if (quoted !== undefined) {
      if (quoted === '' || ENV_REF.test(quoted)) return m;
      if (!strong && !(secretSuffix(segs) && !/^\d+$/.test(quoted))) return m;
      const quote = dq !== undefined ? '"' : "'";
      return `${head}${quote}${DOTS}${quote}`;
    }
    // Closing brackets after the value belong to the code around it (`f(password=getpass.getpass)`).
    if (ENV_REF.test(bare ?? '')) return m;
    const v = (bare ?? '').replace(/[)\]}]+$/, '');
    const library = LIBRARY_ROOTS.test(v);
    if (library) {
      if (LIBRARY_CALLS.has(v.replace(/\($/, '').toLowerCase())) return m;
    } else if (ENV_REF.test(v) || CALL.test(v) || CODE_WORDS.has(v.toLowerCase())) return m;
    // Code: `token: Token;`, `f(secret: Buffer)`, `{ password: Password }`: a PascalCase, digit-free
    // value after `:` followed by code punctuation is a type. Never in a config file, and never at
    // the end of a line (`password: Hunter` is a YAML value).
    if (mode === 'code' && op === ':' && !configFile && /^[A-Z][a-z]+(?:[A-Z][a-z]*)*$/.test(v)) {
      const after = `${(bare ?? '').slice(v.length)}${(str ?? '').slice((offset ?? 0) + m.length, (offset ?? 0) + m.length + 200)}`;
      if (/^[ \t]*[;,)>|=}\]<[]/.test(after)) return m;
    }
    const dotted = MEMBER_PATH.test(v) && (mode === 'strict'
      ? strictDotted(segs, v)
      : dottedSecret(segs, v, head, op, str ?? '', offset ?? 0, (offset ?? 0) + m.length));
    if (!library && MEMBER_PATH.test(v) && (!/\d/.test(v) || CODE_ROOTS.test(v)) && !dotted) return m;
    if (!strong && !(secretSuffix(segs) && /^(?=.*\d)(?=.*[A-Za-z]).{8,}$/.test(v))) return m;
    // `name: word` is usually prose; an all-letter (or dotted all-letter) value needs a config-like line.
    if (op === ':' && /^[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(v) && !(mode === 'strict' && dotted)) {
      const text = str ?? '';
      const at = offset ?? 0;
      // Bounded look-around keeps this linear on very long lines.
      const WINDOW = 200;
      const back = text.slice(Math.max(0, at - WINDOW), at);
      const nl = back.lastIndexOf('\n');
      // No newline in the window: the line start is further back. Only whitespace all the way
      // through the window (deep YAML indentation) still counts as a config-like line start.
      const prefix = nl !== -1 ? back.slice(nl + 1) : at <= WINDOW || /^\s*$/.test(back) ? back : null;
      const configLike = q !== '' || (prefix !== null && /^[\s{,-]*$/.test(prefix));
      const after = at + m.length;
      const ahead = text.slice(after, after + WINDOW);
      const rest = ahead.split('\n', 1)[0] ?? '';
      if (!configLike || !/^\s*[,;}\]]?\s*$/.test(rest)) return m;
    }
    return `${head}${DOTS}`;
  });
  return out.replace(EMAIL, '[email redacted]');
}

const mapOpt = (v: string | null | undefined, f: (s: string) => string) => (typeof v === 'string' ? f(v) : v);

/**
 * A copy of the report with secrets masked in prompts, rationales and edit
 * bodies. Mode 'prompts' additionally removes all prompt text and rationales.
 */
export function redactReport(report: Report, mode: 'secrets' | 'prompts'): Report {
  const strip = mode === 'prompts';
  const text = (s: string) => redactSecrets(s);
  const code = (s: string, file?: string) => redactSecrets(s, 'code', file !== undefined ? { file } : {});
  const promptText = (p: { index: number; text: string }) => (strip ? `[prompt ${p.index + 1} redacted]` : text(p.text));
  const rationale = <T extends { rationale?: string }>(e: T): T => {
    const { rationale: r, ...rest } = e;
    return (strip || r === undefined ? rest : { ...rest, rationale: text(r) }) as T;
  };

  const edits: Record<string, ReportEdit> = {};
  for (const [id, e] of Object.entries(report.edits)) {
    const r = rationale(e);
    edits[id] = {
      ...r,
      oldText: mapOpt(r.oldText, (t) => code(t, r.filePath)) as string | null,
      newText: mapOpt(r.newText, (t) => code(t, r.filePath)) as string | null,
      ...(r.command !== undefined ? { command: code(r.command) } : {}),
    };
  }
  return {
    ...report,
    sessions: report.sessions.map((s) => (strip ? { ...s, title: undefined } : { ...s, ...(s.title !== undefined ? { title: text(s.title) } : {}) })),
    prompts: report.prompts.map((p) => ({ ...p, text: promptText(p) })),
    edits,
    hunks: report.hunks.map((h) => ({
      ...h,
      hunk: { ...h.hunk, lines: h.hunk.lines.map((l) => ({ ...l, text: redactKeys(l.text) })) },
      edits: h.edits.map(rationale),
      ...(h.intent ? { intent: { ...h.intent, reason: text(h.intent.reason) } } : {}),
      ...(h.prompt ? { prompt: { ...h.prompt, text: promptText(h.prompt) } } : {}),
    })),
  };
}
