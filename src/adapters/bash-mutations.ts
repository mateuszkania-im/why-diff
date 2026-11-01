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
  /** Per word, per character: `u` unquoted, `d` inside double quotes, `q` literal (single-quoted or escaped), `c` command substitution. */
  masks: string[];
  redirects: Redirect[];
  /** The command whose output is piped into this one (`a | b`). */
  pipeFrom?: SimpleCommand;
}

type Token =
  | { kind: 'word'; text: string; mask: string }
  | { kind: 'op'; text: string }
  | { kind: 'redirect'; redirect: Redirect };

const PATH_LIKE = /[\\/.]|^[A-Za-z0-9_-]+$/;

/**
 * Detect files mutated by `command`, resolving relative paths against `cwd`.
 *
 * Followed: `cd`, brace lists (`rm test/{a,b}.js`, `mv f{,.bak}`), variables assigned a literal
 * earlier on the same command line (`D=test; rm $D/*.js`, `export D=...`), `for v in <literal
 * list>` loops, `bash -c`/`sh -c`/`eval` scripts, `find ... -delete`/`-exec`, `ls|find ... |
 * xargs cmd`. Left unresolved (the path keeps its `$VAR`): variables from outside the command,
 * computed values (`$(...)`, backticks), and scripts that compute paths.
 */
export function detectBashMutations(command: string, cwd: string): BashMutation[] {
  return detect(command, cwd, 0, { words: MAX_TOTAL_WORDS, bytes: MAX_TOTAL_BYTES, scriptLimit: Math.max(4096, command.length * 4) });
}

const MAX_DEPTH = 4;
const MAX_EXPANSIONS = 256;
const MAX_TOTAL_WORDS = 10_000;
const MAX_TOTAL_BYTES = 1 << 20;

/**
 * Work left for one top-level command, shared by every nesting level (`eval`, `bash -c`,
 * `find -exec`, `xargs`): expanded words and their bytes. Once spent, words stay unexpanded
 * (unresolved). Nested scripts longer than `scriptLimit` are not followed.
 */
interface Budget {
  words: number;
  bytes: number;
  scriptLimit: number;
}
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const DECLARE = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
/** Reserved words that may start a simple command in a compound one (`do rm "$f"`, `then ...`). */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'done', 'fi', '}', 'esac']);

