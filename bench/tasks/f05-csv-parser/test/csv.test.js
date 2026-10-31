import { describe, it, expect } from 'vitest';
import { parseCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('splits rows and fields', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('accepts CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseCsv('"x, y",z')).toEqual([['x, y', 'z']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('a,"say ""hi"""\n')).toEqual([['a', 'say "hi"']]);
  });

  it('ignores a trailing newline', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });
});
