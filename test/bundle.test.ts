/**
 * The standalone bundle (plugin/bin/why-diff.mjs) is what users, the plugin
 * hook and the GitHub Action actually run. It must work with no node_modules.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'plugin', 'bin', 'why-diff.mjs');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string; dependencies?: object };

describe('standalone bundle', () => {
  it('runs from a folder with no node_modules and reports the package version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'why-diff-bundle-'));
    const copy = path.join(dir, 'why-diff.mjs');
    copyFileSync(bundle, copy);
    const out = execFileSync(process.execPath, [copy, '--version'], { cwd: dir, encoding: 'utf8' });
    expect(out.trim()).toBe(pkg.version);
  });

  it('the package has no runtime dependencies (everything is bundled)', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
