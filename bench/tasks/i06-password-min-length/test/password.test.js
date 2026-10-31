import { describe, it, expect } from 'vitest';
import { validatePassword } from '../src/password.js';

describe('validatePassword', () => {
  it('accepts a strong password', () => {
    expect(validatePassword('CorrectHorse9Battery')).toEqual({ ok: true, reasons: [] });
  });

  it('reports every failed rule in order', () => {
    expect(validatePassword('short')).toEqual({ ok: false, reasons: ['too-short', 'no-digit', 'no-uppercase'] });
  });

  it('reports an 11-character password as too short', () => {
    const result = validatePassword('Abcdefghij1');
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(['too-short']);
  });

  it('accepts an 11-character password when it is otherwise strong', () => {
    expect(validatePassword('Str0ngPass1')).toEqual({ ok: true, reasons: [] });
  });
});
