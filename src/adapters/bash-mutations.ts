/**
 * Best-effort detection of file mutations performed by shell commands an agent
 * ran (`sed -i`, `>` redirects, `tee`, `mv`, `rm`, `git checkout -- f`,
 * `npm install`, formatters, ...).
 *
 * The command is tokenised with a small POSIX-ish lexer (quotes, escapes,
 * `$(...)`, heredocs, redirections, `&&`/`||`/`;`/`|` chains) and each simple
 * command is matched against known mutating programs. `cd` segments update the
 * directory used to resolve relative paths of later segments.
 *
 * This is deliberately heuristic: the goal is "which files did this command
 * most likely touch", so that hunks in those files can at least be attributed
 * as `file-only` and labelled `bash-edit`.
 */

import os from 'node:os';
import path from 'node:path';

export type MutationOp =
  | 'write'
  | 'append'
  | 'edit'
  | 'delete'
  | 'move'
  | 'copy'
  | 'restore'
  | 'install'
  | 'format'
  | 'touch'
  | 'chmod';

export interface BashMutation {
  /** Absolute path (may contain glob characters, or point at a directory). */
  path: string;
  op: MutationOp;
  /** Written content when it can be recovered (`cat <<EOF > f`, `echo x > f`). */
  content?: string;
}

interface Redirect {
  op: '>' | '>>' | '<' | '<<' | '<<<' | '>&' | '<&';
  /** Target word (file name) or heredoc delimiter; absent for fd duplication. */
  target?: string;
  /** Body of a heredoc, filled once the body lines were read. */
  body?: string;
}

interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
}

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'redirect'; redirect: Redirect };

const PATH_LIKE = /[\\/.]|^[A-Za-z0-9_-]+$/;

/**
 * Detect files mutated by `command`, resolving relative paths against `cwd`.
 */
