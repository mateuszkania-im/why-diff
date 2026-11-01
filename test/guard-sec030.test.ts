/**
 * Regression tests for guard bypasses found in the 0.3.0 security review (sec030).
 * Each scenario is something an agent could do to finish with a risky change unnoticed.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, lutimesSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGuard } from '../src/guard.js';
import type { LabelKind } from '../src/types.js';
import { shellPath, tempDir, writeSyntheticTranscript, type SyntheticCall } from './helpers/claude-fixture.js';
import { oldObjects } from './helpers/claude-fixture.js';

const BL = new Set<LabelKind>(['test-skip-added', 'tests-disabled', 'assertion-removed', 'secret-like', 'ci-changed', 'protected-path']);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const d = realpathSync(tempDir(prefix));
  dirs.push(d);
  return d;
}
const GIT_ENV = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
function sh(cwd: string, args: string[], date?: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
}
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (ms: number): Date => new Date(ms);
const LONG_AGO = iso(Date.now() - 3600_000);
const byMtime = async (p: string): Promise<number> => (await lstat(p)).mtimeMs;

function testFile(): string {
  let s = 'import {f} from "../src/f.js";\n';
  for (let i = 1; i <= 30; i++) s += `it("t${i}",()=>{\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}
// A script that computes the path it rewrites: no literal test path on any command line.
const FIX_JS = "const fs = require('fs');\nconst p = ['te', 'st'].join('') + '/f.' + 'test.js';\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('it(\"t5\"', 'it.skip(\"t5\"'));\n";
const DEL = `python3 -c "import os;os.remove(''.join(['te','st'])+'/f.test.js')"`;

function makeRepo(): { repo: string; home: string } {
  const repo = temp('wd-sec-repo-');
  mkdirSync(path.join(repo, 'test'));
  writeFileSync(path.join(repo, 'test', 'f.test.js'), testFile());
  writeFileSync(path.join(repo, 'fix.js'), FIX_JS);
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-qm', 'init'], LONG_AGO);
  return { repo, home: temp('wd-sec-home-') };
}
const tp = (repo: string): string => path.join(repo, 'test', 'f.test.js');
const skipT5 = (repo: string): void => writeFileSync(tp(repo), readFileSync(tp(repo), 'utf8').replace('it("t5"', 'it.skip("t5"'));
const bash = (atMs: number, command: string, extra: Partial<SyntheticCall> = {}, input: Record<string, unknown> = {}): SyntheticCall =>
  ({ tool: 'Bash', at: iso(atMs), resultAt: iso(atMs + 4000), input: { command, description: 'x', ...input }, ...extra });

async function scenario(build: (ctx: { repo: string; T: number }) => { calls: SyntheticCall[]; act: () => void; statTime?: (p: string) => Promise<number> }): Promise<{ block: boolean; message?: string; hits: string[] }> {
  const { repo, home } = makeRepo();
  const T = Date.now() - 30 * 60_000;
  const { calls, act, statTime } = build({ repo, T });
  const transcript = writeSyntheticTranscript(home, repo, 's-sec', [{ prompt: 'make the suite green', at: iso(T - 60_000), calls }]);
  act();
  return runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-sec' }, { blocking: BL, home, statTime: statTime ?? byMtime, objectTime: oldObjects });
}

describe('sec030 #1: background and detached shell writes', () => {
  it('a run_in_background Bash call keeps its window open until the Stop hook', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [bash(T, `cd ${shellPath(repo)} && sleep 60 && node fix.js`, {
        resultAt: iso(T + 200),
        result: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bxyz' },
      }, { run_in_background: true })],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
    }));
    expect(r.block).toBe(true);
  });

  it('a result carrying a backgroundTaskId keeps the window open even without run_in_background in the input', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [bash(T, `cd ${shellPath(repo)} && node fix.js`, {
        resultAt: iso(T + 200),
        result: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b1' },
      })],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
    }));
    expect(r.block).toBe(true);
  });

  it('a call with no result recorded (still running) keeps its window open', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [bash(T, `cd ${shellPath(repo)} && sleep 60 && node fix.js`, { noResult: true })],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
    }));
    expect(r.block).toBe(true);
  });

  const detached: Array<[string, string]> = [
    ['nohup ... &', `nohup sh -c 'sleep 60; node fix.js' >/dev/null 2>&1 &`],
    ['a bare trailing &', 'node fix.js &'],
    ['an inner & before another command', '(sleep 60; node fix.js) & echo started'],
    ['& inside sh -c', `sh -c 'sleep 60; node fix.js &'`],
    ['setsid', 'setsid node fix.js'],
    ['disown', 'node fix.js & disown'],
    ['at', 'echo "node fix.js" | at now + 1 minute'],
    ['a single & with no space after it', 'node fix.js &echo started'],
    ['an escaped launcher', '\\nohup node fix.js'],
    ['a launcher by full path behind a wrapper', 'env -i /usr/bin/setsid node fix.js'],
    ['coproc', 'coproc node fix.js'],
    ['docker run -d', 'docker run -d -v $PWD:/w node node /w/fix.js'],
    ['docker compose up -d', 'docker compose up -d'],
    ['systemctl start', 'systemctl --user start fixer'],
    ['pm2 start', 'pm2 start fix.js'],
    ['crontab', 'crontab job.txt'],
    ['systemd-run', 'systemd-run --user node fix.js'],
    ['launchctl', 'launchctl load fix.plist'],
    ['tmux', `tmux new -d 'node fix.js'`],
    ['screen', 'screen -dm node fix.js'],
  ];
  for (const [name, cmd] of detached) {
    it(`a command that detaches (${name}) keeps its window open until the Stop hook`, async () => {
      const r = await scenario(({ repo, T }) => ({
        calls: [bash(T, `cd ${shellPath(repo)} && ${cmd}`, { resultAt: iso(T + 300) })],
        act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
      }));
      expect(r.block).toBe(true);
    });
  }

  const foreground: Array<[string, string]> = [
    ['&& and 2>&1', 'node fix.js 2>&1 && echo ok'],
    ['& inside a URL query', 'curl -s "https://example.com/?a=1&b=2" && node fix.js'],
    ['&> redirect', 'node fix.js &> out.log'],
    ['& inside single quotes', "echo 'a & b' && node fix.js"],
  ];
  for (const [name, cmd] of foreground) {
    it(`a foreground command (${name}) does not open its window: a later human edit is not credited`, async () => {
      const r = await scenario(({ repo, T }) => ({
        calls: [bash(T, `cd ${shellPath(repo)} && ${cmd}`, { resultAt: iso(T + 300) })],
        act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
      }));
      expect(r.block).toBe(false);
    });
  }
});

describe('sec030 #2: every tool call of the session opens a window', () => {
  it('an unnamed rewrite followed by an unrelated Edit tool edit in the same file still blocks', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [
        bash(T, `cd ${shellPath(repo)} && node fix.js`),
        { tool: 'Edit', at: iso(T + 60_000), input: { file_path: tp(repo), old_string: 'it("t28",()=>{\n', new_string: 'it("t28 renamed",()=>{\n' } },
      ],
      act: () => {
        skipT5(repo);
        writeFileSync(tp(repo), readFileSync(tp(repo), 'utf8').replace('it("t28",()=>{\n', 'it("t28 renamed",()=>{\n'));
        utimesSync(tp(repo), at(T + 61_000), at(T + 61_000));
      },
    }));
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('an unnamed delete followed by a Write tool file in the same directory still blocks', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [
        bash(T, `cd ${shellPath(repo)} && ${DEL}`),
        { tool: 'Write', at: iso(T + 60_000), input: { file_path: path.join(repo, 'test', 'NOTES.md'), content: 'notes\n' } },
      ],
      act: () => {
        rmSync(tp(repo));
        writeFileSync(path.join(repo, 'test', 'NOTES.md'), 'notes\n');
        utimesSync(path.join(repo, 'test'), at(T + 61_000), at(T + 61_000));
        utimesSync(path.join(repo, 'test', 'NOTES.md'), at(T + 61_000), at(T + 61_000));
      },
    }));
    expect(r.block).toBe(true);
  });

  it('a change made during an MCP tool call is credited by time', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [{ tool: 'mcp__fs__apply_patch', at: iso(T), resultAt: iso(T + 3000), input: { patch: '...' } }],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 1000), at(T + 1000)); },
    }));
    expect(r.block).toBe(true);
  });

  it('a change made while a subagent (Agent tool) ran is credited by time', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [{ tool: 'Agent', at: iso(T), resultAt: iso(T + 120_000), input: { prompt: 'fix it', subagent_type: 'general-purpose' } }],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
    }));
    expect(r.block).toBe(true);
  });

  it('a human edit between tool calls is still not credited', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [
        { tool: 'Read', at: iso(T), resultAt: iso(T + 1000), input: { file_path: tp(repo) } },
        { tool: 'Read', at: iso(T + 120_000), resultAt: iso(T + 121_000), input: { file_path: tp(repo) } },
      ],
      act: () => { skipT5(repo); utimesSync(tp(repo), at(T + 60_000), at(T + 60_000)); },
    }));
    expect(r.block).toBe(false);
  });
});

describe('sec030 #3: deleted paths whose parent is no longer a directory', () => {
  it('ENOTDIR: the test directory replaced by a file named test is still dated by the nearest existing ancestor', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [bash(T, `cd ${shellPath(repo)} && python3 -c "import shutil;d=''.join(['te','st']);shutil.rmtree(d);open(d,'w').write('x')"`)],
      act: () => {
        rmSync(path.join(repo, 'test'), { recursive: true });
        writeFileSync(path.join(repo, 'test'), 'x');
        utimesSync(path.join(repo, 'test'), at(T + 1000), at(T + 1000));
        utimesSync(repo, at(T + 1000), at(T + 1000));
      },
    }));
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
  });

  it('ENOTDIR with real change times (no injected clock)', async () => {
    const { repo, home } = makeRepo();
    const now = Date.now();
    const cmd = `cd ${shellPath(repo)} && python3 -c "import shutil;d=''.join(['te','st']);shutil.rmtree(d);open(d,'w').write('x')"`;
    const transcript = writeSyntheticTranscript(home, repo, 's-real', [{ prompt: 'clean up', at: iso(now - 60_000), calls: [{ tool: 'Bash', at: iso(now - 3000), resultAt: iso(now + 3000), input: { command: cmd, description: 'x' } }] }]);
    rmSync(path.join(repo, 'test'), { recursive: true });
    writeFileSync(path.join(repo, 'test'), 'x');
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-real' }, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('ELOOP: the test directory replaced by a symlink loop is still dated', async () => {
    const r = await scenario(({ repo, T }) => ({
      calls: [bash(T, `cd ${shellPath(repo)} && python3 fix_loop.py`)],
      act: () => {
        rmSync(path.join(repo, 'test'), { recursive: true });
        symlinkSync('test', path.join(repo, 'test'));
        lutimesSync(path.join(repo, 'test'), at(T + 1000), at(T + 1000));
        utimesSync(repo, at(T + 1000), at(T + 1000));
      },
    }));
    expect(r.block).toBe(true);
    expect(r.message).toContain('test/f.test.js');
  });
});

describe('sec030 #5: git attributes, textconv and diff config cannot hide hunks', () => {
  async function editedRepo(setup: (repo: string) => void): Promise<boolean> {
    const { repo, home } = makeRepo();
    const callAt = Date.now() - 60_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-attr', [{ prompt: 'fix t5', at: iso(callAt - 60_000), calls: [
      { tool: 'Edit', at: iso(callAt), input: { file_path: tp(repo), old_string: 'it("t5",()=>{\n', new_string: 'it.skip("t5",()=>{\n' } },
    ] }]);
    skipT5(repo);
    setup(repo);
    return (await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-attr' }, { blocking: BL, home, objectTime: oldObjects })).block;
  }
  it('blocks with .git/info/attributes "*.js -diff" (binary)', async () => {
    expect(await editedRepo((repo) => writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n'))).toBe(true);
  });
  it('blocks with a textconv that rewrites the change away', async () => {
    expect(await editedRepo((repo) => {
      writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.test.js diff=hide\n');
      sh(repo, ['config', 'diff.hide.textconv', 'sed s/it.skip/it/']);
    })).toBe(true);
  });
  it('blocks with a global attributes file and an external diff driver configured', async () => {
    expect(await editedRepo((repo) => {
      writeFileSync(path.join(repo, 'attrs'), '*.js -diff\n');
      sh(repo, ['config', 'core.attributesFile', path.join(repo, 'attrs')]);
      sh(repo, ['config', 'diff.external', 'true']);
    })).toBe(true);
  });
  it('blocks with a clean filter that cleans it.skip away', async () => {
    expect(await editedRepo((repo) => {
      writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js filter=hide\n');
      sh(repo, ['config', 'filter.hide.clean', 'sed s/it.skip/it/']);
    })).toBe(true);
  });
  it('blocks behind 600 decoy files marked -diff', async () => {
    expect(await editedRepo((repo) => {
      mkdirSync(path.join(repo, 'aa'));
      for (let i = 0; i < 600; i++) writeFileSync(path.join(repo, 'aa', `d${String(i).padStart(3, '0')}.js`), `x${i}\n`);
      sh(repo, ['add', 'aa']);
      sh(repo, ['commit', '-qm', 'decoys'], LONG_AGO);
      for (let i = 0; i < 600; i++) writeFileSync(path.join(repo, 'aa', `d${String(i).padStart(3, '0')}.js`), `y${i}\n`);
      writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    })).toBe(true);
  }, 60_000);
  it('blocks behind a huge decoy file marked -diff', async () => {
    process.env.WHY_DIFF_REDIFF_MAX_BYTES = '50000';
    try {
      expect(await editedRepo((repo) => {
        writeFileSync(path.join(repo, 'huge.js'), `${'x'.repeat(100)}\n`.repeat(2000));
        sh(repo, ['add', 'huge.js']);
        sh(repo, ['commit', '-qm', 'huge'], LONG_AGO);
        writeFileSync(path.join(repo, 'huge.js'), `${'y'.repeat(100)}\n`.repeat(2000));
        writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n');
      })).toBe(true);
    } finally {
      delete process.env.WHY_DIFF_REDIFF_MAX_BYTES;
    }
  });
  it('blocks (fail closed) when the test file of the session cannot be re-diffed as text', async () => {
    process.env.WHY_DIFF_REDIFF_MAX_BYTES = '200';
    try {
      expect(await editedRepo((repo) => writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js -diff\n'))).toBe(true);
    } finally {
      delete process.env.WHY_DIFF_REDIFF_MAX_BYTES;
    }
  });
  it('blocks (fail closed) on an unreviewed package.json the session edited', async () => {
    const { repo, home } = makeRepo();
    const pkg = path.join(repo, 'package.json');
    writeFileSync(pkg, `${JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, pad: 'p'.repeat(400) }, null, 2)}\n`);
    sh(repo, ['add', 'package.json']);
    sh(repo, ['commit', '-qm', 'pkg'], LONG_AGO);
    const callAt = Date.now() - 60_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-pkg', [{ prompt: 'speed up tests', at: iso(callAt - 60_000), calls: [
      { tool: 'Edit', at: iso(callAt), input: { file_path: pkg, old_string: '"vitest run"', new_string: '"exit 0"' } },
    ] }]);
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"vitest run"', '"exit 0"'));
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.json -diff\n');
    process.env.WHY_DIFF_REDIFF_MAX_BYTES = '200';
    try {
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-pkg' }, { blocking: BL, home, objectTime: oldObjects });
      expect(r.block).toBe(true);
      expect(r.message).toContain('package.json unreviewed');
    } finally {
      delete process.env.WHY_DIFF_REDIFF_MAX_BYTES;
    }
  });
  it('blocks (fail closed) when the filter listing cannot be read', async () => {
    expect(await editedRepo((repo) => appendFileSync(path.join(repo, '.git', 'config'), '[broken\n'))).toBe(true);
  });
  it('blocks with a filter whose name holds "="', async () => {
    expect(await editedRepo((repo) => {
      writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.js filter=a=b\n');
      appendFileSync(path.join(repo, '.git', 'config'), '[filter "a=b"]\n\tclean = sed s/it.skip/it/\n');
    })).toBe(true);
  });
  it('blocks with diff.noprefix, diff.mnemonicPrefix and diff.relative set', async () => {
    expect(await editedRepo((repo) => {
      sh(repo, ['config', 'diff.noprefix', 'true']);
      sh(repo, ['config', 'diff.mnemonicPrefix', 'true']);
      sh(repo, ['config', 'diff.relative', 'true']);
    })).toBe(true);
  });
});

/** True when this file system treats names case-insensitively (macOS, Windows defaults). */
function caseInsensitiveFs(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'TEST')).ino === statSync(path.join(dir, 'test')).ino;
  } catch {
    return false;
  }
}

