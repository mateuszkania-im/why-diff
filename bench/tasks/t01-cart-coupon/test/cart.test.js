import { describe, it, expect } from 'vitest';
import { lineTotal, subtotal, total } from '../src/cart.js';

const items = [
  { sku: 'A', unitPrice: 1000, quantity: 2 },
  { sku: 'B', unitPrice: 250, quantity: 4 },
];

describe('cart', () => {
  it('computes line totals', () => {
    expect(lineTotal(items[0])).toBe(2000);
    expect(lineTotal(items[1])).toBe(1000);
  });

  it('sums the subtotal', () => {
    expect(subtotal(items)).toBe(3000);
    expect(subtotal([])).toBe(0);
  });

  it('applies tax to the discounted subtotal', () => {
    expect(total(items, { discount: 0.1, taxRate: 0.2 })).toBe(3240);
  });
});
