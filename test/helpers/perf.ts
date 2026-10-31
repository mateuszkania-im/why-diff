/**
 * Timing helpers for performance tests. Absolute limits are generous ceilings (machines and CI
 * runners vary); what catches a quadratic regression is the scaling check: 4x the input must
 * take less than 8x the time (a quadratic step takes 16x). The best of a few runs is used to
 * keep one slow run (GC, a busy runner) from deciding the result.
 */
import { performance } from 'node:perf_hooks';
import { expect } from 'vitest';

/** Fastest of `runs` timings of `fn`, in ms. */
export function bestOf(fn: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Fastest of `runs` timings of the async `fn`, in ms. */
export async function bestOfAsync(fn: () => Promise<unknown>, runs = 1): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/**
 * `t4` (time for 4x the input) stays below 8x `t1`. `slackMs` absorbs timer noise when both
 * times are tiny, so near-zero timings cannot fail the check by jitter alone.
 */
export function expectSubQuadratic(t1: number, t4: number, slackMs = 5): void {
  expect(t4, `4x input took ${t4.toFixed(1)} ms vs ${t1.toFixed(1)} ms for 1x`).toBeLessThan(8 * t1 + slackMs);
}
