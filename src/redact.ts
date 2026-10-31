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
  { re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, name: 'private key' },
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
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g;
/** `scheme://user:password@host`; the password may itself contain `@` (the last `@` before the path wins). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/'"`@:]{1,100}:[^\s/'"`]{1,200}@/gi;
const JWT = /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g;
/** An Authorization header value: scheme is mandatory. */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[^\s"']{8,}/gi;
/** A bare `Bearer <token>` / `Basic <b64>`: needs a digit so prose like "Basic installation" is left alone. */
const BARE_SCHEME = /\b(Bearer|Basic)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/-]{8,}={0,2}/g;
/**
 * `name <op> value`. The name is at most 60 chars and starts at a word start
 * (lookbehind), so scanning is linear. Whether the name is secret-sounding and
 * whether the value looks like a literal is decided in the callback.
 */
const NAME_VALUE = /(?<![\w.])((["']?)([A-Za-z_][\w.-]{0,60})\2\s*(:=|=>|===?|!==?|=|:)\s*)(?:"([^"\n]{1,200})"|'([^'\n]{1,200})'|([^\s"'`,;]{8,}))/g;
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'credential', 'credentials', 'apikey']);

/** True when a name contains a secret keyword as a whole segment (split on _ . - and camelCase). */
function secretName(name: string): boolean {
  const segs = name.split(/[._-]+/).flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/)).map((x) => x.toLowerCase());
  return segs.some((x, i) => SECRET_WORDS.has(x) || (x === 'api' && segs[i + 1] === 'key'));
}

const ENV_REF = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]*\}|\{\{.*\}\}|•+)$/;

/** Rules precise enough to run on source code: token formats, JWTs, auth headers, URL credentials, private keys. */
export function redactKeys(text: string): string {
  if (!text) return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, '-----PRIVATE KEY REDACTED-----');
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${DOTS}@`);
  out = out.replace(JWT, `eyJ${DOTS}`);
  out = out.replace(AUTH_HEADER, (_m, head: string) => `${head}${DOTS}`);
  out = out.replace(BARE_SCHEME, (_m, scheme: string, sp: string) => `${scheme}${sp}${DOTS}`);
  for (const { re } of SECRET_RULES) {
    if (re.source.includes('PRIVATE KEY')) continue;
    out = out.replace(new RegExp(re.source, 'g'), (m) => `${m.slice(0, m.startsWith('sk-ant-') ? 7 : 4)}${DOTS}`);
  }
  return out;
}

/** Mask secrets in free text (prompts, rationales). Idempotent; ordinary text is returned unchanged. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = redactKeys(text);
  out = out.replace(NAME_VALUE, (m, head: string, q: string, name: string, op: string, dq?: string, sq?: string, bare?: string) => {
    if (op === '==' || op === '===' || op === '!=' || op === '!==') return m;
    if (!secretName(name)) return m;
    const quoted = dq ?? sq;
    if (quoted !== undefined) {
      if (ENV_REF.test(quoted)) return m;
      const quote = dq !== undefined ? '"' : "'";
      return `${head}${quote}${DOTS}${quote}`;
    }
    const v = bare ?? '';
    if (ENV_REF.test(v) || /[().=]/.test(v)) return m;
    // `name: word` is usually prose; require something non-alphabetic there.
    if (op === ':' && /^[A-Za-z]+$/.test(v)) return m;
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
      oldText: mapOpt(r.oldText, text) as string | null,
      newText: mapOpt(r.newText, text) as string | null,
      ...(r.command !== undefined ? { command: text(r.command) } : {}),
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
