import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommandShim } from '../src/classify/claude-cli.js';
import { tempDir } from './helpers/claude-fixture.js';

// npm on Windows installs `claude` as a .cmd shim, which execFile cannot run without a shell.
// The runner resolves the shim to `node <cli.js>` so no argument ever passes through cmd.exe.
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

describe('resolveCommandShim', () => {
  it('turns an npm .cmd shim into node + the script it wraps', () => {
    const dir = tempDir('why-diff-shim-');
    const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    const shim = path.join(dir, 'claude.cmd');
    writeFileSync(shim, NPM_SHIM);
    expect(resolveCommandShim(shim, ['-p', 'a "quoted" & arg'])).toEqual({ file: process.execPath, args: [script, '-p', 'a "quoted" & arg'] });
  });

  it('leaves executables that are not shims alone', () => {
    expect(resolveCommandShim('/usr/local/bin/claude', ['-p'])).toEqual({ file: '/usr/local/bin/claude', args: ['-p'] });
    expect(resolveCommandShim('C:\\x\\claude.exe', ['-p'])).toEqual({ file: 'C:\\x\\claude.exe', args: ['-p'] });
  });

  it('refuses a .cmd it cannot resolve instead of running it through a shell', () => {
    const dir = tempDir('why-diff-shim-');
    const shim = path.join(dir, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\nsomething-else %*\r\n');
    expect(() => resolveCommandShim(shim, ['-p'])).toThrow(/--classifier anthropic/);
  });
});
