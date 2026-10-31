/**
 * Deterministic hunk labelling.
 *
 * Every rule in this file is a pure function of the diff text, the file path
 * and the prompts of the session. Nothing calls a model and nothing touches the
 * filesystem, so the same input always yields the same labels.
 *
 * The rules are heuristics. Each one is documented next to its implementation
 * together with the false positives it deliberately guards against. When a rule
 * is unsure it stays quiet: a missed label is cheaper for a reviewer than a
 * noisy one that teaches them to ignore the column.
 *
 * Labels set elsewhere (not here): `unattributed`, `bash-edit`.
 */
import { posix } from 'node:path';
import type { AttributedHunk, DiffLine, Label, LabelKind, Prompt } from './types.js';
import { SECRET_RULES } from './redact.js';

export interface LabelContext {
  prompts: Prompt[];
  repoRoot: string;
  /**
   * Post-image text of a repo-relative path, supplied for runner-config files
   * only (see {@link needsFileText}). Lets the tests-disabled rule resolve the
   * keys around a changed line even when the hunk shows too little context.
   * Absent in pure/unit use: the rule then works from the hunk alone.
   */
  fileText?: (repoRelPath: string) => string | undefined;
  /** Team rules (see config.ts): returns the matching `protected` glob for a repo-relative path */
  protectedGlob?: (repoRelPath: string) => string | undefined;
  /** No transcripts: every hunk counts for `protected-path`, not only the agent's */
  riskScan?: boolean;
  /** Repo-relative team-rules files that changed in this diff (always `protected-path`) */
  rulesFiles?: ReadonlySet<string>;
}

/** Hard cap for `Label.detail`. */
const DETAIL_MAX = 120;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True for files whose full text improves the tests-disabled rule (runner config, pytest config, CI workflows). */
export function needsFileText(path: string): boolean {
  const p = normalisePath(path);
  const base = posix.basename(p);
  return RUNNER_CONFIG.test(base) || PYTEST_CONFIG.test(base) || isCiFile(p);
}

/**
 * Attach deterministic labels to every hunk.
 *
 * Returns new objects (inputs are not mutated). Existing labels are kept and
 * win over freshly computed ones of the same kind; the result holds at most one
 * label per kind.
 */
export function labelHunks(hunks: AttributedHunk[], ctx: LabelContext): AttributedHunk[] {
  const scope = buildScopeIndex(hunks, ctx);
  return hunks.map((h) => {
    const path = toRepoPath(h.hunk.file, ctx.repoRoot);
    const fresh = computeLabels(h, path, scope, ctx);
    return { ...h, labels: mergeLabels(h.labels, fresh) };
  });
}

/**
 * True for files that hold tests, across ecosystems.
 *
 * Snapshot files are deliberately excluded: they get their own
 * `snapshot-updated` label instead of a second, redundant one.
 */
export function isTestFile(path: string): boolean {
  const p = normalisePath(path);
  if (isSnapshotFile(p)) return false;
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

/** True for dependency lockfiles (generated, usually not reviewed by hand). */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(posix.basename(normalisePath(path)));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function computeLabels(h: AttributedHunk, path: string, scope: ScopeIndex, ctx: LabelContext): Label[] {
  const out: Label[] = [];
  const agent = isAgentAttributed(h);
  const lines = h.hunk.lines;
  const push = (kind: LabelKind, severity: Label['severity'], detail: string): void => {
    out.push({ kind, severity, detail: clip(detail) });
  };

  if (isTestFile(path)) {
    push(
      'test-modified',
      agent ? 'risk' : 'info',
      agent ? 'Agent changed a test file' : 'Test file changed (not by the agent)',
    );
  }

  const skips = detectTestSkips(path, lines);
  if (skips.length > 0) push('test-skip-added', 'risk', `Adds ${listOf(skips)}`);

  const disabled = detectTestsDisabled(path, h.hunk, lines, scope);
  if (disabled.length > 0) push('tests-disabled', 'risk', disabled.join('; '));

  const assertions = detectAssertionChanges(path, lines);
  if (assertions.length > 0) push('assertion-removed', 'risk', assertions.join('; '));

  if (isSnapshotFile(path)) push('snapshot-updated', 'warn', 'Snapshot file changed');

  const deps = detectNewDependencies(path, lines);
  if (deps.length > 0) {
    push('dependency-added', 'warn', `New ${deps.length === 1 ? 'dependency' : 'dependencies'}: ${listOf(deps)}`);
  }

  if (isLockfile(path)) push('lockfile', 'info', `Lockfile churn (${posix.basename(path)})`);

  const config = detectConfigChange(path, lines);
  if (config) push('config-changed', 'warn', config);

  if (isCiFile(path)) push('ci-changed', 'risk', `CI pipeline changed (${path})`);

  const suppressions = detectLintSuppressions(path, lines);
  if (suppressions.length > 0) push('lint-suppressed', 'warn', `Adds ${listOf(suppressions)}`);

  const anys = detectTypeAny(path, lines);
  if (anys.length > 0) push('type-any-added', 'warn', `Adds ${listOf(anys)}`);

  const secrets = detectSecrets(path, lines);
  if (secrets.length > 0) push('secret-like', 'risk', secrets.join('; '));

  if (ctx.rulesFiles?.has(path)) {
    push('protected-path', 'risk', `Team rules changed (${path})`);
  } else if (ctx.protectedGlob && (h.match !== 'none' || ctx.riskScan)) {
    const oldPath = h.hunk.oldFile ? toRepoPath(h.hunk.oldFile, ctx.repoRoot) : undefined;
    const glob = ctx.protectedGlob(path) ?? (oldPath ? ctx.protectedGlob(oldPath) : undefined);
    if (glob) push('protected-path', 'risk', `Protected path (${glob}): ${oldPath && oldPath !== path ? `${oldPath} -> ${path}` : path}`);
  }

  if (agent) {
    const why = outOfScopeReason(path, scope, hunkPromptIds(h));
    if (why) push('out-of-scope', 'warn', why);
  }

  return out;
}

function mergeLabels(existing: Label[], fresh: Label[]): Label[] {
  const seen = new Set<LabelKind>();
  const out: Label[] = [];
  for (const label of [...existing, ...fresh]) {
    if (seen.has(label.kind)) continue;
    seen.add(label.kind);
    out.push(label);
  }
  return out;
}

/**
 * A hunk counts as the agent's when a non-failed edit explains it and it is
 * owned by a prompt (or, lacking one, mostly covered by agent edits). A
 * prompt-less segment where a line or two happen to match an edit is not.
 */
function isAgentAttributed(h: AttributedHunk): boolean {
  return h.match !== 'none' && (h.prompt !== undefined || h.coverage >= 0.5) && h.edits.some((e) => e.failed !== true);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRepoPath(file: string, repoRoot: string): string {
  const p = normalisePath(file);
  const root = normalisePath(repoRoot).replace(/\/+$/, '');
  if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  return p;
}

function extOf(path: string): string {
  const base = posix.basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Test file conventions. Java/Kotlin/C# suffixes are matched case-sensitively
 * on purpose so `Latest.java` is not mistaken for `*Test.java`.
 */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.(?:test|spec|e2e-spec|e2e)\.[^/]+$/i, // JS/TS: foo.test.ts, foo.spec.tsx, app.e2e-spec.ts
  /(?:^|\/)__tests__\//, // Jest
  /(?:^|\/)tests?\//i, // test/, tests/, src/test/java/...
  /(?:^|\/)test_[^/]*\.py$/, // pytest: test_foo.py
  /_test\.py$/, // pytest: foo_test.py
  /(?:^|\/)conftest\.py$/, // pytest fixtures
  /_test\.go$/, // Go
  /_(?:spec|test)\.rb$/, // RSpec / minitest
  /(?:^|\/)spec\//, // RSpec dir
  /[A-Za-z0-9](?:Tests?|IT)\.(?:java|kt|kts|scala|groovy)$/, // JUnit
  /[A-Za-z0-9]Tests?\.cs$/, // xUnit / NUnit
  /(?:^|\/)(?:cypress|playwright|e2e)\//i, // browser suites
];

const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'packages.lock.json',
]);

function isSnapshotFile(path: string): boolean {
  const p = normalisePath(path);
  return /(?:^|\/)__snapshots__\//.test(p) || /\.snap$/.test(p);
}

const CI_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)\.github\/actions\//,
  /(?:^|\/)\.gitlab-ci\.ya?ml$/,
  /(?:^|\/)\.gitlab\/ci\//,
  /(?:^|\/)\.circleci\//,
  /(?:^|\/)Jenkinsfile(?:\.[^/]+)?$/,
  /(?:^|\/)azure-pipelines[^/]*\.ya?ml$/,
  /(?:^|\/)\.azure-pipelines\//,
  /(?:^|\/)bitbucket-pipelines\.ya?ml$/,
  /(?:^|\/)\.buildkite\//,
  /(?:^|\/)\.travis\.ya?ml$/,
];

function isCiFile(path: string): boolean {
  return CI_PATTERNS.some((re) => re.test(path));
}