function detect(command: string, cwd: string, depth: number, budget: Budget): BashMutation[] {
  const commands = splitSimpleCommands(tokenize(command));
  const out: BashMutation[] = [];
  let dir = cwd;
  const seen = new Set<string>();
  const vars = new Map<string, string[]>();
  const expanded = new Map<SimpleCommand, string[]>();

  const push = (p: string, op: MutationOp, content?: string): void => {
    if (!p || p === '-' || p === '/dev/null' || p.startsWith('/dev/')) return;
    const abs = resolvePath(dir, p);
    const key = `${op}\0${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(content === undefined ? { path: abs, op } : { path: abs, op, content });
  };

  const nested = (script: string): void => {
    if (depth >= MAX_DEPTH || script.length > budget.scriptLimit || budget.words <= 0) return;
    for (const m of detect(script, dir, depth + 1, budget)) push(m.path, m.op, m.content);
  };

  /** Substitute `{}`/the xargs placeholder with targets: never a target holding `{}`, at most MAX_EXPANSIONS words. */
  const substitute = (words: string[], placeholder: string, targets: string[]): string[] => {
    const safe = targets.filter((t) => !t.includes('{}') && !t.includes(placeholder));
    return words.flatMap((w) => (w === placeholder ? safe : [w])).slice(0, MAX_EXPANSIONS);
  };

  const run = (words: string[], redirects: Redirect[], pipeFrom?: SimpleCommand, level = 0): void => {
    const prog = path.basename(words[0] ?? '');
    const args = words.slice(1);
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
      case 'unlink': {
        const recursive = prog === 'rm' && isRecursive(args);
        for (const f of positional(args)) {
          push(f, 'delete');
          if (recursive && GLOB_CHARS.test(f)) push(`${f.replace(/\/+$/, '')}/**`, 'delete'); // `rm -rf test/*` also removes what is below
        }
        break;
      }
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
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'dash':
      case 'ksh': {
        const flag = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        const script = flag === -1 ? undefined : args[flag + 1];
        if (script !== undefined) nested(script);
        break;
      }
      case 'eval':
        nested(args.join(' '));
        break;
      case 'find': {
        const f = findCommand(args);
        if (f.del) for (const t of f.targets) if (!t.includes('{}')) push(t, 'delete');
        if (f.exec && level < MAX_DEPTH) run(substitute(f.exec, '{}', f.targets), [], undefined, level + 1);
        break;
      }
      case 'xargs': {
        const x = xargsCommand(args, redirects);
        const producer = pipeFrom ? stripWrappers(expanded.get(pipeFrom) ?? pipeFrom.words) : [];
        const pprog = path.basename(producer[0] ?? '');
        const listed = pprog === 'ls' ? positional(producer.slice(1), new Set(['-I', '--ignore', '-w', '--width'])) : pprog === 'find' ? findCommand(producer.slice(1)).targets : [];
        if (!x || !listed.length || !x.cmd.length || level >= MAX_DEPTH) break;
        const cmdWords = x.replace !== undefined && x.cmd.includes(x.replace)
          ? substitute(x.cmd, x.replace, listed)
          : substitute([...x.cmd, '\0targets'], '\0targets', listed);
        run(cmdWords, [], undefined, level + 1);
        break;
      }
      case 'rimraf':
        for (const f of positional(args)) push(f, 'delete');
        break;
      case 'shred': {
        const remove = args.some((a) => a === '--remove' || a.startsWith('--remove=') || /^-[A-Za-z]*u[A-Za-z]*$/.test(a));
        for (const f of positional(args, new Set(['-n', '--iterations', '-s', '--size', '--random-source']))) push(f, remove ? 'delete' : 'write');
        break;
      }
      case 'dd':
        for (const a of args) if (a.startsWith('of=')) push(a.slice(3), 'write');
        break;
      case 'install': {
        if (args.some((a) => a === '-d' || a === '--directory' || /^-[A-Za-z]*d[A-Za-z]*$/.test(a))) break;
        const rest: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i] ?? '';
          if (['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix'].includes(a)) i++;
          else rest.push(a);
        }
        for (const { dest } of moveTargets(rest)) push(dest, 'copy');
        break;
      }
      default: {
        for (const f of formatterFiles(prog, args)) push(f, 'format');
        for (const f of inlineScriptWrites(prog, args, redirects)) push(f, 'edit');
      }
    }
  };

  for (const cmd of commands) {
    let pairs: Array<[string, string]> = cmd.words.map((w, i) => [w, cmd.masks[i] ?? 'u'.repeat(w.length)]);
    while (pairs[0] && KEYWORDS.has(pairs[0][0]) && !pairs[0][1].includes('q')) pairs = pairs.slice(1);
    const head = pairs[0]?.[0];

    // `for v in <list>`: a literal list binds v; anything computed leaves it unresolved.
    if (head === 'for' && pairs[2]?.[0] === 'in' && pairs[1]) {
      const name = pairs[1][0];
      const list = pairs.slice(3);
      if (list.length && !list.some(([w, m]) => computed(w, m))) vars.set(name, expandWords(list, new Map(), budget));
      else vars.delete(name);
      continue;
    }
    // `D=test`, `export D=test`: remember literal values for later commands of this line.
    const declStart = head !== undefined && DECLARE.has(head) ? 1 : 0;
    const assigns = pairs.slice(declStart);
    if (assigns.length && assigns.every(([w]) => ASSIGNMENT.test(w)) && !cmd.redirects.length) {
      for (const [w, m] of assigns) {
        const name = ASSIGNMENT.exec(w)?.[1] ?? '';
        const eq = name.length + 1;
        const value = w.slice(eq);
        if (computed(value, m.slice(eq))) vars.delete(name);
        else vars.set(name, [value]);
      }
      continue;
    }

    const words = expandWords(pairs, vars, budget);
    expanded.set(cmd, words);
    const stripped = stripWrappers(words);
    const prog = path.basename(stripped[0] ?? '');
    const args = stripped.slice(1);

    if (prog === 'cd' || prog === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'));
      if (target) dir = resolvePath(dir, target);
      continue;
    }

    // Output redirections apply to any program.
    for (const r of cmd.redirects) {
      if ((r.op === '>' || r.op === '>>') && r.target) {
        push(r.target, r.op === '>' ? 'write' : 'append', recoverContent(stripped, cmd.redirects));
      }
    }
    run(stripped, cmd.redirects, cmd.pipeFrom);
  }
  return out;
}

/** True when a word holds a command substitution or an unquoted/double-quoted `$` (its value is computed). */
function computed(word: string, mask: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const k = mask[i];
    if (k === 'c' || (word[i] === '$' && k !== 'q') || (word[i] === '`' && k !== 'q')) return true;
  }
  return false;
}

/**
 * Brace lists, then known variables, for each word: at most {@link MAX_EXPANSIONS} words per
 * command, and within the shared budget. A word that does not fit stays as written (unresolved).
 */
function expandWords(pairs: Array<[string, string]>, vars: Map<string, string[]>, budget: Budget): string[] {
  const out: string[] = [];
  for (const [w, m] of pairs) {
    const results: string[] = [];
    if (budget.words > 0 && budget.bytes > 0) {
      for (const [bw, bm] of expandBraces(w, m)) {
        for (const v of expandVars(bw, bm, vars)) {
          if (results.length >= MAX_EXPANSIONS || budget.words <= 0 || budget.bytes < v.length) break;
          budget.words--;
          budget.bytes -= v.length;
          results.push(v);
        }
      }
    }
    for (const v of results.length ? results : [w]) {
      if (out.length >= MAX_EXPANSIONS) return out;
      out.push(v);
    }
  }
  return out;
}

/** `pre{a,b}post` -> `preapost`, `prebpost` (unquoted braces with a top-level comma; nested lists too). */
function expandBraces(word: string, mask: string, budget = { n: MAX_EXPANSIONS }): Array<[string, string]> {
  if (budget.n <= 0 || word.length > 4096 || !word.includes('{')) return [[word, mask]];
  for (let open = word.indexOf('{'); open !== -1; open = word.indexOf('{', open + 1)) {
    if (mask[open] !== 'u') continue;
    let depth = 0;
    const commas: number[] = [];
    let close = -1;
    for (let i = open + 1; i < word.length; i++) {
      if (mask[i] !== 'u') continue;
      const c = word[i];
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) {
          close = i;
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) commas.push(i);
    }
    if (close === -1) return [[word, mask]];
    if (!commas.length) continue;
    const out: Array<[string, string]> = [];
    const cuts = [open, ...commas, close];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = (cuts[k] ?? 0) + 1;
      const b = cuts[k + 1] ?? 0;
      const text = word.slice(0, open) + word.slice(a, b) + word.slice(close + 1);
      const m = mask.slice(0, open) + mask.slice(a, b) + mask.slice(close + 1);
      for (const r of expandBraces(text, m, budget)) {
        if (budget.n-- <= 0) return out.length ? out : [[word, mask]];
        out.push(r);
      }
    }
    return out;
  }
  return [[word, mask]];
}

