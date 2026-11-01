export declare const RUNS = 5;
export declare const MIN_WORK_MS = 20;
/** 4x the input may take at most this many times as long. */
export declare const SCALING_LIMIT = 10;
/** Fastest of `runs` timings of `fn` (after one warm-up run), in ms. */
export declare function bestOf(fn: () => unknown, runs?: number, reps?: number): number;
/** Fastest of `runs` timings of the async `fn` (after one warm-up run), in ms. */
export declare function bestOfAsync(fn: () => Promise<unknown>, runs?: number): Promise<number>;
/**
 * Time `small` (1x input) and `large` (4x input) with the same repetition count, chosen so the 1x
 * measurement does at least {@link MIN_WORK_MS} of work, and expect large <= 10x small.
 */
export declare function expectScalesSubQuadratically(small: () => unknown, large: () => unknown): {
    t1: number;
    t4: number;
};
/** `t4` (time for 4x the input) is at most 10x `t1`; `slackMs` absorbs noise when both are tiny. */
export declare function expectSubQuadratic(t1: number, t4: number, slackMs?: number): void;