/** Basename patterns of tool/build configuration files. */
const CONFIG_BASENAMES: readonly RegExp[] = [
  /^[jt]sconfig(?:\.[\w-]+)*\.json$/,
  /^\.eslintrc(?:\.\w+)?$/,
  /^eslint\.config\.\w+$/,
  /^\.eslintignore$/,
  /^\.prettierrc(?:\.\w+)?$/,
  /^prettier\.config\.\w+$/,
  /^\.prettierignore$/,
  /^biome\.jsonc?$/,
  /^(?:vite|vitest|next|webpack|rollup|rspack|tsup|esbuild|svelte|astro|nuxt|remix|postcss|tailwind|jest|playwright|cypress|turbo)\.config\.\w+$/,
  /^vitest\.workspace\.\w+$/,
  /^karma\.conf\.\w+$/,
  /^(?:babel\.config\.\w+|\.babelrc(?:\.\w+)?)$/,
  /^\.swcrc$/,
  /^(?:Dockerfile|Containerfile)(?:\.[\w-]+)?$/,
  /\.dockerfile$/i,
  /^\.dockerignore$/,
  /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/,
  /^\.env\.(?:example|sample|template|dist)$/,
  /^\.(?:editorconfig|npmrc|nvmrc|node-version|yarnrc(?:\.yml)?|python-version|tool-versions)$/,
  /^(?:setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|\.flake8|ruff\.toml|\.ruff\.toml|\.pylintrc|\.coveragerc)$/,
  /^\.pre-commit-config\.ya?ml$/,
  /^\.golangci\.ya?ml$/,
  /^(?:rustfmt|\.rustfmt|clippy)\.toml$/,
  /^\.rubocop\.yml$/,
];

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

type CommentStyle = 'slash' | 'hash' | 'none';

const HASH_COMMENT_EXT = new Set(['py', 'pyi', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl', 'cfg', 'ini']);
const SLASH_COMMENT_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'go', 'java', 'kt', 'kts', 'scala', 'groovy',
  'cs', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'swift', 'php', 'dart', 'vue', 'svelte',
]);
const PROSE_EXT = new Set(['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc']);
const TS_EXT = new Set(['ts', 'tsx', 'mts', 'cts']);

function commentStyle(path: string): CommentStyle {
  const ext = extOf(path);
  if (HASH_COMMENT_EXT.has(ext)) return 'hash';
  if (SLASH_COMMENT_EXT.has(ext)) return 'slash';
  return 'none';
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;

/** Replace string literal contents with `""` so prose inside strings cannot match. */
function stripStrings(line: string): string {
  return line.replace(STRING_LITERAL, '""');
}

/** Strings and comments removed: what the compiler actually sees (approximately). */
function codeOf(line: string, style: CommentStyle): string {
  let s = stripStrings(line);
  if (style === 'slash') {
    if (/^\s*\*/.test(s)) return ''; // block comment continuation
    s = s.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
  } else if (style === 'hash') {
    s = s.replace(/#(?!\[).*$/, '');
  }
  return s;
}

/** Whitespace-insensitive key used to decide that a line was merely moved or reindented. */
function normaliseLine(line: string): string {
  return line.replace(/\s+/g, '').replace(/[;,]+$/, '');
}

/**
 * Added lines that are genuinely new: a `+` line whose normalised text also
 * appears as a `-` line in the same hunk was only moved or reformatted.
 */
function netAdded(lines: DiffLine[]): DiffLine[] {
  const removed = new Map<string, number>();
  for (const l of lines) {
    if (l.type !== 'del') continue;
    const k = normaliseLine(l.text);
    removed.set(k, (removed.get(k) ?? 0) + 1);
  }
  const out: DiffLine[] = [];
  for (const l of lines) {
    if (l.type !== 'add') continue;
    const k = normaliseLine(l.text);
    const n = removed.get(k) ?? 0;
    if (n > 0) removed.set(k, n - 1);
    else out.push(l);
  }
  return out;
}

function clip(s: string, max = DETAIL_MAX): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

function listOf(items: string[]): string {
  return uniq(items).join(', ');
}

/** Content between the bracket at `open` and its match (or the end of the line). */
function balanced(s: string, open: number): { inner: string; end: number } {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    const close = pairs[c];
    if (close !== undefined) stack.push(close);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
    }
  }
  return { inner: s.slice(open + 1), end: s.length };
}

/** Split on commas that are not nested in brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------------------
// test-skip-added
// ---------------------------------------------------------------------------

interface Pattern {
  re: RegExp;
  name: string;
  /** Only apply inside test files (the token is ambiguous elsewhere). */
  testOnly?: boolean;
  /** Only apply to files with these extensions. */
  ext?: readonly string[];
}

/**
 * Skip/focus markers. Matched on code with strings and comments removed, so
 * `it('should skip empty rows')` or `# TODO: pytest.skip(...)` never match.
 * Bare `.skip(` is limited to test files (Mongo cursors, streams and query
 * builders have `.skip()` too); variables like `skipCount` never match because
 * every pattern needs a call, member access or decorator shape.
 */
