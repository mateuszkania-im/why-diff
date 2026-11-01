/**
 * Helpers for the synthetic Claude Code fixture under test/fixtures/claude.
 *
 * The checked-in transcripts use the placeholder cwd `/home/dev/acme-shop`.
 * `materialiseFixtureHome` copies them into a temporary home directory,
 * rewriting that placeholder (in file contents and in the encoded project
 * directory names) to a real repository path, so the same fixture drives both
 * the adapter unit tests and the end-to-end attribution test.
 */
export declare const FIXTURE_DIR: string;
export declare const FIXTURE_HOME: string;
export declare const FIXTURE_REPO: string;
export declare const FIXTURE_CWD = "/home/dev/acme-shop";
export declare const FIXTURE_SESSION = "6f1d2c3b-9a8e-4f70-b1c2-d3e4f5a6b7c8";
export declare const FIXTURE_SUBDIR_SESSION = "0c3d4e5f-aaaa-4bbb-8ccc-ddddeeeeffff";
/**
 * A synthetic POSIX absolute path (`/work/repo/a.ts`) as the code under test spells it on this OS:
 * unchanged on POSIX, resolved onto the current drive on Windows (`D:\\work\\repo\\a.ts`).
 */
export declare function nat(p: string): string;
/** A path as a shell command on this OS would spell it: forward slashes (Git Bash on Windows takes `C:/x`, and `\\` is an escape). */
export declare function shellPath(p: string): string;
/** Fresh temp directory (realpath-resolved so macOS `/var` vs `/private/var` cannot bite). */
export declare function tempDir(prefix: string): string;
/** Copy the fixture home, re-pointing every transcript at `repoRoot`. Returns the new home. */
export declare function materialiseFixtureHome(repoRoot: string): string;
export interface SyntheticCall {
    /** Any tool name: Edit, Write and Bash get realistic results, others an empty object. */
    tool: string;
    input: Record<string, unknown>;
    /** ISO timestamp of the tool call; the result is stamped one second later (or at `resultAt`). */
    at: string;
    /** ISO timestamp of the tool_result line (default: `at` + 1 s). */
    resultAt?: string;
    /** Assistant text emitted with the call (becomes the rationale). */
    text?: string;
    isError?: boolean;
    /** Explicit `toolUseResult` for the result line (default: a minimal one shaped like the real tool's). */
    result?: Record<string, unknown> | string;
    /** Write no tool_result line at all (a call still running, or cut off). */
    noResult?: boolean;
}
export interface SyntheticTurn {
    prompt: string;
    at: string;
    calls: SyntheticCall[];
}
/**
 * Write a Claude Code transcript with the given human turns under
 * `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, mirroring the
 * real line shapes (origin/promptSource on prompts, tool_use blocks,
 * tool_result lines with `toolUseResult`). Returns the transcript path.
 */
export declare function writeSyntheticTranscript(home: string, cwd: string, sessionId: string, turns: SyntheticTurn[]): string;
/** Parse the fixture transcript's JSON lines (for tests that need raw inputs such as file contents). */
export declare function fixtureLines(): Array<Record<string, unknown>>;
/**
 * `objectTime` for the guard in tests: every git object counts as written long before the session.
 * Test repositories are committed after the synthetic session start, unlike real ones.
 */
export declare function oldObjects(p: string): Promise<number>;