/** Substitute `$NAME` / `${NAME}` (unquoted or double-quoted) for variables known on this line. */
function expandVars(word: string, mask: string, vars: Map<string, string[]>): string[] {
  if (!vars.size || !word.includes('$')) return [word];
  let results = [''];
  let i = 0;
  while (i < word.length) {
    const c = word[i];
    if (c === '$' && mask[i] !== 'q' && mask[i] !== 'c') {
      const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(word.slice(i, i + 130));
      const name = m?.[1] ?? m?.[2];
      const values = name !== undefined ? vars.get(name) : undefined;
      if (m && values) {
        const next: string[] = [];
        for (const r of results) for (const v of values) if (next.length < MAX_EXPANSIONS && r.length + v.length <= 65_536) next.push(r + v);
        if (!next.length) return [word];
        results = next;
        i += m[0].length;
        continue;
      }
    }
    results = results.map((r) => r + c);
    i++;
  }
  return results;
}

/** `find [roots] expr`: the roots crossed with each `-name`, and the action (`-delete`, `-exec cmd {} ;|+`). */
function findCommand(args: string[]): { targets: string[]; del: boolean; exec?: string[] } {
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i] ?? '')) i++;
  const roots: string[] = [];
  while (i < args.length && !/^[-(!]/.test(args[i] ?? '')) roots.push(args[i++] ?? '');
  const names: string[] = [];
  let del = false;
  let exec: string[] | undefined;
  for (; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-name' || a === '-iname') names.push(args[++i] ?? '');
    else if (a === '-delete') del = true;
    else if (a === '-exec' || a === '-execdir') {
      const cmd: string[] = [];
      for (i++; i < args.length && args[i] !== ';' && args[i] !== '+'; i++) cmd.push(args[i] ?? '');
      if (cmd.includes('{}')) exec = cmd;
    }
  }
  const targets = (roots.length ? roots : ['.']).flatMap((r) => {
    const root = r.replace(/\/+$/, '') || '/';
    if (!names.length) return [root];
    return names.filter(Boolean).flatMap((n) => (root === '.' ? [n, `**/${n}`] : [path.posix.join(root, n), path.posix.join(root, '**', n)]));
  });
  return { targets, del, ...(exec ? { exec } : {}) };
}

