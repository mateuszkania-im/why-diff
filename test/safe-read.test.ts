/** The full-file reads behind the labels never leave the repository or read anything but a small regular file. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoText } from '../src/pipeline.js';
import { tempDir } from './helpers/claude-fixture.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const temp = (p: string): string => { const d = realpathSync(tempDir(p)); dirs.push(d); return d; };
const posix = process.platform !== 'win32';

describe('readRepoText', () => {
  it('reads a regular file inside the repository', async () => {
    const r = temp('wd-sr-');
    mkdirSync(path.join(r, 'test'));
    writeFileSync(path.join(r, 'test', 'a.test.js'), 'x\n');
    expect(await readRepoText(r, 'test/a.test.js', 1024)).toBe('x\n');
  });

  it('does not read a file over the cap, or a missing one', async () => {
    const r = temp('wd-sr-');
    writeFileSync(path.join(r, 'big.test.js'), 'x'.repeat(2000));
    expect(await readRepoText(r, 'big.test.js', 1024)).toBeUndefined();
    expect(await readRepoText(r, 'nope.test.js', 1024)).toBeUndefined();
  });

  it.skipIf(!posix)('does not follow a symlinked parent directory out of the repository, or a symlinked file', async () => {
    const r = temp('wd-sr-');
    const outside = temp('wd-sr-out-');
    writeFileSync(path.join(outside, 'secret.test.js'), 'secret\n');
    symlinkSync(outside, path.join(r, 'test'));
    expect(await readRepoText(r, 'test/secret.test.js', 1024)).toBeUndefined();
    symlinkSync(path.join(outside, 'secret.test.js'), path.join(r, 'link.test.js'));
    expect(await readRepoText(r, 'link.test.js', 1024)).toBeUndefined();
  });

  it.skipIf(!posix)('does not read (or hang on) a FIFO', async () => {
    const r = temp('wd-sr-');
    execFileSync('mkfifo', [path.join(r, 'b.test.js')]);
    expect(await readRepoText(r, 'b.test.js', 1024)).toBeUndefined();
  }, 10_000);
});
