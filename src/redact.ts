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
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"`]+:[^\s/@'"`]+@/gi;
const ASSIGNMENT = /\b((?:[A-Za-z_][\w.-]*?)?(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|credentials?)[\w-]*)(\s*=\s*)(["']?)([^\s"'`]+)\3/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** Mask secrets in free text. Idempotent; ordinary text is returned unchanged. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, '-----PRIVATE KEY REDACTED-----');
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${DOTS}@`);
  for (const { re } of SECRET_RULES) {
    if (re.source.includes('PRIVATE KEY')) continue;
    out = out.replace(new RegExp(re.source, 'g'), (m) => `${m.slice(0, m.startsWith('sk-ant-') ? 7 : 4)}${DOTS}`);
  }
  out = out.replace(ASSIGNMENT, (m, name: string, eq: string, q: string, value: string) =>
    /^[•$]|^\{\{|^process\.env|^os\.environ/.test(value) ? m : `${name}${eq}${q}${DOTS}${q}`);
  out = out.replace(EMAIL, '[email redacted]');
  return out;
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
      edits: h.edits.map(rationale),
      ...(h.prompt ? { prompt: { ...h.prompt, text: promptText(h.prompt) } } : {}),
    })),
  };
}
