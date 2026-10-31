/**
 * Password policy: >= 12 chars, a digit, an uppercase letter. Every failed
 * rule is reported in `reasons`, in rule order.
 */
export const MIN_LENGTH = 12;

export function validatePassword(password) {
  const pw = String(password);
  const reasons = [];
  if (pw.length < MIN_LENGTH) reasons.push('too-short');
  if (!/\d/.test(pw)) reasons.push('no-digit');
  if (!/[A-Z]/.test(pw)) reasons.push('no-uppercase');
  return { ok: reasons.length === 0, reasons };
}
