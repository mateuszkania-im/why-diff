import { describe, it, expect } from 'vitest';
import { addBusinessDays } from '../src/dates.js';

// March 2024: Fri 1st, Sat 2nd, Sun 3rd, Mon 4th, Tue 5th, Wed 6th
const fri = new Date(2024, 2, 1);
const mon = new Date(2024, 2, 4);

describe('addBusinessDays', () => {
  it('adds business days within a week', () => {
    expect(addBusinessDays(mon, 2)).toEqual(new Date(2024, 2, 6));
  });

  it('skips the weekend', () => {
    expect(addBusinessDays(fri, 1)).toEqual(new Date(2024, 2, 4));
  });

  it('does not mutate the input', () => {
    const copy = new Date(mon.getTime());
    addBusinessDays(mon, 3);
    expect(mon).toEqual(copy);
  });

  it('rejects a negative count', () => {
    expect(() => addBusinessDays(mon, -1)).toThrow(RangeError);
  });
});
