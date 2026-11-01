/** Locate executables on PATH in-process (no `sh -c command -v`, which Windows runners may lack). */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export function which(name: string, envPath = process.env.PATH ?? process.env.Path ?? ''): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // next
      }
    }
  }
  return undefined;
}

/** Directory holding the `git` executable. */
export function gitBinDir(): string {
  const git = which('git');
  if (!git) throw new Error('git not found on PATH');
  return path.dirname(git);
}

/** Variables a minimal child env still needs on Windows (process start-up, temp dirs, home lookup). */
export function windowsBaseEnv(home: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const pick = (k: string): Record<string, string> => (process.env[k] ? { [k]: process.env[k]! } : {});
  return { ...pick('SystemRoot'), ...pick('windir'), ...pick('TEMP'), ...pick('TMP'), ...pick('PATHEXT'), ...pick('ComSpec'), USERPROFILE: home };
}
