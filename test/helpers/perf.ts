/**
 * Timing helpers for performance tests. Absolute limits are generous ceilings (machines and CI
 * runners vary); what catches a quadratic regression is the scaling check: 4x the input must
 * take at most 10x the time (a quadratic step takes about 16x).
 *
 * To stay stable on a loaded machine, every measurement is warmed up once, repeated so that the
 * 1x workload does at least {@link MIN_WORK_MS} of work (timer noise and scheduler jitter are then
 * small next to it), and taken as the minimum of {@link RUNS} repetitions: load only ever adds
 * time, so the minimum is the closest to the real cost.
 */
import { performance } from 'node:perf_hooks';
import { expect } from 'vitest';

export const RUNS = 5;
export const MIN_WORK_MS = 20;
/** 4x the input may take at most this many times as long. */
export const SCALING_LIMIT = 10;

function time(fn: () => unknown, reps: number): number {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return performance.now() - t0;
}

/** Fastest of `runs` timings of `fn` (after one warm-up run), in ms. */
export function bestOf(fn: () => unknown, runs = RUNS, reps = 1): number {
  time(fn, 1);
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, time(fn, reps));
  return best;
}

/** Fastest of `runs` timings of the async `fn` (after one warm-up run), in ms. */
export async function bestOfAsync(fn: () => Promise<unknown>, runs = RUNS): Promise<number> {
  await fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/**
 * Time `small` (1x input) and `large` (4x input) with the same repetition count, chosen so the 1x
 * measurement does at least {@link MIN_WORK_MS} of work, and expect large <= 10x small.
 */
export function expectScalesSubQuadratically(small: () => unknown, large: () => unknown): { t1: number; t4: number } {
  small();
  let reps = 1;
  while (time(small, reps) < MIN_WORK_MS && reps < 1 << 16) reps *= 2;
  const t1 = bestOf(small, RUNS, reps);
  const t4 = bestOf(large, RUNS, reps);
  expectSubQuadratic(t1, t4);
  return { t1: t1 / reps, t4: t4 / reps };
}

/** `t4` (time for 4x the input) is at most 10x `t1`; `slackMs` absorbs noise when both are tiny. */
export function expectSubQuadratic(t1: number, t4: number, slackMs = 0): void {
  expect(t4, `4x input took ${t4.toFixed(1)} ms vs ${t1.toFixed(1)} ms for 1x`).toBeLessThanOrEqual(SCALING_LIMIT * t1 + slackMs);
}
