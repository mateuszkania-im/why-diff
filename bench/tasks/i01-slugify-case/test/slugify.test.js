import { describe, it, expect } from 'vitest';
import { slugify } from '../src/slugify.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses runs of separators', () => {
    expect(slugify('a   b -- c')).toBe('a-b-c');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });

  it('keeps the original casing of words', () => {
    expect(slugify('Hello World')).toBe('Hello-World');
  });
});