const SKIP_PATTERNS: readonly Pattern[] = [
  { re: /\b(?:describe|it|test|context|suite|specify|bench)\s*\.\s*(skip|only|todo|fixme|fails)\b/, name: '.$1' },
  { re: /(?<![\w$.])(xit|xdescribe|xtest|xcontext|xspecify|fit|fdescribe|fcontext)\s*[(\s]/, name: '$1', testOnly: true },
  { re: /@pytest\.mark\.(skip|skipif|xfail)\b/, name: '@pytest.mark.$1' },
  { re: /\bpytest\.(skip|xfail)\s*\(/, name: 'pytest.$1()' },
  { re: /@unittest\.(skip\w*|expectedFailure)\b/, name: '@unittest.$1' },
  { re: /\bself\.skipTest\s*\(/, name: 'self.skipTest()' },
  { re: /\b[tb]\.(Skip(?:f|Now)?)\s*\(/, name: 't.$1()', ext: ['go'] },
  { re: /@(Disabled|Ignore)\b/, name: '@$1', ext: ['java', 'kt', 'kts', 'scala', 'groovy'] },
  { re: /\[\s*(Ignore)\b/, name: '[Ignore]', ext: ['cs'] },
  { re: /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=/, name: '[Fact(Skip=…)]', ext: ['cs'] },
  { re: /#\[(ignore)\b/, name: '#[ignore]', ext: ['rs'] },
  { re: /^\s*(pending|skip)\b(?=\s*$|\s*\(|\s+["'])/, name: '$1', testOnly: true, ext: ['rb'] },
  { re: /(?<![\w$.])(pending)\s*\(/, name: 'pending()', testOnly: true, ext: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'] },
  // Last: generic member call, e.g. `suite.skip(` or `bench.only(` in a test file.
  { re: /\.\s*(skip|only)\s*\(/, name: '.$1()', testOnly: true },
];

function matchPatterns(
  text: string,
  patterns: readonly Pattern[],
  path: string,
  inTest: boolean,
  firstOnly = false,
): string[] {
  const ext = extOf(path);
  const hits: string[] = [];
  for (const p of patterns) {
    if (p.testOnly && !inTest) continue;
    if (p.ext && !p.ext.includes(ext)) continue;
    const m = p.re.exec(text);
    if (!m) continue;
    hits.push(p.name.replace('$1', m[1] ?? ''));
    if (firstOnly) break;
  }
  return hits;
}

function detectTestSkips(path: string, lines: DiffLine[]): string[] {
  const style = commentStyle(path);
  if (PROSE_EXT.has(extOf(path))) return [];
  const inTest = isTestFile(path);
  const hits: string[] = [];
  for (const l of netAdded(lines)) {
    // Ruby `skip "reason"`: keep the string so the lookahead can see it.
    const text = extOf(path) === 'rb' ? l.text.replace(/#.*$/, '') : codeOf(l.text, style);
    hits.push(...matchPatterns(text, SKIP_PATTERNS, path, inTest, true));
  }
  return uniq(hits);
}

// ---------------------------------------------------------------------------
// tests-disabled
// ---------------------------------------------------------------------------

/**
 * Tests turned off without touching a test line: runner config that excludes
 * files, a test command that can no longer fail, a CI step that may fail, a
 * test file renamed away from its test name or deleted. Only net-added lines
 * count, so removing such a setting is never flagged. Excludes that name only
 * build output (node_modules, dist, coverage, ...) are ordinary housekeeping.
 */
/** Jest-only keys: whatever they ignore is a test or a module the tests load. */
const JEST_IGNORE_KEYS: ReadonlySet<string> = new Set(['testPathIgnorePatterns', 'modulePathIgnorePatterns']);
/** Ancestors that make an `exclude` something other than test discovery. */
const NON_TEST_SCOPES: ReadonlySet<string> = new Set(['coverage', 'optimizeDeps', 'ssr', 'deps', 'server', 'build', 'typecheck', 'benchmark', 'nyc']);
const RUNNER_CONFIG = /^(?:(?:vitest|jest|vite)\.config\.\w+|vitest\.workspace\.\w+|package\.json)$/;
const PYTEST_CONFIG = /^(?:pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$/;
/** Entries that are never tests: build output, fixtures, mocks, typings, stories, generated code. */
const NOT_A_TEST_ENTRY = /(?:^|[/*<>\s])(?:node_modules|dist|build|coverage|out|\.git|\.next|\.nuxt|\.cache|\.turbo|\.venv|venv|__pycache__|target|vendor|tmp|temp|fixtures?|__fixtures__|__mocks__|mocks?|generated|__generated__|docs?)(?:[/*]|$)|\.d\.ts$|\.stories\.|\.generated\./;
const TESTISH_ENTRY = /\.(?:test|spec)(?:\.|\b)|(?:^|[/>}\s])(?:__tests__|tests?|specs?)(?:[/*]|$)|(?:^|\/)test_[^/]*|_test\./;
const BROAD_GLOB = /^(?:\.?\/)?(?:\*\*?\/)*\*+(?:\.\w+)?$|^(?:\.?\/)?(?:src|lib|app|packages|apps)\/\*\*(?:\/\*+)?$/;
const TEST_SCRIPT_KEY = /^\s*"(test(?::[\w:.-]+)?)"\s*:/;
const SWALLOW = /(?:--passWithNoTests\b|--no-error-on-unmatched-pattern\b|\|\|\s*(?:true\b|exit\s+0\b|:(?![\w-])|echo\b)|;\s*(?:true|exit\s+0)\s*(?:["',]|$))/;
const TRIVIAL_SCRIPT = /^\s*(?:exit\s+0|true|:|echo\b.*)\s*$/;
const TEST_RUNNER = /\b(?:vitest|jest|mocha|pytest|ava|tap|playwright|cypress|karma|jasmine|rspec|phpunit|tox|nextest|(?:go|cargo|bun|deno|dotnet|mvn|gradle|node\s+--|tsx\s+--)\s*test)\b/;
/** A command that actually runs tests (CI `run:` lines). */
const RUN_TESTS = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b(?![\w:-]*results)|\bnpx\s+(?:vitest|jest|mocha|playwright)\b|(?:^|[\s;&|(])(?:vitest|jest|mocha|pytest|tox|rspec|phpunit|nextest)(?![\w-])|\bplaywright\s+test\b|\bcypress\s+run\b|\bgo\s+test\b|\bcargo\s+(?:nextest\s+run|test)\b|\bmvn\b[^\n]*\btest\b|\bgradlew?\b[^\n]*\btest\b|\bdotnet\s+test\b|\bmake\s+(?:test|check)\b|\bbundle\s+exec\s+rspec\b/;
const DISABLED_SUFFIX = /(?:\.(?:disabled?|skip|skipped|bak|old|orig|txt)|~)$/i;
const TEST_BASENAME = /(?:\.(?:test|spec|e2e-spec|e2e)\.[^/.]+$|^test_[^/]*\.py$|_test\.(?:py|go)$|_(?:spec|test)\.rb$|[A-Za-z0-9](?:Tests?|IT)\.(?:java|kt|kts|scala|groovy|cs)$)/;

/** File name without extension and without test markers, so `a.test.js`, `a_test.go` and `a.js` share the stem `a`. */
function testStem(base: string): string {
  let s = base.replace(/\.[^.]+$/, '');
  s = s.replace(/\.(?:test|spec|e2e-spec|e2e)$/, '').replace(/_(?:test|spec)$/, '').replace(/^test_/, '');
  s = s.replace(/(?<=[a-z0-9])(?:Tests?|IT)$/, '');
  return s;
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2] ?? '');
}

/** Does an ignore entry take tests out of the run? `anyEntry`: the key itself is test-specific (jest). */
function entryDisablesTests(entry: string, anyEntry: boolean): boolean {
  if (!entry || NOT_A_TEST_ENTRY.test(entry)) return false;
  if (BROAD_GLOB.test(entry) || TESTISH_ENTRY.test(entry)) return true;
  return anyEntry;
}

interface ConfigString {
  text: string;
  /** Keys of the enclosing objects/arrays, outermost first, as far as the hunk shows them. */
  path: Array<string | null>;
  line: DiffLine;
}

/**
 * Walk the visible (context and added) lines as one JS/JSON token stream and
 * report every string value together with the keys that enclose it.
 */
function configStrings(lines: DiffLine[]): ConfigString[] {
  const out: ConfigString[] = [];
  const stack: Array<string | null> = [];
  let lastKey: string | null = null;
  for (const line of lines) {
    if (line.type === 'del') continue;
    const t = line.text;
    for (let i = 0; i < t.length; i++) {
      const ch = t.charAt(i);
      if (ch === '/' && t.charAt(i + 1) === '/') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < t.length && t.charAt(j) !== ch) j += t.charAt(j) === '\\' ? 2 : 1;
        const text = t.slice(i + 1, j);
        const rest = t.slice(j + 1);
        if (/^\s*:/.test(rest)) lastKey = text;
        else out.push({ text, path: [...stack], line });
        i = j;
        continue;
      }
      if (/[\w$]/.test(ch)) {
        const m = /^[\w$.-]+/.exec(t.slice(i));
        const word = m?.[0] ?? ch;
        if (/^\s*:/.test(t.slice(i + word.length))) lastKey = word;
        i += word.length - 1;
        continue;
      }
      if (ch === '{' || ch === '[') {
        const before = t.slice(0, i).trimEnd();
        stack.push(before.endsWith(':') ? lastKey : null);
      } else if (ch === '}' || ch === ']') {
        stack.pop();
      }
    }
  }
  return out;
}

function detectConfigIgnores(lines: DiffLine[], added: Set<DiffLine>, base: string): string[] {
  const hits: string[] = [];
  for (const s of configStrings(lines)) {
    if (!added.has(s.line)) continue;
    const key = s.path[s.path.length - 1] ?? null;
    if (!key) continue;
    if (JEST_IGNORE_KEYS.has(key)) {
      if (entryDisablesTests(s.text, key === 'testPathIgnorePatterns')) hits.push(`Adds ${key} entry ${s.text}`);
    } else if (key === 'exclude' && base !== 'package.json') {
      const keys = s.path.filter((k): k is string => k !== null);
      if (keys.includes('test') && !keys.some((k) => NON_TEST_SCOPES.has(k)) && entryDisablesTests(s.text, false)) {
        hits.push(`Adds test.exclude entry ${s.text}`);
      }
    }
  }
  return hits;
}

/** package.json `test` scripts that can no longer fail or no longer run a test runner. */
function detectTestScripts(lines: DiffLine[], added: Set<DiffLine>): string[] {
  const hits: string[] = [];
  const oldValues = new Map<string, string>();
  for (const l of lines) {
    if (l.type !== 'del') continue;
    const k = TEST_SCRIPT_KEY.exec(l.text)?.[1];
    if (k) oldValues.set(k, l.text);
  }
  for (const l of added) {
    const key = TEST_SCRIPT_KEY.exec(l.text)?.[1];
    if (!key) continue;
    const value = /:\s*"((?:\\.|[^"\\])*)"/.exec(l.text)?.[1] ?? '';
    const old = oldValues.get(key);
    if (SWALLOW.test(value) || TRIVIAL_SCRIPT.test(value)) hits.push(`Test script cannot fail: ${l.text.trim()}`);
    else if (old !== undefined && TEST_RUNNER.test(old) && !TEST_RUNNER.test(value) && !/\b(?:npm|pnpm|yarn|bun)\b/.test(value)) {
      hits.push(`Test script no longer runs a test runner: ${l.text.trim()}`);
    }
  }
  return hits;
}

/** pytest options that deselect tests, only inside `addopts` (or a tox `pytest` command). */
function detectPytestOptions(lines: DiffLine[], added: Set<DiffLine>, base: string): string[] {
  const hits: string[] = [];
  const OPT = /(?:^|[\s"'=,\[])(-k\s*=?\s*["']?\s*not\b|--deselect\b|--ignore(?:-glob)?\b)(?:[=\s]+([^\s"',\]]+))?/;
  const check = (text: string): void => {
    const m = OPT.exec(text);
    if (!m) return;
    const opt = (m[1] ?? '').replace(/\s+/g, ' ');
    if (opt.startsWith('--ignore') && !entryDisablesTests(m[2] ?? '', true)) return;
    hits.push(`Pytest option ${opt} added`);
  };
  let inAddopts = false;
  for (const l of lines) {
    if (l.type === 'del') continue;
    if (/^\s*addopts\s*[=:]/.test(l.text)) inAddopts = true;
    else if (inAddopts && /^\S/.test(l.text) && !/^\]/.test(l.text)) inAddopts = false;
    if (inAddopts && added.has(l)) check(l.text);
    else if (base === 'tox.ini' && added.has(l) && /\bpytest\b/.test(l.text) && /^\s*(?:commands\s*=|\w)/.test(l.text)) {
      const m = /--ignore(?:-glob)?[=\s]+(\S+)/.exec(l.text);
      if (m && entryDisablesTests(m[1] ?? '', true) && TESTISH_ENTRY.test(m[1] ?? '')) hits.push('Pytest option --ignore added');
    }
  }
  return hits;
}

function detectTestsDisabled(path: string, hunk: AttributedHunk['hunk'], lines: DiffLine[], scope: ScopeIndex): string[] {
  const hits: string[] = [];
  const base = posix.basename(path);

  // A test file deleted outright (unless the code it tests is deleted or moved in the same diff).
  if (hunk.status === 'deleted' && isTestFile(path) && !scope.goneSourceStems.has(testStem(base))) {
    hits.push(`Deletes test file ${base}`);
  }
  // A test file renamed so the runner no longer finds it.
  if (hunk.status === 'renamed' && hunk.oldFile && isTestFile(hunk.oldFile)) {
    const oldBase = posix.basename(hunk.oldFile);
    if (oldBase !== base && TEST_BASENAME.test(oldBase)) {
      const suffixed = base.startsWith(oldBase) && DISABLED_SUFFIX.test(base.slice(oldBase.length) || ' ');
      const markerDropped = !TEST_BASENAME.test(base) && testStem(base) === testStem(oldBase) && !DISABLED_SUFFIX.test(base);
      if (suffixed || markerDropped) hits.push(`Renames test file ${oldBase} to ${base}`);
    }
  }

  const added = new Set(netAdded(lines));
  // Prefer the whole file: the keys around a changed line are often outside the hunk.
  const full = fullFileView(path, lines, added, scope);
  const wide = full?.lines ?? lines;
  const wideAdded = full?.added ?? added;
  if (RUNNER_CONFIG.test(base)) hits.push(...detectConfigIgnores(wide, wideAdded, base));
  if (base === 'package.json') hits.push(...detectTestScripts(lines, added));
  if (PYTEST_CONFIG.test(base)) hits.push(...detectPytestOptions(wide, wideAdded, base));
  if (isCiFile(path)) hits.push(...detectCiSwallowedTests(wide, wideAdded));
  return uniq(hits);
}

/**
 * The post-image as diff lines (all context except the hunk's net-added lines,
 * matched by line number). Null when no text is available or it does not match
 * the hunk, in which case callers use the hunk alone.
 */
function fullFileView(path: string, lines: DiffLine[], added: Set<DiffLine>, scope: ScopeIndex): { lines: DiffLine[]; added: Set<DiffLine> } | null {
  if (!scope.fileText || !needsFileText(path)) return null;
  let text: string | undefined;
  try { text = scope.fileText(path); } catch { return null; }
  if (text === undefined) return null;
  const rows = text.split('\n').map((t) => t.replace(/\r$/, ''));
  const addedNos = new Set<number>();
  for (const l of added) {
    if (l.newNo === undefined || rows[l.newNo - 1] !== l.text.replace(/\r$/, '')) return null;
    addedNos.add(l.newNo);
  }
  if (addedNos.size === 0) return null;
  const out: DiffLine[] = [];
  const wideAdded = new Set<DiffLine>();
  rows.forEach((t, i) => {
    const n = i + 1;
    if (addedNos.has(n)) {
      const l: DiffLine = { type: 'add', text: t, newNo: n };
      out.push(l);
      wideAdded.add(l);
    } else {
      out.push({ type: 'ctx', text: t, oldNo: n, newNo: n });
    }
  });
  return { lines: out, added: wideAdded };
}

/** Stems of non-test source files deleted or renamed away anywhere in the diff. */
function goneSourceStems(hunks: AttributedHunk[], repoRoot: string): Set<string> {
  const out = new Set<string>();
  for (const { hunk } of hunks) {
    const gone = hunk.status === 'deleted' ? toRepoPath(hunk.file, repoRoot) : hunk.status === 'renamed' && hunk.oldFile && hunk.oldFile !== hunk.file ? toRepoPath(hunk.oldFile, repoRoot) : null;
    if (gone && !isTestFile(gone)) out.add(testStem(posix.basename(gone)));
  }
  return out;
}

function detectCiSwallowedTests(lines: DiffLine[], added: Set<DiffLine>): string[] {
  const hits: string[] = [];
  const indentOf = (t: string): number => t.length - t.trimStart().length;
  const stepStart = /^\s*-\s+[\w-]+:/;
  let block: DiffLine[] = [];
  let boundary = -1; // content must be indented deeper than this
  let implicit = false;
  const flush = (): void => {
    // Only `run:` content decides whether the step runs tests; names and `uses:` do not.
    const runText = block.map((l) => l.text).filter((t) => !/^\s*(?:-\s+)?(?:name|uses|id|if|with|env|working-directory):/.test(t)).join('\n');
    if (RUN_TESTS.test(runText)) {
      for (const l of block) {
        if (added.has(l) && /^\s*(?:-\s+)?continue-on-error:\s*true\b/.test(l.text)) hits.push('continue-on-error: true on a test step');
      }
    }
    block = [];
  };
  for (const l of lines) {
    if (l.type === 'del') continue;
    if (!l.text.trim()) continue;
    const ind = indentOf(l.text);
    if (stepStart.test(l.text) && (block.length === 0 || ind <= boundary || implicit)) {
      flush();
      boundary = ind;
      implicit = false;
    } else if (block.length === 0) {
      // Hunk starts mid-step: content at this indent or deeper belongs to it.
      boundary = ind - 1;
      implicit = true;
    } else if (ind <= boundary) {
      flush();
      boundary = ind - 1;
      implicit = true;
    }
    block.push(l);
  }
  flush();
  for (const l of added) {
    if (RUN_TESTS.test(l.text) && /\|\|\s*(?:true\b|exit\s+0\b|:(?![\w-])|echo\b)/.test(l.text)) hits.push(`Test command cannot fail: ${l.text.trim()}`);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// assertion-removed
// ---------------------------------------------------------------------------

/** One parsed assertion line. */
interface Assertion {
  /** Original line, trimmed (for details). */
  raw: string;
  /** Whitespace-insensitive original (strings kept) for exact re-add detection. */
  key: string;
  /** Canonical matcher, e.g. `tobe`, `equal`, `==`, `truthy`. */
  matcher: string;
  /** Matcher as written, for details. */
  display: string;
  negated: boolean;
  /** Normalised operands (actual and expected, order not significant). */
  operands: string[];
  /** Contents of string literals on the original line (expected text, messages). */
  literals: string[];
}

/** Canonical matcher aliases across frameworks. */
const MATCHER_ALIASES: Record<string, string> = {
  equals: 'equal',
  areequal: 'equal',
  eq: 'equal',
  eql: 'equal',
  deepequal: 'equal',
  tobe: 'equal',
  toequal: 'equal',
  same: 'strictequal',
  deepstrictequal: 'strictequal',
  tostrictequal: 'strictequal',
  assert_eq: 'equal',
  istrue: 'true',
  ok: 'true',
  tobetruthy: 'truthy',
  be_truthy: 'truthy',
  tobedefined: 'defined',
  isnotnone: 'notnull',
  isnotnull: 'notnull',
  notnone: 'notnull',
  notnil: 'notnull',
  nonnull: 'notnull',
  be_present: 'notnull',
};

/** 0 = existence/truthiness, 1 = partial match, 2 = equality, 3 = strict equality. */
const MATCHER_RANK: Record<string, number> = {
  truthy: 0,
  true: 0,
  defined: 0,
  notnull: 0,
  notempty: 0,
  anything: 0,
  tohavebeencalled: 0,
  tomatchobject: 1,
  tocontain: 1,
  tocontainequal: 1,
  include: 1,
  contains: 1,
  in: 1,
  tohaveproperty: 1,
  subset: 1,
  equal: 2,
  '==': 2,
  tohavelength: 2,
  tohavebeencalledwith: 2,
  tohavebeencalledtimes: 2,
  tothrow: 2,
  strictequal: 3,
  is: 3,
};

function canonicalMatcher(name: string): string {
  const lower = name
    .toLowerCase()
    .replace(/^(?:self|this)\./, '')
    .replace(/^(?:assert|require|assertions|expect)\./, '')
    .replace(/!$/, '')
    .replace(/^assert_?(?=.)/, '')
    .replace(/^refute_?/, 'not');
  return MATCHER_ALIASES[lower] ?? lower;
}

const LITERAL = /^(?:-?\d[\d_.]*(?:e-?\d+)?n?|true|false|True|False|null|None|nil|undefined|""|0x[\da-f]+)$/i;
const NUMERIC_OR_BOOL = /^(?:-?\d[\d_.]*(?:e-?\d+)?n?|true|false|True|False)$/;

function rankOf(a: Assertion): number | null {
  // `.not.toBeNull()` / `.not.toBeUndefined()` only check existence.
  if (a.negated && /^tobe(?:null|undefined|falsy|nan)$/.test(a.matcher)) return 0;
  if (a.negated) return null;
  // `toBeGreaterThan(0)` replacing an exact value is a classic weakening.
  if (/^tobe(?:greater|less)than(?:orequal)?$/.test(a.matcher)) {
    return a.operands.some((o) => /^-?[01]$/.test(o)) ? 0 : 1;
  }
  if (a.matcher === 'tothrow' && a.operands.length < 2) return 0;
  return MATCHER_RANK[a.matcher] ?? null;
}

const FUNCTION_ASSERT =
  /(?<![\w$.])((?:self\.|this\.)?(?:assert|refute)\w*!?|assert\.\w+|require\.[A-Z]\w*|Assert(?:ions)?\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow))\s*\(/;
const EXPECT_CALL = /(?<![\w$.])expect\s*([({])/;
const CHAINED_MATCHER = /^\s*\)*\s*\.\s*(?:(not)\s*\.\s*)?(?:resolves\s*\.\s*|rejects\s*\.\s*)?(to[A-Z]\w*)\s*\(/;
const CHAIN_MODIFIER = /^\s*\.?\s*(not_to|to_not|not|resolves|rejects|to)(?=[\s.]|$)/;
const SHOULD = /\.should(?:_not)?\b|\bshould(?:_not)?\s*(?:==|\(|be\b|eq\b|equal\b)/;
const PY_COMPARE = /\s(==|!=|is not|is|not in|in|<=|>=|<|>)\s/;

/** Assertion detection runs in test files, plus inline Rust tests. */
function assertionsApply(path: string): boolean {
  return isTestFile(path) || extOf(path) === 'rs';
}

function parseAssertion(line: string, path: string): Assertion | null {
  const style = commentStyle(path);
  const code = codeOf(line, style).trim();
  if (!code || /^(?:def|function|func|fn|public|private|protected)\b/.test(code)) return null;
  const literals = [...line.matchAll(STRING_LITERAL)].map((m) => m[0].slice(1, -1)).filter((x) => x.trim() !== '');
  const base = { raw: line.trim(), key: normaliseLine(line), literals };
  const norm = (s: string): string => s.replace(/\s+/g, '');

  // expect(actual).not.toBe(expected) / expect(actual).to eq(expected) / expect { }.to raise_error
  const ex = EXPECT_CALL.exec(code);
  if (ex) {
    const open = ex.index + ex[0].length - 1;
    const subject = balanced(code, open);
    let rest = code.slice(subject.end);
    let negated = false;
    // Peel chain modifiers: `.not`, `.resolves`, `.rejects`, chai `.to`, RSpec `.to` / `.not_to`.
    for (let m = CHAIN_MODIFIER.exec(rest); m; m = CHAIN_MODIFIER.exec(rest)) {
      if (m[1] === 'not' || m[1] === 'not_to' || m[1] === 'to_not') negated = true;
      rest = rest.slice(m[0].length);
    }
    const m = /^\s*\.?\s*(\w+)\s*(\(?)/.exec(rest);
    const display = m?.[1] ?? 'expect';
    let expected = '';
    if (m) {
      const after = rest.slice(m[0].length - (m[2] ? 1 : 0));
      expected = m[2] ? balanced(after, 0).inner : after.replace(/[;)\s]+$/, '');
    }
    const operands = [norm(subject.inner), ...splitTopLevel(expected).map(norm)].filter((o) => o !== '');
    return { ...base, matcher: canonicalMatcher(display), display, negated, operands };
  }

  // Continuation of a multi-line chain: `).toBe(5)` / `.not.toEqual(x)`
  const ch = CHAINED_MATCHER.exec(code);
  if (ch && ch[2]) {
    const display = ch[2];
    const args = balanced(code, ch.index + ch[0].length - 1).inner;
    return { ...base, matcher: canonicalMatcher(display), display, negated: ch[1] === 'not', operands: splitTopLevel(args).map(norm) };
  }

  // assertEqual(a, b) / assert.equal(a, b) / require.Equal(t, a, b) / assert_eq!(a, b) / t.Errorf(...)
  const fn = FUNCTION_ASSERT.exec(code);
  if (fn && fn[1]) {
    const display = fn[1].replace(/^(?:self|this)\./, '');
    const args = splitTopLevel(balanced(code, fn.index + fn[0].length - 1).inner).map(norm);
    if (args[0] === 't') args.shift(); // testify: assert.Equal(t, want, got)
    let matcher = canonicalMatcher(display);
    if (matcher === 'assert' || matcher === '') matcher = 'truthy'; // assert(x) / assert!(x)
    // Negated function forms (assertNotEqual, refute_*) are distinct matchers with no rank.
    return { ...base, matcher, display, negated: false, operands: args };
  }

  // Python / Ruby bare: `assert a == b`, `assert x`, `assert x is not None`
  const py = /^assert\s+(.+)$/.exec(code);
  if (py?.[1] && /^(?:py|pyi)$/.test(extOf(path))) {
    const expr = ` ${splitTopLevel(py[1])[0] ?? ''} `; // drop the `, "message"` part
    const cmp = PY_COMPARE.exec(expr);
    if (!cmp?.[1]) return { ...base, matcher: 'truthy', display: 'bare assert', negated: false, operands: [norm(expr)] };
    const lhs = norm(expr.slice(0, cmp.index));
    const rhs = norm(expr.slice(cmp.index + cmp[0].length));
    if (cmp[1] === 'is not' && rhs === 'None') {
      return { ...base, matcher: 'notnull', display: 'assert is not None', negated: false, operands: [lhs] };
    }
    return { ...base, matcher: cmp[1], display: `assert ${cmp[1]}`, negated: false, operands: [lhs, rhs] };
  }

  // RSpec / chai should
  if (SHOULD.test(code)) {
    return { ...base, matcher: 'should', display: 'should', negated: /should_not|\.not\b/.test(code), operands: [] };
  }
  return null;
}

/** Local variable name to the (normalised) expression it was assigned from. */
type Aliases = ReadonlyMap<string, string>;

/**
 * `const out = receipt(items)`, `let x: T = f()`, `out = f()` (Python/Ruby),
 * `out := F()` (Go), `String out = f();` (Java/C#). Destructuring and member
 * targets are ignored.
 */
const ASSIGNMENT =
  /^\s*(?:(?:const|let|var|val|final|auto)\s+)?(?:[A-Z][\w<>[\],.?]*\s+)?([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+?)?\s*(?::=|=(?![=>]))\s*(.+?)\s*;?\s*$/;

function collectAliases(lines: DiffLine[], path: string): Aliases {
  const style = commentStyle(path);
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = ASSIGNMENT.exec(codeOf(l.text, style));
    if (m?.[1] && m[2] && !EXPECT_CALL.test(m[2])) out.set(m[1], m[2].replace(/\s+/g, ''));
  }
  return out;
}

/** Operands plus whatever they alias, so `expect(out)` matches `expect(receipt(items))`. */
function subjects(a: Assertion, aliases: Aliases): Set<string> {
  const out = new Set<string>();
  for (const o of a.operands) {
    if (o === '' || LITERAL.test(o)) continue;
    out.add(o);
    const target = aliases.get(o);
    if (target) out.add(target);
  }
  return out;
}

function sharesSubject(d: Assertion, a: Assertion, aliases: Aliases): boolean {
  const ds = subjects(d, aliases);
  return [...subjects(a, aliases)].some((o) => ds.has(o));
}

function wordsOf(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * The added assertion's expected text refines the deleted one: every word of
 * some deleted literal appears in an added literal (`'TOTAL  30'` refined to
 * `'TOTAL  $30.00'`).
 */
function refinesLiteral(d: Assertion, a: Assertion): boolean {
  return d.literals.some((dl) => {
    const need = wordsOf(dl);
    if (need.length === 0) return false;
    return a.literals.some((al) => {
      const have = new Set(wordsOf(al));
      return need.every((w) => have.has(w));
    });
  });
}

/** True unless `a` is measurably weaker than `d`. */
function notWeaker(d: Assertion, a: Assertion): boolean {
  const rd = rankOf(d);
  const ra = rankOf(a);
  if (rd !== null && ra !== null) return ra >= rd;
  return !(d.negated && !a.negated);
}

/** Operands that differ between two assertions, if all differences are numeric/boolean literals. */
function literalChange(d: Assertion, a: Assertion, aliases: Aliases): { from: string; to: string } | null {
  if (d.operands.length !== a.operands.length) return null;
  const resolve = (o: string): string => aliases.get(o) ?? o;
  const [dOps, aOps] = [d.operands.map(resolve), a.operands.map(resolve)];
  const onlyD = dOps.filter((o) => !aOps.includes(o));
  const onlyA = aOps.filter((o) => !dOps.includes(o));
  if (onlyD.length !== 1 || onlyA.length !== 1) return null;
  const [from, to] = [onlyD[0] ?? '', onlyA[0] ?? ''];
  return NUMERIC_OR_BOOL.test(from) && NUMERIC_OR_BOOL.test(to) ? { from, to } : null;
}

/**
 * Removed or weakened assertions within a single hunk.
 *
 * 1. Parse every `-` and `+` line that looks like an assertion.
 * 2. Drop `-` lines re-added verbatim (whitespace-insensitive): a move, not a removal.
 * 3. Pair each remaining `-` assertion with a `+` assertion that replaces it:
 *    a. same subject: a shared non-literal operand, resolving local variables
 *       assigned in the hunk (`const out = receipt(items)` makes `expect(out)`
 *       the same subject as `expect(receipt(items))`); an equally strict or
 *       stricter candidate is preferred;
 *    b. otherwise an equally strict assertion whose expected string refines the
 *       old one (all words of `'TOTAL  30'` appear in `'TOTAL  $30.00'`);
 *    c. otherwise positionally, when exactly one of each is left.
 *    A paired rewrite is never reported as "removed"; changed expected strings
 *    on it are accepted. Extra added assertions are fine.
 * 4. A pair is a weakening when the matcher drops in strictness rank
 *    (`toBe` to `toBeDefined`, `assertEqual` to `assertTrue`, `toEqual` to `toMatchObject`,
 *    exact to `toBeGreaterThan(0)`), when `.not` disappears, or when only a
 *    numeric/boolean expected value changes (the test was bent to fit the code).
 * 5. An unpaired `-` assertion was removed.
 */
function detectAssertionChanges(path: string, lines: DiffLine[]): string[] {
  if (!assertionsApply(path)) return [];
  const aliases = collectAliases(lines, path);
  const dels: Assertion[] = [];
  const adds: Assertion[] = [];
  for (const l of lines) {
    if (l.type === 'ctx') continue;
    const a = parseAssertion(l.text, path);
    if (a) (l.type === 'del' ? dels : adds).push(a);
  }
  if (dels.length === 0) return [];

  const unusedAdds = [...adds];
  const take = (pred: (a: Assertion) => boolean): Assertion | undefined => {
    const i = unusedAdds.findIndex(pred);
    return i < 0 ? undefined : unusedAdds.splice(i, 1)[0];
  };
  const pending = dels.filter((d) => !take((a) => a.key === d.key));

  const findings: string[] = [];
  const unpaired: Assertion[] = [];
  const pairs: [Assertion, Assertion][] = [];
  for (const d of pending) {
    // Prefer a same-subject replacement that is at least as strict, so that
    // `expect(out).toBeDefined(); expect(out).toBe(5)` pairs with the strong one.
    const a =
      take((x) => sharesSubject(d, x, aliases) && notWeaker(d, x)) ??
      take((x) => sharesSubject(d, x, aliases)) ??
      take((x) => refinesLiteral(d, x) && notWeaker(d, x));
    if (a) pairs.push([d, a]);
    else unpaired.push(d);
  }
  if (unpaired.length === 1 && unusedAdds.length === 1) {
    pairs.push([unpaired.pop() as Assertion, unusedAdds.pop() as Assertion]);
  }

  for (const [d, a] of pairs) {
    const rd = rankOf(d);
    const ra = rankOf(a);
    if (rd !== null && ra !== null && ra < rd) {
      findings.push(`weakened ${d.display} to ${a.display}`);
    } else if (d.negated && !a.negated && d.matcher === a.matcher) {
      findings.push(`.not removed from ${d.display}`);
    } else if (d.matcher === a.matcher && d.negated === a.negated) {
      const change = literalChange(d, a, aliases);
      if (change) findings.push(`expected value changed ${change.from} to ${change.to} (${d.display})`);
    }
  }
  if (unpaired.length > 0) {
    const first = clip(unpaired[0]?.raw ?? '', 60);
    findings.unshift(unpaired.length === 1 ? `removed: ${first}` : `${unpaired.length} assertions removed, e.g. ${first}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// dependency-added
// ---------------------------------------------------------------------------

interface DepScan {
  added: string[];
  removed: string[];
}

/**
 * New dependency names in a manifest hunk. Version bumps are not "new": a
 * name both removed and added in the same hunk is ignored.
 */
function detectNewDependencies(path: string, lines: DiffLine[]): string[] {
  const base = posix.basename(path);
  let scan: DepScan | null = null;
  if (base === 'package.json') scan = scanJsonManifest(lines, NPM_DEP_SECTIONS, NPM_SCALAR_FIELDS);
  else if (base === 'composer.json') scan = scanJsonManifest(lines, COMPOSER_DEP_SECTIONS, COMPOSER_SCALAR_FIELDS);
  else if (/^requirements[\w.-]*\.(?:txt|in)$/.test(base) || /(?:^|\/)requirements\/[^/]+\.(?:txt|in)$/.test(path)) {
    scan = scanRequirements(lines);
  } else if (base === 'pyproject.toml') scan = scanPyproject(lines);
  else if (base === 'Cargo.toml') scan = scanCargo(lines);
  else if (base === 'go.mod') scan = scanGoMod(lines);
  else if (base === 'Gemfile' || base.endsWith('.gemspec')) scan = scanGemfile(lines);
  if (!scan) return [];
  const removed = new Set(scan.removed);
  return uniq(scan.added.filter((n) => !removed.has(n)));
}

const NPM_DEP_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const NPM_SCALAR_FIELDS = new Set([
  'name', 'version', 'description', 'main', 'module', 'types', 'typings', 'license', 'author', 'homepage',
  'type', 'packageManager', 'private', 'sideEffects', 'browser', 'unpkg', 'jsdelivr',
]);
/** `engines` entries look like dependencies when the section header is not in the hunk. */
const RUNTIME_NAMES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'vscode']);
const COMPOSER_DEP_SECTIONS = new Set(['require', 'require-dev']);
const COMPOSER_SCALAR_FIELDS = new Set(['name', 'version', 'description', 'type', 'license', 'minimum-stability', 'homepage']);
const VERSION_SPEC = /^(?:[\^~<>=*]|\d|v\d|workspace:|npm:|file:|link:|portal:|catalog:|git|github:|https?:|latest$|next$|dev-)/;

/**
 * JSON manifests. The section is tracked from `"key": {` / `}` lines visible in
 * the hunk. When the hunk starts inside an unknown section, an entry counts as
 * a dependency only if its value looks like a version spec and its key is not
 * a well-known scalar field (`"version": "1.0.0"`).
 */
function scanJsonManifest(lines: DiffLine[], sections: ReadonlySet<string>, scalars: ReadonlySet<string>): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  let section: string | null | undefined; // undefined = unknown, null = top level
  for (const l of lines) {
    const open = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(l.text);
    if (open) {
      section = open[1];
      continue;
    }
    if (/^\s*\}/.test(l.text)) {
      section = null;
      continue;
    }
    if (l.type === 'ctx') continue;
    const entry = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/.exec(l.text);
    if (!entry || !entry[1]) continue;
    const [name, value] = [entry[1], entry[2] ?? ''];
    const isDep =
      section === undefined
        ? VERSION_SPEC.test(value) && !scalars.has(name) && !RUNTIME_NAMES.has(name)
        : section !== null && sections.has(section);
    if (isDep) (l.type === 'add' ? scan.added : scan.removed).push(name);
  }
  return scan;
}

function requirementName(spec: string): string | null {
  const m = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m?.[1] ? m[1].toLowerCase().replace(/_/g, '-') : null;
}

function scanRequirements(lines: DiffLine[]): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  for (const l of lines) {
    if (l.type === 'ctx') continue;
    const t = l.text.replace(/#.*$/, '').trim();
    if (!t || t.startsWith('-')) continue; // -r other.txt, -e ., --index-url
    const name = requirementName(t);
    if (name) (l.type === 'add' ? scan.added : scan.removed).push(name);
  }
  return scan;
}

/** Walk TOML lines tracking the current `[table]` and open multi-line array key. */
function walkToml(lines: DiffLine[], visit: (l: DiffLine, table: string | undefined, arrayKey: string | null) => void): void {
  let table: string | undefined;
  let arrayKey: string | null = null;
  for (const l of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(l.text);
    if (header && header[1]) {
      table = header[1].replace(/["']/g, '');
      arrayKey = null;
      visit(l, table, null);
      continue;
    }
    const arr = /^\s*([\w.-]+)\s*=\s*\[\s*(?:#.*)?$/.exec(l.text);
    if (arr && arr[1]) {
      arrayKey = arr[1];
      continue;
    }
    if (arrayKey !== null && /^\s*\]/.test(l.text)) {
      arrayKey = null;
      continue;
    }
    visit(l, table, arrayKey);
  }
}

const PY_DEP_TABLE = /^(?:tool\.poetry\.(?:group\.[\w-]+\.)?(?:dev-)?dependencies|tool\.pdm\.dev-dependencies)$/;
const PY_ARRAY_TABLE = /^(?:project\.optional-dependencies|dependency-groups)$/;

/**
 * pyproject.toml: PEP 621 `dependencies = [...]`, optional-dependencies,
 * dependency-groups, and Poetry `name = "^1.0"` tables. Outside a known table
 * only quoted requirements carrying a version operator count (`"httpx>=0.27"`),
 * so `keywords = ["cli"]` stays quiet.
 */
function scanPyproject(lines: DiffLine[]): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  walkToml(lines, (l, table, arrayKey) => {
    if (l.type === 'ctx') return;
    const bucket = l.type === 'add' ? scan.added : scan.removed;
    const text = l.text.replace(/#.*$/, '');
    if (table && PY_DEP_TABLE.test(table)) {
      const kv = /^\s*([\w.-]+)\s*=/.exec(text);
      if (kv?.[1] && kv[1] !== 'python') bucket.push(kv[1].toLowerCase());
      return;
    }
    const inDepArray =
      (arrayKey !== null && /dependencies$/.test(arrayKey)) || (arrayKey !== null && table !== undefined && PY_ARRAY_TABLE.test(table));
    const inline = /^\s*(?:dependencies|[\w-]*-dependencies)\s*=\s*\[(.*)\]/.exec(text);
    const strings = [...(inline?.[1] ?? text).matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? '');
    for (const s of strings) {
      if (!inDepArray && !inline && !(table === undefined && /[<>=~!]=?|@/.test(s))) continue;
      if (s.includes('::')) continue; // classifiers
      const name = requirementName(s);
      if (name) bucket.push(name);
    }
  });
  return scan;
}

const CARGO_DEP_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies$/;

function scanCargo(lines: DiffLine[]): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  walkToml(lines, (l, table) => {
    if (l.type === 'ctx' || !table) return;
    const bucket = l.type === 'add' ? scan.added : scan.removed;
    const header = /^\s*\[/.test(l.text) ? /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(table) : null;
    if (header?.[1]) {
      bucket.push(header[1]);
      return;
    }
    if (!CARGO_DEP_TABLE.test(table)) return;
    const kv = /^\s*([\w-]+)\s*=/.exec(l.text);
    if (kv?.[1]) bucket.push(kv[1]);
  });
  return scan;
}

function scanGoMod(lines: DiffLine[]): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  let block: string | null | undefined; // undefined = unknown
  for (const l of lines) {
    const open = /^\s*(require|replace|exclude|retract|tool|godebug)\s*\(\s*$/.exec(l.text);
    if (open) {
      block = open[1];
      continue;
    }
    if (/^\s*\)\s*$/.test(l.text)) {
      block = null;
      continue;
    }
    if (l.type === 'ctx') continue;
    const single = /^\s*require\s+(\S+)\s+v\d/.exec(l.text);
    const inBlock = block === 'require' || block === undefined ? /^\s*([\w.~-]+(?:\/[\w.~-]+)+|[\w-]+\.[\w.-]+)\s+v\d+\.\d+\.\d+\S*\s*(?:\/\/.*)?$/.exec(l.text) : null;
    const name = single?.[1] ?? inBlock?.[1];
    if (name) (l.type === 'add' ? scan.added : scan.removed).push(name);
  }
  return scan;
}

function scanGemfile(lines: DiffLine[]): DepScan {
  const scan: DepScan = { added: [], removed: [] };
  for (const l of lines) {
    if (l.type === 'ctx') continue;
    const m = /^\s*(?:gem|\w+\.add_(?:development_|runtime_)?dependency)\s*\(?\s*["']([^"']+)["']/.exec(l.text);
    if (m?.[1]) (l.type === 'add' ? scan.added : scan.removed).push(m[1]);
  }
  return scan;
}

// ---------------------------------------------------------------------------
// config-changed
// ---------------------------------------------------------------------------

/**
 * Tool/build configuration. Path-based for dedicated config files; content
 * based for config embedded in manifests: `[tool.*]` tables in pyproject.toml
 * and the `"scripts"` block of package.json (an agent rewriting `"test"` is
 * worth a look). Embedded sections are only detected when their header is
 * visible in the hunk (context or changed lines).
 */
function detectConfigChange(path: string, lines: DiffLine[]): string | null {
  const base = posix.basename(path);
  if (isCiFile(path)) return null; // ci-changed covers it
  if (CONFIG_BASENAMES.some((re) => re.test(base))) return `Config changed (${base})`;

  if (base === 'pyproject.toml') {
    const tools = new Set<string>();
    walkToml(lines, (l, table) => {
      if (l.type === 'ctx' || !table || !table.startsWith('tool.') || PY_DEP_TABLE.test(table)) return;
      tools.add(table.split('.')[1] ?? table);
    });
    if (tools.size > 0) return `Tool config changed in pyproject.toml: ${[...tools].join(', ')}`;
  }

  if (base === 'package.json') {
    let section: string | null | undefined;
    const changed = new Set<string>();
    for (const l of lines) {
      const open = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(l.text);
      if (open) section = open[1];
      else if (/^\s*\}/.test(l.text)) section = null;
      else if (l.type !== 'ctx' && section && PKG_CONFIG_SECTIONS.has(section)) changed.add(section);
    }
    if (changed.size > 0) return `package.json ${[...changed].join(', ')} changed`;
  }
  return null;
}

const PKG_CONFIG_SECTIONS = new Set(['scripts', 'jest', 'eslintConfig', 'prettier', 'engines', 'overrides', 'resolutions', 'pnpm']);

// ---------------------------------------------------------------------------
// lint-suppressed
// ---------------------------------------------------------------------------

/**
 * Suppression comments. Matched on lines with string literals blanked out,
 * so a log message mentioning `@ts-ignore` does not count. Prose files
 * (Markdown, reST, plain text) are skipped: docs often quote these directives.
 */
const LINT_PATTERNS: readonly Pattern[] = [
  { re: /(?:\/\/|\/\*|<!--|#)\s*(eslint-disable(?:-next-line|-line)?)\b/, name: '$1' },
  { re: /(?:\/\/|\/\*)\s*(@ts-(?:ignore|expect-error|nocheck))\b/, name: '$1' },
  { re: /(?:\/\/|\/\*)\s*(biome-ignore|oxlint-disable|tslint:disable)/, name: '$1' },
  { re: /#\s*(noqa)\b/, name: '# noqa' },
  { re: /#\s*(type:\s*ignore)\b/, name: '# type: ignore' },
  { re: /#\s*(pyright:\s*ignore|pylint:\s*disable|mypy:\s*ignore-errors)\b/, name: '# $1' },
  { re: /#\s*(pragma:\s*no cover)\b/, name: '# pragma: no cover' },
  { re: /\/\/\s*(nolint)\b/, name: '//nolint' },
  { re: /(#!?\[allow\()/, name: '#[allow(...)]', ext: ['rs'] },
  { re: /#\s*(rubocop:disable)\b/, name: 'rubocop:disable' },
  { re: /(@SuppressWarnings)\s*\(/, name: '@SuppressWarnings', ext: ['java', 'kt', 'kts', 'scala', 'groovy'] },
  { re: /(#pragma\s+warning\s+disable)\b/, name: '#pragma warning disable', ext: ['cs', 'c', 'cpp', 'h', 'hpp'] },
  { re: /(?:\/\/|\/\*)\s*((?:istanbul|c8|v8)\s+ignore)\b/, name: '$1' },
];

function detectLintSuppressions(path: string, lines: DiffLine[]): string[] {
  if (PROSE_EXT.has(extOf(path)) || isLockfile(path)) return [];
  const hits: string[] = [];
  for (const l of netAdded(lines)) hits.push(...matchPatterns(stripStrings(l.text), LINT_PATTERNS, path, false));
  return uniq(hits);
}

// ---------------------------------------------------------------------------
// type-any-added
// ---------------------------------------------------------------------------

/** Only for TypeScript sources; code with strings and comments removed. */
const ANY_PATTERNS: readonly Pattern[] = [
  { re: /\bas\s+unknown\s+as\b/, name: '`as unknown as`' },
  { re: /\bas\s+any(?![\w$])/, name: '`as any`' },
  { re: /<any>/, name: '`<any>`' },
  { re: /(?<![\w$])any\s*\[\s*\]/, name: '`any[]`' },
  { re: /[:|&]\s*any(?![\w$])/, name: '`: any`' },
  { re: /[<,]\s*any\s*(?=[,>])/, name: '`any` type argument' },
];

function detectTypeAny(path: string, lines: DiffLine[]): string[] {
  if (!TS_EXT.has(extOf(path))) return [];
  const hits: string[] = [];
  for (const l of netAdded(lines)) {
    const code = codeOf(l.text, 'slash');
    const lineHits = matchPatterns(code, ANY_PATTERNS, path, false);
    // `<any>` is also a type argument; report it once.
    hits.push(...(lineHits.includes('`<any>`') ? lineHits.filter((h) => h !== '`any` type argument') : lineHits));
  }
  return uniq(hits);
}

// ---------------------------------------------------------------------------
// secret-like
// ---------------------------------------------------------------------------

/** Quoted 32+ char values, the candidates for `apiKey = "…"`, `"client_secret": "…"`, `token := "…"`. */
const QUOTED_LONG_VALUE = /["'`]([^"'`\s]{32,})["'`]/g;
/** A secret-sounding name and an assignment operator, anchored right before the quoted value. */
const SECRET_NAME_BEFORE = /([A-Za-z_][\w.-]*?(?:key|secret|token|passw(?:or)?d|pwd|credential|auth)[\w-]*)["']?\s*(?::=|=>|[:=])\s*$/i;
const SECRET_NAME_WINDOW = 160;

/**
 * `name = "value"` with a secret-sounding name. Linear: find each quoted 32+
 * char value first and look for the name only in the text right before it.
 * One regex with a lazy name pattern tried from every position was quadratic
 * on long lines (minified bundles, JSON reports).
 */
function secretAssignment(text: string): [string, string, string] | null {
  for (const m of text.matchAll(QUOTED_LONG_VALUE)) {
    const before = text.slice(Math.max(0, m.index - SECRET_NAME_WINDOW), m.index);
    const n = SECRET_NAME_BEFORE.exec(before);
    if (n?.[1] && m[1]) return [n[0] + m[0], n[1], m[1]];
  }
  return null;
}
/** Unquoted values only in dotenv/shell style: `export API_TOKEN=...` with an UPPER_SNAKE name. */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)\s*=\s*([^\s"'`#]{32,})\s*(?:#.*)?$/;
const PLACEHOLDER = /your|example|placeholder|changeme|change-me|dummy|fake|sample|redacted|replace|xxxx|\*\*\*\*|\$\{|\{\{|process\.env|os\.environ/i;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A value assigned to a secret-sounding name is flagged when it is 32+ chars of
 * base64/hex alphabet, contains a digit and a letter, has entropy >= 3.5
 * bits/char and does not look like a placeholder or an env lookup.
 */
function looksLikeSecretValue(v: string): boolean {
  return (
    /^[A-Za-z0-9+/=_.-]+$/.test(v) &&
    /\d/.test(v) &&
    /[A-Za-z]/.test(v) &&
    !PLACEHOLDER.test(v) &&
    !/^[a-z]+(?:[._-][a-z]+)+$/.test(v) &&
    entropy(v) >= 3.5
  );
}

function detectSecrets(path: string, lines: DiffLine[]): string[] {
  if (isLockfile(path)) return [];
  const found: string[] = [];
  for (const l of netAdded(lines)) {
    const where = l.newNo !== undefined ? ` on line ${l.newNo}` : '';
    let matched = false;
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(l.text);
      if (!m) continue;
      matched = true;
      found.push(rule.name === 'private key' ? `private key block${where}` : `${rule.name} (${mask(m[0])})${where}`);
      break;
    }
    if (matched) continue;
    const a = secretAssignment(l.text) ?? ENV_ASSIGNMENT.exec(l.text);
    const value = a?.[2];
    if (a?.[1] && value && looksLikeSecretValue(value)) {
      found.push(`high-entropy value assigned to ${clip(a[1], 40)} (${value.length} chars, masked)${where}`);
    }
  }
  return uniq(found);
}

/** Keep only the public, format-identifying prefix. */
function mask(secret: string): string {
  return `${secret.slice(0, 4)}…, ${secret.length} chars`;
}

// ---------------------------------------------------------------------------
// out-of-scope
// ---------------------------------------------------------------------------

interface ScopeIndex {
  /** Lower-cased concatenation of every prompt. Empty when there are no prompts. */
  promptText: string;
  /** Distinct repo paths of agent-attributed hunks. */
  agentFiles: string[];
  /** Stems of source files deleted or renamed away anywhere in the diff. */
  goneSourceStems: Set<string>;
  /** Directories each prompt points at: dirs of touched files it names by basename/stem, and dirs of path-like tokens in it. */
  promptDirs: Map<string, Set<string>>;
  /** Distinct repo paths of the agent-attributed hunks each prompt produced. */
  promptFiles: Map<string, string[]>;
  /** Per prompt, the subset of its files that it anchors (computed once per prompt, on first use). */
  anchoredFiles: Map<string, Set<string>>;
  /** Lower-cased text of each prompt, by id. */
  promptTexts: Map<string, string>;
  fileText?: LabelContext['fileText'];
}

function hunkPromptIds(h: AttributedHunk): string[] {
  return uniq([...(h.prompt ? [h.prompt.id] : []), ...h.edits.filter((e) => e.failed !== true).map((e) => e.promptId)]);
}

function buildScopeIndex(hunks: AttributedHunk[], ctx: LabelContext): ScopeIndex {
  const agent = hunks.filter(isAgentAttributed);
  const promptDirs = new Map<string, Set<string>>();
  const promptFiles = new Map<string, string[]>();
  const dirsOf = (id: string): Set<string> => {
    let d = promptDirs.get(id);
    if (!d) promptDirs.set(id, (d = new Set()));
    return d;
  };
  for (const h of agent) {
    const path = toRepoPath(h.hunk.file, ctx.repoRoot);
    for (const id of hunkPromptIds(h)) {
      promptFiles.set(id, uniq([...(promptFiles.get(id) ?? []), path]));
      const text = ctx.prompts.find((p) => p.id === id)?.text.toLowerCase() ?? '';
      if (fileMentioned(path, text)) dirsOf(id).add(posix.dirname(path));
    }
  }
  for (const p of ctx.prompts) {
    // Path-like tokens ("src/cart.js") name their directory directly. URLs and domain-like tokens are not paths.
    const text = p.text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
    for (const m of text.matchAll(/[\w@.-]+(?:\/[\w@.-]+)+/g)) {
      const token = m[0].replace(/^\.\//, '');
      if (/^[\w-]+\.[a-z]{2,}\//i.test(token)) continue;
      const dir = posix.dirname(token);
      if (dir !== '.') dirsOf(p.id).add(dir);
    }
  }
  return {
    promptDirs,
    promptFiles,
    anchoredFiles: new Map(),
    promptTexts: new Map(ctx.prompts.map((p) => [p.id, p.text.toLowerCase()])),
    promptText: ctx.prompts.map((p) => p.text).join('\n').toLowerCase(),
    agentFiles: uniq(hunks.filter(isAgentAttributed).map((h) => toRepoPath(h.hunk.file, ctx.repoRoot))),
    goneSourceStems: goneSourceStems(hunks, ctx.repoRoot),
    ...(ctx.fileText ? { fileText: ctx.fileText } : {}),
  };
}

/** True when the text names the file by basename, or by stem (>= 4 chars). */
function fileMentioned(path: string, text: string): boolean {
  const base = posix.basename(path);
  const stem = base.replace(/\.[^.]+$/, '');
  return mentioned(base, text) || (stem.length >= 4 && mentioned(stem, text));
}

function mentioned(token: string, text: string): boolean {
  const t = token.toLowerCase();
  let i = text.indexOf(t);
  while (i >= 0) {
    const before = text.charAt(i - 1);
    const after = text.charAt(i + t.length);
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    i = text.indexOf(t, i + 1);
  }
  return false;
}

/** Same directory, or both at least two levels deep and sharing the first two segments (src/parser vs src/parser/ast). */
function sameArea(a: string, b: string): boolean {
  if (a === b) return true;
  const ka = a.split('/').slice(0, 2);
  const kb = b.split('/').slice(0, 2);
  return ka.length === 2 && kb.length === 2 && ka.join('/') === kb.join('/');
}

/** True when one directory equals or contains the other (repo root contains nothing). */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '.' || b === '.') return false;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Heuristic, agent-attributed hunks only. Creating a file does not put it in
 * scope. A file is in scope when ANY of:
 *
 * - a prompt mentions it: its basename, its basename without the extension
 *   (>= 4 chars), or a directory segment of >= 4 chars appears as a whole word
 *   in any prompt;
 * - the prompt that produced it points at its area: it shares a directory (or
 *   the first two path segments) with a file or path that prompt mentions;
 * - it sits with the rest of that prompt's work: more than half of the other
 *   files the same prompt touched live in the same directory or an
 *   ancestor/descendant. When the prompt names some touched file (it is
 *   anchored), only those anchored files count, so wandering files never vouch
 *   for each other; a prompt that names nothing we touched is judged on all
 *   its files.
 *
 * Skipped when there are no prompts or the agent touched a single file, and
 * for lockfiles and snapshots (derived artefacts of an in-scope change).
 */
function pathTokens(path: string): string[] {
  const base = posix.basename(path);
  const stem = base.replace(/\.[^.]+$/, '');
  const segments = posix.dirname(path).split('/').filter((s) => s.length >= 4 && s !== '.');
  return [base, ...(stem.length >= 4 ? [stem] : []), ...segments];
}

/** True when the prompt names the file (or its directory), or points at its area. */
function anchoredBy(path: string, id: string, scope: ScopeIndex): boolean {
  const text = scope.promptTexts.get(id) ?? '';
  if (pathTokens(path).some((t) => mentioned(t, text))) return true;
  const dir = posix.dirname(path);
  for (const d of scope.promptDirs.get(id) ?? []) if (d !== '.' && sameArea(d, dir)) return true;
  return false;
}

function anchoredFilesOf(id: string, scope: ScopeIndex): Set<string> {
  let set = scope.anchoredFiles.get(id);
  if (!set) {
    set = new Set((scope.promptFiles.get(id) ?? []).filter((f) => anchoredBy(f, id, scope)));
    scope.anchoredFiles.set(id, set);
  }
  return set;
}

function outOfScopeReason(path: string, scope: ScopeIndex, ids: string[]): string | null {
  if (!scope.promptText || isLockfile(path) || isSnapshotFile(path)) return null;
  const dir = posix.dirname(path);
  if (pathTokens(path).some((t) => mentioned(t, scope.promptText))) return null;
  if (ids.some((id) => anchoredBy(path, id, scope))) return null;

  if (scope.agentFiles.every((f) => f === path)) return null;
  const others = uniq(ids.flatMap((id) => scope.promptFiles.get(id) ?? [])).filter((f) => f !== path);
  // A prompt that names some touched file is anchored: only anchored files vouch for their neighbours.
  const anchored = others.filter((f) => ids.some((id) => anchoredFilesOf(id, scope).has(f)));
  const pool = anchored.length > 0 ? anchored : others;
  if (pool.length > 0) {
    const near = pool.filter((f) => related(posix.dirname(f), dir)).length;
    if (near / pool.length > 0.5) return null;
  }
  return `Not mentioned in any prompt and away from the agent's other edits (${dir === '.' ? 'repo root' : `${dir}/`})`;
}