const XARGS_VALUE_OPTIONS = new Set(['-n', '-I', '-i', '-P', '-d', '-L', '-l', '-s', '-E', '-e', '--max-args', '--replace', '--max-procs', '--delimiter', '--max-lines', '--max-chars', '--eof']);

/** The command xargs runs, and its `-I` placeholder; null when it reads a file (`-a f`, `< f`) instead of the pipe. */
function xargsCommand(args: string[], redirects: Redirect[]): { cmd: string[]; replace?: string } | null {
  if (redirects.some((r) => r.op === '<' || r.op === '<<' || r.op === '<<<')) return null;
  let replace: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-a' || a === '--arg-file' || a.startsWith('--arg-file=')) return null;
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-')) break;
    if (a === '-I' || a === '--replace') replace = args[i + 1];
    else if (a.startsWith('-I') && a.length > 2) replace = a.slice(2);
    if (XARGS_VALUE_OPTIONS.has(a)) i++;
  }
  return { cmd: args.slice(i), ...(replace !== undefined ? { replace } : {}) };
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

const GLOB_CHARS = /[*?[]/;

/** `-r`, `-R`, `-rf`, `-fr`, `--recursive` before the end of options. */
function isRecursive(args: string[]): boolean {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)) return true;
  }
  return false;
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
    case 'rm': {
      const recursive = isRecursive(rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length));
      return (afterDashDash(rest) ?? positional(rest)).flatMap((p) => [
        { path: p, op: 'delete' as const },
        ...(recursive && GLOB_CHARS.test(p) ? [{ path: `${p.replace(/\/+$/, '')}/**`, op: 'delete' as const }] : []),
      ]);
    }
    case 'clean': {
      const opts = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length).filter((a) => a.startsWith('-'));
      const force = opts.some((a) => a === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(a));
      const dry = opts.some((a) => a === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(a));
      if (!force || dry) return [];
      const files = afterDashDash(rest) ?? positional(rest, new Set(['-e', '--exclude']));
      return (files.length ? files : ['.']).map((p) => ({ path: p, op: 'delete' as const }));
    }
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

