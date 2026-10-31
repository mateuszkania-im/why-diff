import { describe, it, expect } from 'vitest';
import { formatMoney } from '../src/money.js';

describe('formatMoney', () => {
  it('adds thousands separators', () => {
    expect(formatMoney(123456789)).toBe('$1,234,567.89');
  });

  it('pads cents to two digits', () => {
    expect(formatMoney(123405)).toBe('$1,234.05');
  });

  it('formats negative amounts', () => {
    expect(formatMoney(-250)).toBe('-$2.50');
  });

  it('uses the currency code when no symbol is known', () => {
    expect(formatMoney(199, 'PLN')).toBe('PLN 1.99');
  });

  it('rejects non-integer input', () => {
    expect(() => formatMoney(1.5)).toThrow(TypeError);
  });
});