describe('sec030 #6: an edit path spelled in another case', () => {
  it('blocks on an Edit to TEST/F.test.js when the file system ignores case', async (ctx) => {
    const { repo, home } = makeRepo();
    if (!caseInsensitiveFs(repo)) ctx.skip();
    const fp = path.join(repo, 'TEST', 'F.test.js');
    const transcript = writeSyntheticTranscript(home, repo, 's-case', [{ prompt: 'fix', at: iso(Date.now() - 120_000), calls: [
      { tool: 'Edit', at: iso(Date.now() - 60_000), input: { file_path: fp, old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
    ] }]);
    writeFileSync(fp, readFileSync(fp, 'utf8').replace('it("t5"', 'it.skip("t5"'));
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-case' }, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
  });

  it('blocks even when the agent set core.ignorecase=false on a case-insensitive file system', async (ctx) => {
    const { repo, home } = makeRepo();
    if (!caseInsensitiveFs(repo)) ctx.skip();
    sh(repo, ['config', 'core.ignorecase', 'false']);
    const fp = path.join(repo, 'TEST', 'F.test.js');
    const transcript = writeSyntheticTranscript(home, repo, 's-case2', [{ prompt: 'fix', at: iso(Date.now() - 120_000), calls: [
      { tool: 'Edit', at: iso(Date.now() - 60_000), input: { file_path: fp, old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
    ] }]);
    writeFileSync(fp, readFileSync(fp, 'utf8').replace('it("t5"', 'it.skip("t5"'));
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-case2' }, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
  });

  it('blocks on an rm of the test file spelled in another case', async (ctx) => {
    const { repo, home } = makeRepo();
    if (!caseInsensitiveFs(repo)) ctx.skip();
    const transcript = writeSyntheticTranscript(home, repo, 's-case3', [{ prompt: 'clean', at: iso(Date.now() - 120_000), calls: [
      bash(Date.now() - 60_000, `cd ${shellPath(repo)} && rm TEST/F.TEST.JS`),
    ] }]);
    rmSync(tp(repo));
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-case3' }, { blocking: BL, home, statTime: async () => 0, objectTime: oldObjects });
    expect(r.block).toBe(true);
  });
});

describe('sec030 #7: the session base does not trust committer dates', () => {
  /** Real object times, except that the setup commit counts as written before the session. */
  const setupCommitOld = (repo: string): ((p: string) => Promise<number>) => {
    const init = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    return async (p: string) => (p.split(path.sep).join('/').endsWith(`/${init.slice(0, 2)}/${init.slice(2)}`) ? 0 : (await lstat(p)).ctimeMs);
  };
  it('blocks on an agent edit committed with a backdated GIT_COMMITTER_DATE', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-bd', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
      bash(t0 + 20_000, 'GIT_COMMITTER_DATE=2026-01-02T00:00:00Z git commit -qam wip'),
    ] }]);
    const objectTime = setupCommitOld(repo);
    skipT5(repo);
    sh(repo, ['commit', '-qam', 'wip'], new Date(Date.parse(LONG_AGO) + 1000).toISOString());
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-bd' }, { blocking: BL, home, objectTime });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('never falls back to a commit written during the session: with an expired reflog, the first-parent history decides', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-exp', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
      bash(t0 + 20_000, 'GIT_COMMITTER_DATE=2026-01-02T00:00:00Z git commit -qam wip && git reflog expire --expire=now --all'),
    ] }]);
    const objectTime = setupCommitOld(repo);
    skipT5(repo);
    sh(repo, ['commit', '-qam', 'wip'], new Date(Date.parse(LONG_AGO) + 1000).toISOString());
    sh(repo, ['reflog', 'expire', '--expire=now', '--all']);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-exp' }, { blocking: BL, home, objectTime });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('fails closed when every commit was written during the session', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-all', [{ prompt: 'tidy', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: path.join(repo, 'fix.js'), old_string: 'const fs', new_string: 'const fs2' } },
    ] }]);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-all' }, { blocking: BL, home });
    expect(r.block).toBe(true);
    expect(r.message).toContain('could not check');
  });

  it('does not trust a base commit found only in an alternate object store (fails closed)', async () => {
    const { repo: origin, home } = makeRepo();
    const repo = temp('wd-sec-shared-');
    execFileSync('git', ['clone', '-q', '--shared', origin, repo], { stdio: 'pipe' });
    const fp = path.join(repo, 'test', 'f.test.js');
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-alt', [{ prompt: 'tidy', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: fp, old_string: 'it("t5"', new_string: 'it("t5 renamed"' } },
    ] }]);
    writeFileSync(fp, readFileSync(fp, 'utf8').replace('it("t5"', 'it("t5 renamed"'));
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-alt' }, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
    expect(r.message).toContain('could not check');
  });

  it('ignores git replace refs: a pre-session base replaced by the agent commit still shows the change', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-repl', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
      bash(t0 + 20_000, 'git stash && git commit ... && git replace'),
    ] }]);
    const objectTime = setupCommitOld(repo);
    const init = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    skipT5(repo);
    sh(repo, ['commit', '-qam', 'wip']);
    const wip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    sh(repo, ['reset', '-q', '--soft', init]);
    sh(repo, ['replace', init, wip]);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-repl' }, { blocking: BL, home, objectTime });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
  });

  it('fails closed when .git/shallow changed during the session', async () => {
    const { repo, home } = makeRepo();
    const init = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(path.join(repo, '.git', 'shallow'), `${init}\n`);
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-sh', [{ prompt: 'tidy', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: path.join(repo, 'fix.js'), old_string: 'const fs', new_string: 'const fs2' } },
    ] }]);
    const shallow = path.join(repo, '.git', 'shallow');
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-sh' }, { blocking: BL, home, objectTime: async (p) => (p === shallow ? Date.now() : oldObjects(p)) });
    expect(r.block).toBe(true);
    expect(r.message).toContain('shallow');
  });

  it('trusts a base commit inside a pack that predates the session', async () => {
    const { repo, home } = makeRepo();
    sh(repo, ['gc', '-q']);
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-oldpk', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
    ] }]);
    skipT5(repo);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-oldpk' }, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
    expect(r.message).toContain('test-skip-added');
    expect(r.message).not.toContain('could not check');
  });

  it('fails closed when a pack index was rewritten during the session, even next to an old pack', async () => {
    const { repo, home } = makeRepo();
    sh(repo, ['gc', '-q']);
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-idx', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
    ] }]);
    skipT5(repo);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-idx' }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return p.endsWith('.idx') ? Date.now() : 0; } });
    expect(r.block).toBe(true);
    expect(r.message).toContain('could not check');
  });

  it('does not trust a packed commit when a pack was written during the session', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-pk', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
    ] }]);
    skipT5(repo);
    sh(repo, ['commit', '-qam', 'wip'], new Date(Date.parse(LONG_AGO) + 1000).toISOString());
    sh(repo, ['gc', '-q']);
    // loose objects are gone; packs carry real (in-session) times
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-pk' }, { blocking: BL, home, objectTime: async (p) => { await lstat(p); return p.endsWith('.pack') ? Date.now() : 0; } });
    expect(r.block).toBe(true);
    expect(r.block).toBe(true);
  });

  it('blocks on a backdated agent commit that was then packed away with git gc', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-gc', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
      bash(t0 + 20_000, 'GIT_COMMITTER_DATE=2026-01-02T00:00:00Z git commit -qam wip && git gc -q'),
    ] }]);
    skipT5(repo);
    sh(repo, ['commit', '-qam', 'wip'], new Date(Date.parse(LONG_AGO) + 1000).toISOString());
    sh(repo, ['gc', '-q']);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-gc' }, { blocking: BL, home });
    expect(r.block).toBe(true);
  });

  it('blocks when the agent amended the pre-session commit (base no longer an ancestor of HEAD)', async () => {
    const { repo, home } = makeRepo();
    const t0 = Date.now() - 120_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-amend', [{ prompt: 'fix', at: iso(t0), calls: [
      { tool: 'Edit', at: iso(t0 + 10_000), input: { file_path: tp(repo), old_string: 'it("t5"', new_string: 'it.skip("t5"' } },
      bash(t0 + 20_000, 'git commit -qa --amend --no-edit'),
    ] }]);
    skipT5(repo);
    const objectTime = setupCommitOld(repo);
    sh(repo, ['commit', '-qa', '--amend', '--no-edit'], LONG_AGO);
    const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-amend' }, { blocking: BL, home, objectTime });
    expect(r.block).toBe(true);
  });
});

