/**
 * Backend that runs the user's local Claude Code in headless mode:
 *
 *   claude -p --output-format json --model haiku --max-turns 1 --tools "" \
 *     --system-prompt <...> --no-session-persistence --strict-mcp-config --safe-mode
 *
 * with the classification prompt on stdin. This bills the user's Claude
 * subscription; no API key is needed. Tools, MCP servers and customisations
 * (CLAUDE.md, hooks, plugins) are disabled and the process runs in the OS temp
 * dir, which keeps each call small (under 1k tokens of overhead instead of
 * ~35k) and stops the user's personal instructions from steering verdicts.
 * Older CLIs that reject one of these flags are retried once with the minimal
 * `-p --output-format json --model --max-turns 1` set, with the system prompt
 * prepended to stdin.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClassifierCallError, ClassifierUnavailableError, type CompletionBackend, type CompletionRequest } from './llm.js';
import { isRecord } from './prompt.js';

export const DEFAULT_CLAUDE_CLI_MODEL = 'haiku';

/** Result of running a process to completion. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed by a signal */
  code: number | null;
}

/** Spawns `file` with `args` (no shell), writes `input` to stdin. Injectable for tests. */
export type ProcessRunner = (file: string, args: string[], input: string) => Promise<ProcessResult>;

export interface ClaudeCliOptions {
  /** Model alias or id (default `haiku`) */
  model?: string;
  /** Path or name of the binary (default `claude`, or $WHY_DIFF_CLAUDE_BIN) */
  bin?: string;
  /** Per-call timeout in ms (default 180 s) */
  timeoutMs?: number;
  runner?: ProcessRunner;
}

/**
 * Locate an executable on PATH without spawning anything. On Windows only `.exe`, `.cmd` and `.bat`
 * files count, in that order: npm puts an extensionless shell script (for Git Bash) next to
 * `claude.cmd`, and that script cannot be started from Node.
 */
export function findOnPath(name: string, envPath = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | undefined {
  if (name.includes('/') || name.includes('\\')) return isExecutable(name) ? name : undefined;
  const win = platform === 'win32';
  const exts = win ? (/\.(exe|cmd|bat)$/i.test(name) ? [''] : ['.exe', '.cmd', '.bat']) : [''];
  for (const dir of envPath.split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows: npm installs `claude` as a `.cmd` shim, which `execFile` cannot start without a shell,
 * and passing the system prompt through cmd.exe would need fragile quoting. Resolve an npm shim to
 * `node <script>` instead; refuse any other `.cmd`/`.bat` rather than run it through a shell.
 */
export function resolveCommandShim(file: string, args: string[]): { file: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // unreadable: fall through to the error below
  }
  const m = /"%dp0%\\([^"%]+\.[cm]?js)"\s+%\*/i.exec(text);
  const script = m?.[1] ? join(dirname(file), ...m[1].split('\\')) : undefined;
  if (script && existsSync(script)) return { file: process.execPath, args: [script, ...args] };
  throw new ClassifierUnavailableError(
    `Cannot run "${file}" without a shell. Install the native Claude Code binary (claude.exe), or pick another backend with --classifier anthropic|openai.`,
  );
}

/** Default runner: `execFile` (no shell) in the OS temp dir, prompt on stdin. */
export function execFileRunner(timeoutMs: number): ProcessRunner {
  return (file, args, input) =>
    new Promise((resolve, reject) => {
      let cmd: { file: string; args: string[] };
      try {
        cmd = resolveCommandShim(file, args);
      } catch (err) {
        reject(err);
        return;
      }
      const child = execFile(
        cmd.file,
        cmd.args,
        { cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && 'code' in err && err.code === 'ENOENT') {
            reject(
              new ClassifierUnavailableError(
                `Claude Code CLI not found ("${file}"). Install it (https://docs.claude.com/claude-code) and log in, or pick another backend with --classifier anthropic|openai.`,
              ),
            );
            return;
          }
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          resolve({ stdout, stderr, code });
        },
      );
      child.stdin?.on('error', () => {
        // EPIPE when the binary exits early; the exit callback reports it.
      });
      child.stdin?.end(input);
    });
}

/**
 * Pull the model text out of `claude -p --output-format json` output.
 * Accepts a single JSON document or JSON lines (last `result` wins).
 */
export function parseClaudeCliOutput(stdout: string): string {
  const candidates = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !('result' in parsed || 'is_error' in parsed)) continue;
    if (parsed.is_error === true) {
      throw new ClassifierCallError(`claude returned an error: ${String(parsed.result ?? parsed.subtype ?? 'unknown')}`);
    }
    if (typeof parsed.result === 'string') return parsed.result;
  }
  throw new ClassifierCallError(`could not parse claude CLI output: ${stdout.slice(0, 200)}`);
}

/** CompletionBackend over the local `claude` binary. */
export class ClaudeCliBackend implements CompletionBackend {
  readonly name = 'claude-cli';
  readonly model: string;
  private readonly bin: string;
  private readonly runner: ProcessRunner;

  constructor(opts: ClaudeCliOptions = {}) {
    this.model = opts.model ?? DEFAULT_CLAUDE_CLI_MODEL;
    this.bin = opts.bin ?? 'claude';
    this.runner = opts.runner ?? execFileRunner(opts.timeoutMs ?? 180_000);
  }

  /** Set once an `unknown option` error shows this CLI predates the lean flags. */
  private legacy = false;

  /** CLI arguments for one call (exported for tests and docs). */
  args(system: string, legacy = this.legacy): string[] {
    const base = ['-p', '--output-format', 'json', '--model', this.model, '--max-turns', '1'];
    if (legacy) return base;
    return [
      ...base,
      '--tools', '',
      '--system-prompt', system,
      '--no-session-persistence',
      '--strict-mcp-config',
      '--safe-mode',
    ];
  }

  async complete(req: CompletionRequest): Promise<string> {
    let res = await this.run(req);
    if (res.code !== 0 && !this.legacy && /unknown option|unrecognized option/i.test(res.stderr + res.stdout)) {
      this.legacy = true;
      res = await this.run(req);
    }
    if (res.code !== 0) {
      // A failed run may still print a JSON error result; prefer its message.
      try {
        parseClaudeCliOutput(res.stdout);
      } catch (err) {
        if (err instanceof ClassifierCallError && !err.message.startsWith('could not parse')) throw err;
      }
      throw new ClassifierCallError(
        `claude exited with code ${res.code ?? 'signal'}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
      );
    }
    return parseClaudeCliOutput(res.stdout);
  }

  private run(req: CompletionRequest): Promise<ProcessResult> {
    const input = this.legacy ? `${req.system}\n\n---\n\n${req.user}` : req.user;
    return this.runner(this.bin, this.args(req.system), input);
  }
}