export function detectBashMutations(command: string, cwd: string): BashMutation[] {
  const commands = splitSimpleCommands(tokenize(command));
  const out: BashMutation[] = [];
  let dir = cwd;
  const seen = new Set<string>();

  const push = (p: string, op: MutationOp, content?: string): void => {
    if (!p || p === '-' || p === '/dev/null' || p.startsWith('/dev/')) return;
    const abs = resolvePath(dir, p);
    const key = `${op}\0${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(content === undefined ? { path: abs, op } : { path: abs, op, content });
  };

  for (const cmd of commands) {
    const words = stripWrappers(cmd.words);
    const prog = path.basename(words[0] ?? '');
    const args = words.slice(1);

    if (prog === 'cd' || prog === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'));
      if (target) dir = resolvePath(dir, target);
      continue;
    }

    // Output redirections apply to any program.
    for (const r of cmd.redirects) {
      if ((r.op === '>' || r.op === '>>') && r.target) {
        push(r.target, r.op === '>' ? 'write' : 'append', recoverContent(words, cmd.redirects));
      }
    }

    switch (prog) {
      case 'tee': {
        const append = args.some((a) => a === '-a' || a === '--append');
        for (const f of positional(args)) push(f, append ? 'append' : 'write');
        break;
      }
      case 'sed': {
        // `-i`, `-i.bak`, `-ni`, `-Ei`, `--in-place[=SUFFIX]`
        if (!args.some((a) => /^-[nErsuz]*i/.test(a) || a.startsWith('--in-place'))) break;
        for (const f of sedFiles(args)) push(f, 'edit');
        break;
      }
      case 'perl': {
        // `-i`, `-pi`, `-pi.bak`, `-0777 -i` (not `-MList::Util`)
        if (!args.some((a) => /^-[pnlwaF0-9]*i/.test(a))) break;
        for (const f of perlFiles(args)) push(f, 'edit');
        break;
      }
      case 'mv': {
        for (const { src, dest } of moveTargets(args)) {
          push(src, 'move');
          push(dest, 'write');
        }
        break;
      }
      case 'cp': {
        for (const { dest } of moveTargets(args)) push(dest, 'copy');
        break;
      }
      case 'rm':
      case 'unlink':
        for (const f of positional(args)) push(f, 'delete');
        break;
      case 'touch':
        for (const f of positional(args, new Set(['-d', '-r', '-t']))) push(f, 'touch');
        break;
      case 'chmod':
      case 'chown': {
        const files = positional(args, new Set(['--reference']));
        for (const f of files.slice(1)) push(f, 'chmod'); // first positional is the mode/owner
        break;
      }
      case 'truncate':
        for (const f of positional(args, new Set(['-s', '--size', '-r', '--reference']))) push(f, 'write');
        break;
      case 'ln': {
        const files = positional(args);
        const link = files[files.length - 1];
        if (files.length >= 2 && link) push(link, 'write');
        break;
      }
      case 'git':
        for (const m of gitMutations(args)) push(m.path, m.op);
        break;
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun':
      case 'cargo':
      case 'poetry':
      case 'uv':
      case 'go':
      case 'composer':
        for (const f of packageManagerFiles(prog, args)) push(f, 'install');
        break;
      default: {
        for (const f of formatterFiles(prog, args)) push(f, 'format');
        for (const f of inlineScriptWrites(prog, args, cmd.redirects)) push(f, 'edit');
      }
    }
  }
  return out;
}

const SCRIPT_PATH = String.raw`(['"\`])([^'"\`\n$\{}]+?)\1`;
const SCRIPT_WRITERS: Record<string, { flag: string; writes: RegExp[]; assign: (v: string) => RegExp }> = {
  python: {
    flag: '-c',
    writes: [
      // open(p, 'w') / open('f', "a") / io.open(...)
      new RegExp(String.raw`\bopen\(\s*(?:${SCRIPT_PATH}|([A-Za-z_]\w*))\s*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]`, 'g'),
      // Path('f').write_text(...) / p.write_text(...)
      new RegExp(String.raw`(?:Path\(\s*${SCRIPT_PATH}\s*\)|\b([A-Za-z_]\w*))\.write_(?:text|bytes)\(`, 'g'),
    ],
    assign: (v) => new RegExp(String.raw`(?:^|[\s;(,])${v}\s*=\s*(?:Path\()?\s*${SCRIPT_PATH}`, 'gm'),
  },
  node: {
    flag: '-e',
    writes: [new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\(\s*(?:${SCRIPT_PATH}|([A-Za-z_$][\w$]*))`, 'g')],
    assign: (v) => new RegExp(String.raw`(?:^|[\s;(,])${v.replace(/\$/g, '\\$')}\s*=\s*${SCRIPT_PATH}`, 'gm'),
  },
};

/**
 * Files an inline interpreter script writes (`python3 - <<EOF`, `python3 -c`,
 * `node -e`, `node <<EOF`): a literal path passed to open(..., 'w'),
 * write_text or writeFileSync, or a variable assigned a literal path (also as
 * the list of a `for v in [...]` loop). The content stays unknown.
 */
function inlineScriptWrites(prog: string, args: string[], redirects: Redirect[]): string[] {
  const lang = /^python(\d(\.\d+)?)?$/.test(prog) ? 'python' : prog === 'node' ? 'node' : null;
  if (!lang) return [];
  const spec = SCRIPT_WRITERS[lang];
  if (!spec) return [];
  const flagAt = args.indexOf(spec.flag);
  const script = flagAt !== -1 ? args[flagAt + 1] : redirects.find((r) => r.op === '<<' && r.body !== undefined)?.body;
  if (!script) return [];
  const files = new Set<string>();
  for (const re of spec.writes) {
    for (const m of script.matchAll(re)) {
      if (m[2]) files.add(m[2]);
      const v = m[3];
      if (!v) continue;
      for (const a of script.matchAll(spec.assign(v))) if (a[2]) files.add(a[2]);
      const loop = new RegExp(String.raw`\bfor\s+(?:const\s+|let\s+)?${v}\s+(?:in|of)\s*[[(]([^\])]*)[\])]`).exec(script);
      if (loop?.[1]) for (const l of loop[1].matchAll(new RegExp(SCRIPT_PATH, 'g'))) if (l[2]) files.add(l[2]);
    }
  }
  return [...files].filter((f) => /[\w-]\.[A-Za-z0-9]{1,10}$|\//.test(f) && !/\s/.test(f));
}

/** Positional (non-option) arguments; `valueOptions` take a following value that is skipped. */
function positional(args: string[], valueOptions = new Set<string>()): string[] {
  const out: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (endOfOptions) {
      out.push(a);
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueOptions.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `sed` file operands: everything positional except the script. */
function sedFiles(args: string[]): string[] {
  const files: string[] = [];
  let scriptSeen = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('-') && a.length > 1) {
      if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
        scriptSeen = true;
        i++;
      } else if (a.startsWith('--expression=') || a.startsWith('--file=')) {
        scriptSeen = true;
      } else if (/^-[a-zA-Z]*e$/.test(a)) {
        // `-ne 's/x/y/'`: clustered flags ending in -e take the next word as the script
        scriptSeen = true;
        i++;
      } else if (a === '-i' && args[i + 1] === '') {
        i++; // BSD `sed -i '' ...`: the empty suffix argument
      }
      continue;
    }
    if (!endOfOptions && a === '' ) continue;
    if (!scriptSeen) {
      scriptSeen = true; // first positional is the script
      continue;
    }
    files.push(a);
  }
  return files;
}

/** `perl -pi -e '...' files` operands. */
function perlFiles(args: string[]): string[] {
  const files: string[] = [];
  let scriptSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith('-') && a.length > 1) {
      if (/^-[a-zA-Z0-9]*[eE]$/.test(a)) {
        scriptSeen = true;
        i++;
      }
      continue;
    }
    if (!scriptSeen) {
      scriptSeen = true; // `perl script.pl files`
      continue;
    }
    files.push(a);
  }
  return files;
}

/**
 * Source/destination pairs of `mv`/`cp`: `mv a b`, `mv a b dir`, and the target-directory
 * forms `mv -t dir a b`, `mv --target-directory=dir a`, `mv a -t dir`.
 */
function moveTargets(args: string[]): Array<{ src: string; dest: string }> {
  let targetDir: string | undefined;
  const rest: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!endOfOptions && (a === '-t' || a === '--target-directory')) {
      targetDir = args[++i];
      continue;
    }
    if (!endOfOptions && a.startsWith('--target-directory=')) {
      targetDir = a.slice('--target-directory='.length);
      continue;
    }
    if (!endOfOptions && /^-[A-Za-z]*t$/.test(a) && a.length > 2) {
      targetDir = args[++i]; // clustered `-ft dir`
      continue;
    }
    if (a === '--') endOfOptions = true;
    rest.push(a);
  }
  const files = positional(rest);
  if (targetDir !== undefined) {
    const dir = targetDir;
    return files.map((src) => ({ src, dest: path.posix.join(dir, path.posix.basename(src)) }));
  }
  if (files.length < 2) return [];
  const dest = files[files.length - 1] ?? '';
  return files.slice(0, -1).map((src) => ({ src, dest: destinationFor(src, dest, files.length > 2) }));
}

/** `mv a dir/` → `dir/a`; `mv a b c dir` → `dir/a`, `dir/b`. */
function destinationFor(src: string, dest: string, multiple: boolean): string {
  if (multiple || dest.endsWith('/') || dest === '.' || dest === '..') {
    return path.posix.join(dest, path.posix.basename(src));
  }
  return dest;
}

function gitMutations(args: string[]): Array<{ path: string; op: MutationOp }> {
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub) return [];
  const rest = args.slice(args.indexOf(sub) + 1);
  const afterDashDash = (list: string[]): string[] | null => {
    const i = list.indexOf('--');
    return i === -1 ? null : list.slice(i + 1);
  };
  switch (sub) {
    case 'checkout': {
      const files = afterDashDash(rest);
      if (!files) return [];
      return files.map((p) => ({ path: p, op: 'restore' as const }));
    }
    case 'restore': {
      const files = afterDashDash(rest) ?? positional(rest, new Set(['-s', '--source']));
      return files.map((p) => ({ path: p, op: 'restore' as const }));
    }
    case 'rm':
      return (afterDashDash(rest) ?? positional(rest)).map((p) => ({ path: p, op: 'delete' as const }));
    case 'mv': {
      const files = positional(rest);
      const dest = files[files.length - 1];
      if (files.length < 2 || !dest) return [];
      return [
        ...files.slice(0, -1).map((p) => ({ path: p, op: 'move' as const })),
        ...files.slice(0, -1).map((p) => ({ path: destinationFor(p, dest, files.length > 2), op: 'write' as const })),
      ];
    }
    default:
      return [];
  }
}

const NPM_MUTATING = new Set(['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'un', 'r', 'update', 'up', 'dedupe', 'pkg', 'link']);
const PNPM_MUTATING = new Set(['add', 'install', 'i', 'remove', 'rm', 'update', 'up', 'dedupe', 'link']);
const YARN_MUTATING = new Set(['add', 'remove', 'install', 'up', 'upgrade', 'dedupe']);
const BUN_MUTATING = new Set(['add', 'remove', 'rm', 'install', 'i', 'update']);

/** Manifest + lockfile a package-manager invocation rewrites. */
function packageManagerFiles(prog: string, args: string[]): string[] {
  const sub = args.find((a) => !a.startsWith('-')) ?? (prog === 'yarn' ? 'install' : '');
  const hasPackages = positional(args.slice(args.indexOf(sub) + 1)).length > 0;
  switch (prog) {
    case 'npm':
      if (!NPM_MUTATING.has(sub)) return [];
      return hasPackages || sub === 'pkg' || sub === 'uninstall' ? ['package.json', 'package-lock.json'] : ['package-lock.json'];
    case 'pnpm':
      if (!PNPM_MUTATING.has(sub)) return [];
      return hasPackages ? ['package.json', 'pnpm-lock.yaml'] : ['pnpm-lock.yaml'];
    case 'yarn':
      if (!YARN_MUTATING.has(sub)) return [];
      return hasPackages ? ['package.json', 'yarn.lock'] : ['yarn.lock'];
    case 'bun':
      if (!BUN_MUTATING.has(sub)) return [];
      return hasPackages ? ['package.json', 'bun.lock', 'bun.lockb'] : ['bun.lock', 'bun.lockb'];
    case 'cargo':
      if (!['add', 'remove', 'rm', 'update'].includes(sub)) return [];
      return sub === 'update' ? ['Cargo.lock'] : ['Cargo.toml', 'Cargo.lock'];
    case 'poetry':
      if (!['add', 'remove', 'update', 'lock'].includes(sub)) return [];
      return sub === 'lock' || sub === 'update' ? ['poetry.lock'] : ['pyproject.toml', 'poetry.lock'];
    case 'uv':
      if (!['add', 'remove', 'lock', 'sync'].includes(sub)) return [];
      return sub === 'lock' || sub === 'sync' ? ['uv.lock'] : ['pyproject.toml', 'uv.lock'];
    case 'go':
      if (sub === 'get' || (sub === 'mod' && args.includes('tidy'))) return ['go.mod', 'go.sum'];
      return [];
    case 'composer':
      if (!['require', 'remove', 'update', 'install'].includes(sub)) return [];
      return sub === 'require' || sub === 'remove' ? ['composer.json', 'composer.lock'] : ['composer.lock'];
    default:
      return [];
  }
}

const FORMATTERS: Record<string, { writeFlag?: RegExp; subcommands?: string[] }> = {
  prettier: { writeFlag: /^(-w|--write)$/ },
  eslint: { writeFlag: /^--fix$/ },
  biome: { writeFlag: /^(--write|--apply|--fix)$/, subcommands: ['format', 'check', 'lint'] },
  black: {},
  ruff: { writeFlag: /^(format|--fix)$/ },
  isort: {},
  gofmt: { writeFlag: /^-w$/ },
  goimports: { writeFlag: /^-w$/ },
  rustfmt: {},
  'clang-format': { writeFlag: /^-i$/ },
  shfmt: { writeFlag: /^-w$/ },
  stylua: {},
  dprint: { subcommands: ['fmt'] },
  'swift-format': { writeFlag: /^(-i|--in-place)$/, subcommands: ['format'] },
};

/** Paths a formatter was asked to rewrite in place. */
function formatterFiles(prog: string, args: string[]): string[] {
  const spec = FORMATTERS[prog];
  if (!spec) return [];
  if (spec.writeFlag && !args.some((a) => spec.writeFlag?.test(a))) return [];
  let rest = args;
  if (spec.subcommands) {
    const sub = rest.find((a) => !a.startsWith('-'));
    if (!sub || !spec.subcommands.includes(sub)) return [];
    rest = rest.filter((a) => a !== sub);
  }
  if (prog === 'ruff') rest = rest.filter((a) => a !== 'format' && a !== 'check');
  return positional(rest, new Set(['--config', '-c', '--ignore-path', '--log-level'])).filter((p) => PATH_LIKE.test(p));
}

/** Content written by `cat <<EOF > f` or `echo ... > f`, when recoverable. */
function recoverContent(words: string[], redirects: Redirect[]): string | undefined {
  const prog = path.basename(words[0] ?? '');
  if (prog === 'cat') {
    const heredoc = redirects.find((r) => r.op === '<<' && r.body !== undefined);
    const fileArgs = words.slice(1).filter((w) => w !== '-' && !w.startsWith('-'));
    if (heredoc && fileArgs.length === 0) return heredoc.body;
    return undefined;
  }
  if (prog === 'echo') {
    let args = words.slice(1);
    let newline = true;
    while (args[0] && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes('n')) newline = false;
      args = args.slice(1);
    }
    return args.join(' ') + (newline ? '\n' : '');
  }
  if (prog === 'printf') {
    const fmt = words[1];
    if (fmt !== undefined && words.length === 2 && !fmt.includes('%')) {
      return fmt.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
  }
  return undefined;
}

/** Drop `sudo`, `env VAR=x`, `time`, `nohup`, `npx`, `pnpm exec`, `bun x` ... prefixes. */
function stripWrappers(words: string[]): string[] {
  let w = words;
  for (;;) {
    while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const first = path.basename(w[0] ?? '');
    if (['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice'].includes(first)) {
      w = w.slice(1);
      while (w[0] && w[0].startsWith('-')) w = w.slice(1);
      continue;
    }
    if (['npx', 'bunx'].includes(first)) {
      w = w.slice(1);
      while (w[0] && w[0].startsWith('-')) w = w.slice(1);
      continue;
    }
    const second = w[1] ?? '';
    const twoWordWrapper =
      (first === 'pnpm' && (second === 'exec' || second === 'dlx')) ||
      (first === 'yarn' && (second === 'exec' || second === 'dlx')) ||
      (first === 'bun' && second === 'x') ||
      ((first === 'poetry' || first === 'uv') && second === 'run') ||
      ((first === 'python' || first === 'python3') && second === '-m');
    if (twoWordWrapper) {
      w = w.slice(2);
      continue;
    }
    return w;
  }
}

function resolvePath(dir: string, p: string): string {
  let expanded = p;
  if (expanded === '~' || expanded.startsWith('~/')) expanded = os.homedir() + expanded.slice(1);
  return path.resolve(dir, expanded);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Tokenise a shell command line into words, operators and redirections. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: Redirect[] = [];
  let buf = '';
  let inWord = false;
  let i = 0;

  const flush = (): void => {
    if (!inWord) return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'redirect' && last.redirect.target === undefined && last.redirect.op !== '>&' && last.redirect.op !== '<&') {
      last.redirect.target = buf;
      if (last.redirect.op === '<<') pendingHeredocs.push(last.redirect);
    } else {
      tokens.push({ kind: 'word', text: buf });
    }
    buf = '';
    inWord = false;
  };

  const readHeredocBodies = (): void => {
    for (const h of pendingHeredocs) {
      const delimiter = (h.target ?? '').replace(/^['"]|['"]$/g, '');
      const lines: string[] = [];
      for (;;) {
        if (i >= input.length) break;
        const nl = input.indexOf('\n', i);
        const line = nl === -1 ? input.slice(i) : input.slice(i, nl);
        i = nl === -1 ? input.length : nl + 1;
        if (line.replace(/^\t+/, '') === delimiter) break;
        lines.push(line);
      }
      h.body = lines.length ? `${lines.join('\n')}\n` : '';
    }
    pendingHeredocs.length = 0;
  };

  while (i < input.length) {
    const ch = input[i] ?? '';
    const next = input[i + 1] ?? '';

    if (ch === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      buf += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      buf += input.slice(i + 1, end === -1 ? input.length : end);
      inWord = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          buf += input[i + 1];
          i += 2;
        } else {
          buf += input[i];
          i++;
        }
      }
      i++;
      inWord = true;
      continue;
    }
    if (ch === '$' && next === '(') {
      const end = matchParen(input, i + 1);
      buf += input.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      buf += input.slice(i, end === -1 ? input.length : end + 1);
      inWord = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = input.indexOf('\n', i);
      i = nl === -1 ? input.length : nl;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      i++;
      continue;
    }
    if (ch === '\n') {
      flush();
      i++;
      if (pendingHeredocs.length) readHeredocBodies();
      tokens.push({ kind: 'op', text: ';' });
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')') {
      flush();
      tokens.push({ kind: 'op', text: ch });
      i++;
      continue;
    }
    if (ch === '&' && next === '&') {
      flush();
      tokens.push({ kind: 'op', text: '&&' });
      i += 2;
      continue;
    }
    if (ch === '|') {
      flush();
      tokens.push({ kind: 'op', text: next === '|' ? '||' : '|' });
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if (ch === '&' && next !== '>') {
      flush();
      tokens.push({ kind: 'op', text: ';' });
      i++;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      const fdPrefix = inWord && /^\d+$/.test(buf);
      if (fdPrefix) {
        buf = '';
        inWord = false;
      } else {
        flush();
      }
      let op: Redirect['op'];
      if (ch === '&') {
        op = input[i + 2] === '>' ? '>>' : '>';
        i += input[i + 2] === '>' ? 3 : 2;
      } else if (ch === '>') {
        if (next === '>') {
          op = '>>';
          i += 2;
        } else if (next === '&') {
          op = '>&';
          i += 2;
        } else {
          op = '>';
          i += next === '|' ? 2 : 1;
        }
      } else if (next === '<') {
        if (input[i + 2] === '<') {
          op = '<<<';
          i += 3;
        } else {
          op = '<<';
          i += input[i + 2] === '-' ? 3 : 2;
        }
      } else if (next === '&') {
        op = '<&';
        i += 2;
      } else {
        op = '<';
        i += 1;
      }
      const redirect: Redirect = { op };
      tokens.push({ kind: 'redirect', redirect });
      if (op === '>&' || op === '<&') {
        // fd duplication target (`2>&1`, `>&2`, `>&-`): skip it
        while (i < input.length && /[\d-]/.test(input[i] ?? '')) i++;
      }
      continue;
    }
    buf += ch;
    inWord = true;
    i++;
  }
  flush();
  if (pendingHeredocs.length) readHeredocBodies();
  return tokens;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      if (end === -1) return s.length - 1;
      i = end;
    }
  }
  return s.length - 1;
}

/** Group tokens into simple commands at `&&`, `||`, `;`, `|`, `(`, `)`. */
export function splitSimpleCommands(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  const close = (): void => {
    if (current.words.length || current.redirects.length) commands.push(current);
    current = { words: [], redirects: [] };
  };
  for (const t of tokens) {
    if (t.kind === 'op') close();
    else if (t.kind === 'word') current.words.push(t.text);
    else current.redirects.push(t.redirect);
  }
  close();
  return commands;
}