describe('sec030: index flags (assume-unchanged, skip-worktree) cannot hide a change', () => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    it(`blocks on an agent it.skip in a test file flagged ${flag}`, async () => {
      const { repo, home } = makeRepo();
      const callAt = Date.now() - 60_000;
      const transcript = writeSyntheticTranscript(home, repo, 's-flag', [{ prompt: 'fix t5', at: iso(callAt - 60_000), calls: [
        { tool: 'Edit', at: iso(callAt), input: { file_path: tp(repo), old_string: 'it("t5",()=>{\n', new_string: 'it.skip("t5",()=>{\n' } },
        bash(callAt + 5000, `git update-index ${flag} test/f.test.js`),
      ] }]);
      skipT5(repo);
      sh(repo, ['update-index', flag, 'test/f.test.js']);
      const r = await runGuard({ transcript_path: transcript, cwd: repo, session_id: 's-flag' }, { blocking: BL, home, objectTime: oldObjects });
      expect(r.block).toBe(true);
      expect(r.message).toContain('test-skip-added');
    });
  }
});

describe('sec030 #8: nothing the agent can write switches a block off', () => {
  function setup(): { repo: string; home: string; transcript: string; payload: { transcript_path: string; cwd: string; session_id: string } } {
    const { repo, home } = makeRepo();
    const callAt = Date.now() - 60_000;
    const transcript = writeSyntheticTranscript(home, repo, 's-dd', [{ prompt: 'fix t5', at: iso(callAt - 60_000), calls: [
      { tool: 'Edit', at: iso(callAt), input: { file_path: tp(repo), old_string: 'it("t5",()=>{\n', new_string: 'it.skip("t5",()=>{\n' } },
    ] }]);
    skipT5(repo);
    return { repo, home, transcript, payload: { transcript_path: transcript, cwd: repo, session_id: 's-dd' } };
  }
  const deliveredLine = (message: string): string => JSON.stringify({
    parentUuid: null, isSidechain: false, type: 'attachment', uuid: '99999999-2222-4333-8444-000000000001', timestamp: new Date().toISOString(), sessionId: 's-dd',
    attachment: { type: 'hook_blocking_error', hookName: 'Stop', toolUseID: 'x', hookEvent: 'Stop', blockingError: { blockingError: message, command: 'why-diff guard' } },
  });

  it('the agent running the guard itself first does not pre-empt the real Stop hook', async () => {
    const { home, payload } = setup();
    const agentRun = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    expect(agentRun.block).toBe(true);
    const real = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    expect(real.block).toBe(true);
  });

  it('a forged .why-diff/guard-state.json changes nothing', async () => {
    const { repo, home, payload } = setup();
    mkdirSync(path.join(repo, '.why-diff'));
    writeFileSync(path.join(repo, '.why-diff', 'guard-state.json'), JSON.stringify({ 's-dd': { hash: 'x'.repeat(64), at: new Date().toISOString() } }));
    expect((await runGuard(payload, { blocking: BL, home, objectTime: oldObjects })).block).toBe(true);
  });

  it('the guard message in a tool result (the agent ran why-diff guard in Bash) does not count as delivered', async () => {
    const { home, transcript, payload } = setup();
    const first = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    appendFileSync(transcript, `${JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(), sessionId: 's-dd',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_zz', content: first.message }] },
      toolUseResult: { stdout: '', stderr: first.message, interrupted: false },
    })}\n`);
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: first.message }] } })}\n`);
    expect((await runGuard(payload, { blocking: BL, home, objectTime: oldObjects })).block).toBe(true);
  });

  it('after a delivered block the same hits block again with a short message; a new risky edit gets the full one', async () => {
    const { repo, home, transcript, payload } = setup();
    const first = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    expect(first.block).toBe(true);
    appendFileSync(transcript, `${deliveredLine(first.message!)}\n`);
    const repeat = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    expect(repeat.block).toBe(true);
    expect(repeat.message).toContain('still present');
    expect(repeat.message!.split('\n').length).toBeLessThan(first.message!.split('\n').length);

    const t2 = writeSyntheticTranscript(home, repo, 's-dd', [{ prompt: 'fix t5', at: iso(Date.now() - 120_000), calls: [
      { tool: 'Edit', at: iso(Date.now() - 60_000), input: { file_path: tp(repo), old_string: 'it("t5",()=>{\n', new_string: 'it.skip("t5",()=>{\n' } },
      { tool: 'Edit', at: iso(Date.now() - 50_000), input: { file_path: tp(repo), old_string: 'it("t9",()=>{\n', new_string: 'it.skip("t9",()=>{\n' } },
    ] }]);
    appendFileSync(t2, `${deliveredLine(first.message!)}\n`);
    writeFileSync(tp(repo), readFileSync(tp(repo), 'utf8').replace('it("t9"', 'it.skip("t9"'));
    const again = await runGuard({ ...payload, transcript_path: t2 }, { blocking: BL, home, objectTime: oldObjects });
    expect(again.block).toBe(true);
    expect(again.message).toContain('include risky edits');
  });

  it('a delivery line the agent appended to its transcript does not switch the block off', async () => {
    const { home, transcript, payload } = setup();
    const first = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_forge', name: 'Bash', input: { command: 'echo >> transcript' } }] } })}\n`);
    appendFileSync(transcript, `${deliveredLine(first.message!)}\n`);
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_forge', content: '' }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false } })}\n`);
    expect((await runGuard(payload, { blocking: BL, home, objectTime: oldObjects })).block).toBe(true);
  });

  it('a stop_hook_summary system line also selects the short message, and still blocks', async () => {
    const { home, transcript, payload } = setup();
    const first = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: new Date().toISOString(), hookCount: 1, hookInfos: [{ command: 'why-diff guard' }], hookErrors: [first.message], preventedContinuation: false })}\n`);
    const r = await runGuard(payload, { blocking: BL, home, objectTime: oldObjects });
    expect(r.block).toBe(true);
    expect(r.message).toContain('still present');
  });
});
