import { describe, it, expect } from 'vitest';
import { LruCache } from '../src/lru-cache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache(2);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const c = new LruCache(2);
    c.set('a', 1).set('b', 2).set('c', 3);
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });

  it('treats a get as a use', () => {
    const c = new LruCache(2);
    c.set('a', 1).set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
  });

  it('treats an update as a use', () => {
    const c = new LruCache(2);
    c.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(10);
  });
});
