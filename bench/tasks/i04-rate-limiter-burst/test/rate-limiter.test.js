import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

const T0 = 1_700_000_000_000;

describe('RateLimiter', () => {
  it('allows requests under the limit', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.allow('alice', T0)).toBe(true);
    expect(rl.allow('alice', T0 + 1)).toBe(true);
    expect(rl.allow('alice', T0 + 2)).toBe(true);
  });

  it('rejects the request after the limit is reached', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) rl.allow('alice', T0 + i);
    expect(rl.allow('alice', T0 + 3)).toBe(false);
  });

  it('starts over in a new window', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) rl.allow('alice', T0 + i);
    expect(rl.allow('alice', T0 + 1000)).toBe(true);
  });

  it('allows one extra request as a grace burst', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) rl.allow('bob', T0 + i);
    expect(rl.allow('bob', T0 + 3)).toBe(true);
    expect(rl.allow('bob', T0 + 4)).toBe(false);
  });
});
