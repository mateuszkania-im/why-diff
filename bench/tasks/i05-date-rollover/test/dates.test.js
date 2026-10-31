import { describe, it, expect } from 'vitest';
import { parseIsoDate } from '../src/dates.js';

describe('parseIsoDate', () => {
  it('parses a valid date', () => {
    expect(parseIsoDate('2024-03-15')).toEqual({ year: 2024, month: 3, day: 15 });
  });

  it('accepts Feb 29 in a leap year', () => {
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it('rejects malformed input', () => {
    expect(() => parseIsoDate('15/03/2024')).toThrow(RangeError);
  });

  it('throws on Feb 30', () => {
    expect(() => parseIsoDate('2023-02-30')).toThrow(RangeError);
  });

  it('rolls Feb 30 over to March 2', () => {
    expect(parseIsoDate('2023-02-30')).toEqual({ year: 2023, month: 3, day: 2 });
  });
});