/** Options of wrapper programs that take a separate value (`sudo -u alice rm x`). */
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D', '-T', '--user', '--group', '--other-user', '--close-from', '--host', '--prompt', '--role', '--type', '--chdir']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
};

/** Drop `sudo`, `env VAR=x`, `time`, `nohup`, `npx`, `pnpm exec`, `bun x` ... prefixes. */
function stripWrappers(words: string[]): string[] {
  let w = words;
  for (;;) {
    while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const first = path.basename(w[0] ?? '');
    if (['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'doas'].includes(first)) {
      const valued = WRAPPER_VALUE_OPTIONS[first];
      w = w.slice(1);
      while (w[0] && w[0].startsWith('-') && w[0] !== '--') w = valued?.has(w[0]) ? w.slice(2) : w.slice(1);
      if (w[0] === '--') w = w.slice(1);
      continue;
    }
    if (first === 'busybox' || first === 'toybox') {
      w = w.slice(1);
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

/** Characters the lexer must look at one by one. */
const LEXER_SPECIAL = new Set(['\\', "'", '"', '$', '`', '#', ' ', '\t', '\n', ';', '(', ')', '&', '|', '<', '>']);

/** Tokenise a shell command line into words, operators and redirections. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: Redirect[] = [];
  let buf = '';
  let mask = '';
  let inWord = false;
  let i = 0;
  const add = (text: string, kind: string): void => {
    buf += text;
    mask += kind.repeat(text.length);
  };

  const flush = (): void => {
    if (!inWord) return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'redirect' && last.redirect.target === undefined && last.redirect.op !== '>&' && last.redirect.op !== '<&') {
      last.redirect.target = buf;
      if (last.redirect.op === '<<') pendingHeredocs.push(last.redirect);
    } else {
      tokens.push({ kind: 'word', text: buf, mask });
    }
    buf = '';
    mask = '';
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
      add(next, 'q');
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      add(input.slice(i + 1, end === -1 ? input.length : end), 'q');
      inWord = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          add(input[i + 1] ?? '', 'q');
          i += 2;
        } else if (input[i] === '$' && input[i + 1] === '(') {
          const end = matchParen(input, i + 1);
          add(input.slice(i, end + 1), 'c');
          i = end + 1;
        } else {
          add(input[i] ?? '', 'd');
          i++;
        }
      }
      i++;
      inWord = true;
      continue;
    }
    if (ch === '$' && next === '(') {
      const end = matchParen(input, i + 1);
      add(input.slice(i, end + 1), 'c');
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      add(input.slice(i, end === -1 ? input.length : end + 1), 'c');
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
      tokens.push({ kind: 'op', text: '&' }); // backgrounds the command before it; ends it like `;`
      i++;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      const fdPrefix = inWord && /^\d+$/.test(buf);
      if (fdPrefix) {
        buf = '';
        mask = '';
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
    // An ordinary character: take the whole run of ordinary characters at once.
    let j = i + 1;
    while (j < input.length && !LEXER_SPECIAL.has(input[j] ?? '')) j++;
    add(input.slice(i, j), 'u');
    inWord = true;
    i = j;
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

/** Group tokens into simple commands at `&&`, `||`, `;`, `&`, `|`, `(`, `)`. */
export function splitSimpleCommands(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], masks: [], redirects: [] };
  const close = (pipe: boolean): void => {
    const done = current.words.length || current.redirects.length ? current : undefined;
    if (done) commands.push(done);
    current = { words: [], masks: [], redirects: [] };
    if (pipe && done) current.pipeFrom = done;
  };
  for (const t of tokens) {
    if (t.kind === 'op') close(t.text === '|');
    else if (t.kind === 'word') {
      current.words.push(t.text);
      current.masks.push(t.mask);
    } else current.redirects.push(t.redirect);
  }
  close(false);
  return commands;
}

// ---------------------------------------------------------------------------
// Detached processes
// ---------------------------------------------------------------------------

/** Commands that start something that outlives them, matched by basename in any word position. */
const DETACH_WORDS: ReadonlySet<string> = new Set([
  'nohup', 'setsid', 'disown', 'at', 'batch', 'crontab', 'systemd-run', 'launchctl', 'tmux', 'screen', 'coproc',
  'daemonize', 'start-stop-daemon', 'start-process', 'start-job',
]);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const MAX_DETACH_DEPTH = 4;

/**
 * Does the command leave a process running after the tool call returns? True for a single `&`
 * outside quotes (`&&`, `>&`, `<&`, `&>`, `&>>` and `|&` are not), also inside `sh -c` / `eval`
 * scripts and command substitutions, and for a detaching launcher anywhere in a simple command,
 * by basename and after quotes and escapes are removed (`/usr/bin/nohup`, `\nohup`, `sudo setsid`):
 * nohup, setsid, disown, at, batch, crontab, systemd-run, launchctl, tmux, screen, coproc,
 * `docker|podman [container] run -d`, `docker compose up -d`, `systemctl start|restart|reload`,
 * `pm2 start`, `forever start`, PowerShell Start-Process / Start-Job, cmd `start`. Over-matching
 * only widens the call's time window. A command the lexer cannot read counts as detaching.
 */
export function detachesProcess(command: string, depth = 0): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(command);
  } catch {
    return true;
  }
  if (tokens.some((t) => t.kind === 'op' && t.text === '&')) return true;
  for (const cmd of splitSimpleCommands(tokens)) {
    const names = cmd.words.map((w) => path.basename(w.replace(/\\/g, '/')).toLowerCase());
    if (names.some((n) => DETACH_WORDS.has(n))) return true;
    if (names[0] === 'start' && cmd.words.length > 1) return true; // cmd.exe `start /b x`
    const at = (word: string): number => names.indexOf(word);
    const has = (...flags: RegExp[]): boolean => cmd.words.some((w) => flags.some((f) => f.test(w)));
    for (const engine of ['docker', 'podman']) {
      const e = at(engine);
      if (e === -1) continue;
      const rest = names.slice(e + 1);
      if (rest.includes('run') && has(/^-[A-Za-z]*d[A-Za-z]*$/, /^--detach(=true)?$/)) return true;
      if (rest.includes('compose') && rest.includes('up') && has(/^-[A-Za-z]*d[A-Za-z]*$/, /^--detach$/)) return true;
    }
    if (at('docker-compose') !== -1 && names.includes('up') && has(/^-[A-Za-z]*d[A-Za-z]*$/, /^--detach$/)) return true;
    if (at('systemctl') !== -1 && names.some((n) => n === 'start' || n === 'restart' || n === 'reload' || n === '--now')) return true;
    if ((at('pm2') !== -1 || at('forever') !== -1) && names.some((n) => n === 'start' || n === 'restart')) return true;
    if (depth >= MAX_DETACH_DEPTH) continue;
    // Nested scripts: `sh -c '...'`, `eval '...'`, and every command substitution.
    for (const [i, n] of names.entries()) {
      const c = SHELLS.has(n) ? cmd.words.indexOf('-c', i) : -1;
      const script = n === 'eval' ? cmd.words.slice(i + 1).join(' ') : c !== -1 ? cmd.words[c + 1] : undefined;
      if (script && detachesProcess(script, depth + 1)) return true;
    }
    for (const [i, w] of cmd.words.entries()) {
      const mask = cmd.masks[i] ?? '';
      if (!mask.includes('c')) continue;
      for (const m of w.matchAll(/\$\(([\s\S]*)\)|`([\s\S]*?)`/g)) if (detachesProcess(m[1] ?? m[2] ?? '', depth + 1)) return true;
    }
  }
  return false;
}
