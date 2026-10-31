import { describe, it, expect } from 'vitest';
import { paginate } from '../src/pagination.js';

const items = Array.from({ length: 25 }, (_, i) => i + 1);

describe('paginate', () => {
  it('returns the first page', () => {
    expect(paginate(items, { page: 1, pageSize: 10 }).items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns the last partial page', () => {
    expect(paginate(items, { page: 3, pageSize: 10 }).items).toEqual([21, 22, 23, 24, 25]);
  });

  it('reports totalPages rounded up', () => {
    expect(paginate(items, { page: 1, pageSize: 10 }).totalPages).toBe(3);
  });

  it('rejects page 0 with a RangeError', () => {
    expect(() => paginate(items, { page: 0, pageSize: 10 })).toThrow(RangeError);
  });
});
