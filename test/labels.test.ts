import { describe, expect, it } from 'vitest';
import { bestOf, expectScalesSubQuadratically } from './helpers/perf.js';
import { isLockfile, isTestFile, labelHunks } from '../src/labels.js';
import type { AttributedHunk, DiffLine, FileEdit, Label, LabelKind, Prompt } from '../src/types.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Lines in unified-diff shorthand: '+added', '-removed', ' context'.
 * A line starting with any other character is context kept verbatim
 * (handy for `[tool.ruff]` or `require (`).
 */
function diffLines(src: string[]): DiffLine[] {
  let oldNo = 1;
  let newNo = 1;
  return src.map((raw) => {
    const sign = raw.charAt(0);
    const text = raw.slice(1);
    if (sign === '+') return { type: 'add', text, newNo: newNo++ };
    if (sign === '-') return { type: 'del', text, oldNo: oldNo++ };
    const ctxText = sign === ' ' ? text : raw;
    return { type: 'ctx', text: ctxText, oldNo: oldNo++, newNo: newNo++ };
  });
}

let seq = 0;

function edit(file: string): FileEdit {
  return {
    id: `s1:toolu_${seq}:0`,
    sessionId: 's1',
    harness: 'claude-code',
    toolUseId: `toolu_${seq}`,
    tool: 'Edit',
    kind: 'edit',
    filePath: `/repo/${file}`,
    at: '2026-10-31T10:00:00Z',
    promptId: 's1:0',
    oldText: 'a',
    newText: 'b',
  };
}

function hunk(file: string, lines: string[], opts: { agent?: boolean; labels?: Label[] } = {}): AttributedHunk {
  const agent = opts.agent ?? true;
  seq++;
  return {
    hunk: {
      id: `h${seq}`,
      file,
      status: 'modified',
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 0,
      header: '@@ -1 +1 @@',
      lines: diffLines(lines),
    },
    match: agent ? 'exact' : 'none',
    coverage: agent ? 1 : 0,
    editIds: agent ? [`s1:toolu_${seq}:0`] : [],
    edits: agent ? [edit(file)] : [],
    labels: opts.labels ?? [],
  };
}

function prompt(text: string): Prompt {
  return { id: 's1:0', sessionId: 's1', harness: 'claude-code', index: 0, at: '2026-10-31T09:59:00Z', text };
}

const ctx = { prompts: [] as Prompt[], repoRoot: '/repo' };

function labelsOf(h: AttributedHunk, prompts: Prompt[] = []): Label[] {
  const [out] = labelHunks([h], { ...ctx, prompts });
  return out?.labels ?? [];
}

function kinds(h: AttributedHunk): LabelKind[] {
  return labelsOf(h).map((l) => l.kind);
}

function find(h: AttributedHunk, kind: LabelKind): Label | undefined {
  return labelsOf(h).find((l) => l.kind === kind);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it.each([
    ['src/math.test.ts', true],
    ['src/Button.spec.tsx', true],
    ['apps/api/test/app.e2e-spec.ts', true],
    ['src/__tests__/util.js', true],
    ['tests/test_parser.py', true],
    ['pkg/parser_test.py', true],
    ['test_cli.py', true],
    ['tests/conftest.py', true],
    ['internal/store/store_test.go', true],
    ['src/test/java/com/acme/CalculatorTest.java', true],
    ['src/main/java/com/acme/CalculatorTests.java', true],
    ['Acme.Tests/OrderServiceTests.cs', true],
    ['spec/models/user_spec.rb', true],
    ['cypress/e2e/login.cy.ts', true],
    ['playwright/checkout.ts', true],
    ['e2e/smoke.ts', true],
    // negatives
    ['src/math.ts', false],
    ['src/main/java/com/acme/Latest.java', false],
    ['src/contest/entry.ts', false],
    ['src/testing-utils.ts', false],
    ['src/attestation.py', false],
    ['src/__snapshots__/Button.test.tsx.snap', false],
    ['docs/testimonials.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe('isLockfile', () => {
  it.each([
    ['package-lock.json', true],
    ['web/pnpm-lock.yaml', true],
    ['yarn.lock', true],
    ['bun.lockb', true],
    ['poetry.lock', true],
    ['Cargo.lock', true],
    ['go.sum', true],
    ['package.json', false],
    ['go.mod', false],
    ['docs/lock.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(isLockfile(path)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// labelHunks contract
// ---------------------------------------------------------------------------

describe('labelHunks contract', () => {
  it('returns new objects and does not mutate input', () => {
    const h = hunk('src/a.test.ts', ['+it("x", () => {})']);
    const before = JSON.stringify(h);
    const [out] = labelHunks([h], ctx);
    expect(out).not.toBe(h);
    expect(JSON.stringify(h)).toBe(before);
    expect(out?.labels.map((l) => l.kind)).toContain('test-modified');
  });

  it('keeps existing labels and dedupes by kind', () => {
    const existing: Label = { kind: 'test-modified', severity: 'info', detail: 'set upstream' };
    const unattributed: Label = { kind: 'unattributed', severity: 'warn', detail: 'no edit' };
    const h = hunk('src/a.test.ts', ['+it("x", () => {})'], { labels: [unattributed, existing] });
    const labels = labelsOf(h);
    expect(labels.filter((l) => l.kind === 'test-modified')).toEqual([existing]);
    expect(labels[0]).toEqual(unattributed);
  });

  it('never produces unattributed or bash-edit', () => {
    const h = hunk('x.sh', ['+echo hi'], { agent: false });
    expect(kinds(h)).not.toContain('unattributed');
    expect(kinds(h)).not.toContain('bash-edit');
  });

  it('keeps details at or under 120 chars', () => {
    const names = Array.from({ length: 40 }, (_, i) => `    "some-really-long-package-name-${i}": "^1.0.0",`);
    const h = hunk('package.json', ['  "dependencies": {', ...names.map((n) => `+${n}`), '  }']);
    for (const l of labelsOf(h)) expect(l.detail.length).toBeLessThanOrEqual(120);
  });

  it('accepts absolute file paths under repoRoot', () => {
    expect(kinds(hunk('/repo/src/a.test.ts', ['+x']))).toContain('test-modified');
  });
});

// ---------------------------------------------------------------------------
// test-modified
// ---------------------------------------------------------------------------

describe('test-modified', () => {
  it('is risk when the agent edits a test', () => {
    expect(find(hunk('tests/test_api.py', ['+x = 1']), 'test-modified')?.severity).toBe('risk');
  });

  it('is info when a human edits a test', () => {
    expect(find(hunk('tests/test_api.py', ['+x = 1'], { agent: false }), 'test-modified')?.severity).toBe('info');
  });

  it('treats failed edits as not agent-attributed', () => {
    const h = hunk('a_test.go', ['+x']);
    h.edits = h.edits.map((e) => ({ ...e, failed: true }));
    expect(find(h, 'test-modified')?.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// test-skip-added
// ---------------------------------------------------------------------------

describe('test-skip-added', () => {
  it.each([
    ['src/a.test.ts', '  it.skip("adds", () => {})', '.skip'],
    ['src/a.test.ts', '  describe.only("suite", () => {})', '.only'],
    ['src/a.spec.ts', '  test.todo("later")', '.todo'],
    ['e2e/a.ts', '  test.fixme("flaky", async () => {})', '.fixme'],
    ['e2e/a.ts', '  test.describe.skip("group", () => {})', '.skip'],
    ['src/a.test.js', '  xit("adds", () => {})', 'xit'],
    ['src/a.test.js', 'xdescribe("math", () => {})', 'xdescribe'],
    ['src/a.test.js', '  fit("focused", () => {})', 'fit'],
    ['src/a.test.js', '  pending("not yet")', 'pending()'],
    ['tests/test_a.py', '@pytest.mark.skip(reason="flaky")', '@pytest.mark.skip'],
    ['tests/test_a.py', '@pytest.mark.skipif(sys.platform == "win32", reason="x")', '@pytest.mark.skipif'],
    ['tests/test_a.py', '    pytest.skip("no network")', 'pytest.skip()'],
    ['tests/test_a.py', '@unittest.skip("broken")', '@unittest.skip'],
    ['tests/test_a.py', '        self.skipTest("later")', 'self.skipTest()'],
    ['store_test.go', '\tt.Skip("flaky on CI")', 't.Skip()'],
    ['store_test.go', '\tt.Skipf("skip %d", n)', 't.Skipf()'],
    ['src/test/java/FooTest.java', '    @Disabled("flaky")', '@Disabled'],
    ['src/test/java/FooTest.java', '    @Ignore', '@Ignore'],
    ['Tests/FooTests.cs', '    [Ignore("later")]', '[Ignore]'],
    ['Tests/FooTests.cs', '    [Fact(Skip = "flaky")]', '[Fact(Skip=…)]'],
    ['src/lib.rs', '    #[ignore]', '#[ignore]'],
    ['spec/user_spec.rb', '    skip "not implemented"', 'skip'],
    ['spec/user_spec.rb', '    pending', 'pending'],
    ['spec/user_spec.rb', '  xit "works" do', 'xit'],
  ])('%s: %s', (file, line, name) => {
    const l = find(hunk(file, [`+${line}`]), 'test-skip-added');
    expect(l?.severity).toBe('risk');
    expect(l?.detail).toContain(name);
  });

  it.each([
    ['skip in a variable name', 'src/a.test.ts', 'const skipCount = 3;'],
    ['shouldSkip() helper', 'src/a.test.ts', 'if (shouldSkip(row)) return;'],
    ['skip inside a test title', 'src/a.test.ts', 'it("should skip empty rows", () => {});'],
    ['only inside a string', 'src/a.test.ts', 'const msg = "use it.only( to focus";'],
    ['commented out', 'src/a.test.ts', '// it.skip("old", () => {})'],
    ['python comment', 'tests/test_a.py', '# pytest.skip("not needed")'],
    ['cursor .skip in app code', 'src/repo.ts', 'return db.users.find().skip(10).limit(5);'],
    ['fit() in app code', 'src/model.py', 'model.fit(X, y)'],
    ['pending() in app code', 'src/queue.ts', 'const n = pending(queue);'],
    ['t.Skip in non-Go file', 'src/a.test.ts', 't.Skip()'],
    ['@Disabled outside Java', 'src/a.ts', '@Disabled'],
    ['skip as Ruby method arg', 'spec/user_spec.rb', '    result = list.skip_while { |x| x }'],
    ['docs mention', 'docs/testing.md', 'Use `it.skip(` to skip a test.'],
  ])('ignores %s', (_why, file, line) => {
    expect(kinds(hunk(file, [`+${line}`]))).not.toContain('test-skip-added');
  });

  it('ignores a skip that was already there (moved line)', () => {
    const h = hunk('src/a.test.ts', ['-  it.skip("x", () => {})', '+    it.skip("x", () => {})']);
    expect(kinds(h)).not.toContain('test-skip-added');
  });

  it('reports one name per line', () => {
    const l = find(hunk('src/a.test.ts', ['+it.skip("x", () => {})']), 'test-skip-added');
    expect(l?.detail).toBe('Adds .skip');
  });
});

// ---------------------------------------------------------------------------
// assertion-removed
// ---------------------------------------------------------------------------

describe('assertion-removed', () => {
  it.each([
    ['JS expect removed', 'src/a.test.ts', ['   const r = add(2, 2);', '-  expect(r).toBe(4);'], 'removed'],
    ['Python bare assert removed', 'tests/test_a.py', ['    r = add(2, 2)', '-    assert r == 4'], 'removed'],
    ['unittest removed', 'tests/test_a.py', ['-        self.assertEqual(r, 4)'], 'removed'],
    ['Go testify removed', 'calc_test.go', ['-\trequire.Equal(t, 4, got)'], 'removed'],
    ['Go t.Errorf removed', 'calc_test.go', ['\tif got != 4 {', '-\t\tt.Errorf("got %d", got)', '\t}'], 'removed'],
    ['JUnit removed', 'src/test/java/CalcTest.java', ['-        assertEquals(4, calc.add(2, 2));'], 'removed'],
    ['RSpec removed', 'spec/calc_spec.rb', ['-    expect(calc.add(2, 2)).to eq(4)'], 'removed'],
    ['Rust inline assert removed', 'src/lib.rs', ['-        assert_eq!(add(2, 2), 4);'], 'removed'],
    ['multi-line chain removed', 'src/a.test.ts', ['   expect(', '     add(2, 2),', '-  ).toEqual(4);'], 'removed'],
    ['node assert removed', 'test/a.mjs', ['-  assert.strictEqual(r, 4);'], 'removed'],
    ['C# NUnit removed', 'Tests/CalcTests.cs', ['-        Assert.AreEqual(4, calc.Add(2, 2));'], 'removed'],
  ])('%s', (_name, file, lines, word) => {
    const l = find(hunk(file, lines), 'assertion-removed');
    expect(l?.severity).toBe('risk');
    expect(l?.detail).toContain(word);
  });

  it.each([
    ['toBe to toBeDefined', ['-  expect(user.id).toBe(42);', '+  expect(user.id).toBeDefined();'], 'weakened toBe to toBeDefined'],
    ['toEqual to toBeTruthy', ['-  expect(res.body).toEqual({ ok: true });', '+  expect(res.body).toBeTruthy();'], 'weakened toEqual to toBeTruthy'],
    ['exact to > 0', ['-  expect(items.length).toBe(3);', '+  expect(items.length).toBeGreaterThan(0);'], 'weakened toBe to toBeGreaterThan'],
    ['strict to loose', ['-  expect(cfg).toStrictEqual(want);', '+  expect(cfg).toEqual(want);'], 'weakened toStrictEqual to toEqual'],
    ['toEqual to toMatchObject', ['-  expect(cfg).toEqual(want);', '+  expect(cfg).toMatchObject(want);'], 'weakened toEqual to toMatchObject'],
    ['exact to not.toBeNull', ['-  expect(token).toBe(expected);', '+  expect(token).not.toBeNull();'], 'weakened toBe to toBeNull'],
    ['toThrow(msg) to toThrow()', ['-  expect(fn).toThrow("bad input");', '+  expect(fn).toThrow();'], 'weakened toThrow to toThrow'],
    ['.not removed', ['-  expect(list).not.toContain(secret);', '+  expect(list).toContain(secret);'], '.not removed from toContain'],
    ['expected number changed', ['-  expect(add(2, 2)).toBe(4);', '+  expect(add(2, 2)).toBe(5);'], 'expected value changed 4 to 5'],
    ['expected bool flipped', ['-  expect(isValid(x)).toBe(true);', '+  expect(isValid(x)).toBe(false);'], 'expected value changed true to false'],
  ])('JS weakening: %s', (_name, lines, detail) => {
    expect(find(hunk('src/a.test.ts', lines), 'assertion-removed')?.detail).toContain(detail);
  });

  it.each([
    ['Python == to bare', 'tests/test_a.py', ['-    assert result == 4', '+    assert result'], 'weakened assert == to bare assert'],
    ['Python == to is not None', 'tests/test_a.py', ['-    assert result == 4', '+    assert result is not None'], 'weakened assert == to assert is not None'],
    ['unittest assertEqual to assertTrue', 'tests/test_a.py', ['-        self.assertEqual(result, 4)', '+        self.assertTrue(result)'], 'weakened assertEqual to assertTrue'],
    ['unittest assertEqual to assertIsNotNone', 'tests/test_a.py', ['-        self.assertEqual(result, 4)', '+        self.assertIsNotNone(result)'], 'weakened assertEqual to assertIsNotNone'],
    ['Python expected changed', 'tests/test_a.py', ['-    assert add(2, 2) == 4', '+    assert add(2, 2) == 5'], 'expected value changed 4 to 5'],
    ['testify Equal to NotNil', 'calc_test.go', ['-\trequire.Equal(t, want, got)', '+\trequire.NotNil(t, got)'], 'weakened require.Equal to require.NotNil'],
    ['testify expected changed', 'calc_test.go', ['-\tassert.Equal(t, 4, Add(2, 2))', '+\tassert.Equal(t, 5, Add(2, 2))'], 'expected value changed 4 to 5'],
    ['JUnit assertEquals to assertNotNull', 'src/test/java/CalcTest.java', ['-        assertEquals(expected, calc.total());', '+        assertNotNull(calc.total());'], 'weakened assertEquals to assertNotNull'],
    ['JUnit expected changed', 'src/test/java/CalcTest.java', ['-        assertEquals(4, calc.add(2, 2));', '+        assertEquals(5, calc.add(2, 2));'], 'expected value changed 4 to 5'],
    ['RSpec eq to be_truthy', 'spec/calc_spec.rb', ['-    expect(user.admin?).to eq(true)', '+    expect(user.admin?).to be_truthy'], 'weakened eq to be_truthy'],
    ['RSpec not_to removed', 'spec/calc_spec.rb', ['-    expect(list).not_to include(x)', '+    expect(list).to include(x)'], '.not removed from include'],
  ])('%s', (_name, file, lines, detail) => {
    expect(find(hunk(file, lines), 'assertion-removed')?.detail).toContain(detail);
  });

  it.each([
    ['assertion moved/reindented', 'src/a.test.ts', ['-  expect(r).toBe(4);', '+      expect(r).toBe(4);']],
    ['assertion only added', 'src/a.test.ts', ['+  expect(r).toBe(4);']],
    ['strengthened toBeDefined to toBe', 'src/a.test.ts', ['-  expect(r).toBeDefined();', '+  expect(r).toBe(4);']],
    ['subject renamed, same strength', 'src/a.test.ts', ['-  expect(result).toBe(4);', '+  expect(total).toBe(4);']],
    ['expected string changed (not a numeric weakening)', 'src/a.test.ts', ['-  expect(msg).toBe("a");', '+  expect(msg).toBe("b");']],
    ['assert in a test title', 'src/a.test.ts', ['-  it("should assert the total", () => {', '+  it("checks the total", () => {']],
    ['assert in a comment', 'src/a.test.ts', ['-  // we assert and expect(x) here', '+  // reworded']],
    ['assert in a docstring line', 'tests/test_a.py', ['-    """Make sure we assert totals."""']],
    ['assertion helper definition', 'tests/test_a.py', ['-def assert_valid(x):']],
    ['expect in app code', 'src/parser.ts', ['-  expect(token).toBe(";");']],
    ['assert in python app code', 'src/app.py', ['-    assert config is not None']],
    ['require() in JS test', 'test/a.js', ['-const x = require("./x");']],
    ['require.resolve in JS test', 'test/a.js', ['-const p = require.resolve("./x");']],
  ])('ignores %s', (_name, file, lines) => {
    expect(kinds(hunk(file, lines))).not.toContain('assertion-removed');
  });
});

describe('assertion-removed: rewrites are not removals', () => {
  // Reported false positive (test/cart.test.js): subject extracted to a variable,
  // expected string refined, and more assertions added.
  const cart = [
    "-    expect(receipt(items)).toContain('TOTAL  30');",
    '+    const out = receipt(items);',
    "+    expect(out).toContain('Mug x2  $24.00');",
    "+    expect(out).toContain('Tea x1  $6.00');",
    "+    expect(out).toContain('TOTAL  $30.00');",
  ];

  it.each<[string, string, string[]]>([
    ['cart.test.js: extracted variable + refined total + more checks', 'test/cart.test.js', cart],
    ['extracted variable with `let` and a type annotation', 'src/cart.test.ts', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      '+    let out: string = receipt(items);',
      "+    expect(out).toContain('TOTAL  $30.00');",
    ]],
    ['subject changed, expected literal refined', 'src/cart.test.ts', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      "+    expect(renderReceipt(items, { currency: 'USD' })).toContain('TOTAL  $30.00');",
      "+    expect(renderReceipt(items, { currency: 'USD' })).toContain('Mug');",
    ]],
    ['stricter replacement through a variable', 'src/cart.test.ts', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      '+    const out = receipt(items);',
      "+    expect(out).toEqual('Mug x2  $24.00\\nTOTAL  $30.00');",
    ]],
    ['Python: variable + `in` assertions', 'tests/test_cart.py', [
      '-    assert "TOTAL  30" in receipt(items)',
      '+    out = receipt(items)',
      '+    assert "Mug x2  $24.00" in out',
      '+    assert "TOTAL  $30.00" in out',
    ]],
    ['Go: := variable + testify Contains', 'cart_test.go', [
      '-\tassert.Contains(t, Receipt(items), "TOTAL  30")',
      '+\tout := Receipt(items)',
      '+\tassert.Contains(t, out, "Mug x2  $24.00")',
      '+\tassert.Contains(t, out, "TOTAL  $30.00")',
    ]],
  ])('%s', (_name, file, lines) => {
    expect(kinds(hunk(file, lines))).not.toContain('assertion-removed');
  });

  it.each<[string, string[], string]>([
    ['extracted variable but weaker matcher', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      '+    const out = receipt(items);',
      '+    expect(out).toBeDefined();',
    ], 'weakened toContain to toBeDefined'],
    ['extracted variable, prefers the strong replacement but still flags the dropped one', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      '-    expect(receipt(items)).toEqual(full);',
      '+    const out = receipt(items);',
      "+    expect(out).toContain('TOTAL  $30.00');",
      '+    expect(out).toBeTruthy();',
    ], 'weakened toEqual to toBeTruthy'],
    ['variable extracted but no assertion left', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      '+    const out = receipt(items);',
      '+    console.log(out);',
    ], 'removed'],
    ['unrelated literal, unrelated subject', [
      "-    expect(receipt(items)).toContain('TOTAL  30');",
      "+    expect(header()).toContain('Shop');",
      "+    expect(footer()).toContain('Thanks');",
    ], 'removed'],
    ['numeric expected changed through a variable', [
      '-    expect(total(items)).toBe(30);',
      '+    const t = total(items);',
      '+    expect(t).toBe(31);',
    ], 'expected value changed 30 to 31'],
  ])('still flags: %s', (_name, lines, detail) => {
    expect(find(hunk('src/cart.test.ts', lines), 'assertion-removed')?.detail).toContain(detail);
  });
});

// ---------------------------------------------------------------------------
// snapshot-updated / lockfile / ci-changed / config-changed
// ---------------------------------------------------------------------------

describe('path-based labels', () => {
  it.each<[string, LabelKind, Label['severity']]>([
    ['src/__snapshots__/Button.test.tsx.snap', 'snapshot-updated', 'warn'],
    ['tests/snapshots/parser__parse.snap', 'snapshot-updated', 'warn'],
    ['package-lock.json', 'lockfile', 'info'],
    ['pnpm-lock.yaml', 'lockfile', 'info'],
    ['poetry.lock', 'lockfile', 'info'],
    ['go.sum', 'lockfile', 'info'],
    ['Cargo.lock', 'lockfile', 'info'],
    ['.github/workflows/ci.yml', 'ci-changed', 'risk'],
    ['.gitlab-ci.yml', 'ci-changed', 'risk'],
    ['.circleci/config.yml', 'ci-changed', 'risk'],
    ['Jenkinsfile', 'ci-changed', 'risk'],
    ['azure-pipelines.yml', 'ci-changed', 'risk'],
    ['tsconfig.json', 'config-changed', 'warn'],
    ['packages/web/tsconfig.build.json', 'config-changed', 'warn'],
    ['.eslintrc.cjs', 'config-changed', 'warn'],
    ['eslint.config.mjs', 'config-changed', 'warn'],
    ['.prettierrc', 'config-changed', 'warn'],
    ['prettier.config.js', 'config-changed', 'warn'],
    ['vite.config.ts', 'config-changed', 'warn'],
    ['vitest.config.ts', 'config-changed', 'warn'],
    ['next.config.mjs', 'config-changed', 'warn'],
    ['webpack.config.js', 'config-changed', 'warn'],
    ['babel.config.js', 'config-changed', 'warn'],
    ['.babelrc', 'config-changed', 'warn'],
    ['jest.config.ts', 'config-changed', 'warn'],
    ['Dockerfile', 'config-changed', 'warn'],
    ['docker/Dockerfile.prod', 'config-changed', 'warn'],
    ['.env.example', 'config-changed', 'warn'],
    ['setup.cfg', 'config-changed', 'warn'],
  ])('%s -> %s (%s)', (file, kind, severity) => {
    expect(find(hunk(file, ['+x']), kind)?.severity).toBe(severity);
  });

  it.each([
    ['src/config.ts', 'config-changed'],
    ['src/viteHelpers.ts', 'config-changed'],
    ['docs/workflows/ci.md', 'ci-changed'],
    ['src/snapshot.ts', 'snapshot-updated'],
    ['src/lock.ts', 'lockfile'],
  ] as const)('%s is not %s', (file, kind) => {
    expect(kinds(hunk(file, ['+x']))).not.toContain(kind);
  });

  it('does not double-label CI files as config', () => {
    expect(kinds(hunk('.github/workflows/ci.yml', ['+x']))).not.toContain('config-changed');
  });

  it('flags pyproject [tool.*] sections', () => {
    const h = hunk('pyproject.toml', ['[tool.ruff]', '-line-length = 88', '+line-length = 200']);
    expect(find(h, 'config-changed')?.detail).toContain('ruff');
  });

  it('flags package.json scripts changes', () => {
    const h = hunk('package.json', ['  "scripts": {', '-    "test": "vitest run",', '+    "test": "echo ok",', '  },']);
    expect(find(h, 'config-changed')?.detail).toContain('scripts');
  });

  it('does not flag pyproject [project] metadata as config', () => {
    const h = hunk('pyproject.toml', ['[project]', '-version = "0.1.0"', '+version = "0.2.0"']);
    expect(kinds(h)).not.toContain('config-changed');
  });
});

// ---------------------------------------------------------------------------
// dependency-added
// ---------------------------------------------------------------------------

describe('dependency-added', () => {
  it.each([
    ['package.json deps', 'package.json', ['  "dependencies": {', '    "commander": "^15.0.0",', '+    "lodash": "^4.17.21",', '  },'], ['lodash']],
    ['package.json scoped devDeps', 'package.json', ['  "devDependencies": {', '+    "@types/lodash": "^4.17.0",', '  }'], ['@types/lodash']],
    ['package.json peer', 'package.json', ['  "peerDependencies": {', '+    "react": ">=18"', '  }'], ['react']],
    ['package.json unknown section, version-like', 'package.json', ['+    "zod": "^3.23.0",'], ['zod']],
    ['requirements.txt', 'requirements.txt', ['requests==2.32.0', '+httpx>=0.27', '+Flask[async]==3.0.0'], ['httpx', 'flask']],
    ['requirements-dev.txt', 'requirements-dev.txt', ['+pytest-cov'], ['pytest-cov']],
    ['pyproject PEP 621', 'pyproject.toml', ['dependencies = [', '    "requests>=2",', '+    "rich>=13",', ']'], ['rich']],
    ['pyproject inline array', 'pyproject.toml', ['-dependencies = ["requests>=2"]', '+dependencies = ["requests>=2", "pydantic>=2"]'], ['pydantic']],
    ['pyproject optional', 'pyproject.toml', ['[project.optional-dependencies]', 'dev = [', '+    "mypy>=1.10",', ']'], ['mypy']],
    ['pyproject poetry', 'pyproject.toml', ['[tool.poetry.dependencies]', 'python = "^3.11"', '+fastapi = "^0.115"'], ['fastapi']],
    ['go.mod block', 'go.mod', ['require (', '\tgithub.com/spf13/cobra v1.8.0', '+\tgithub.com/stretchr/testify v1.9.0', ')'], ['github.com/stretchr/testify']],
    ['go.mod single', 'go.mod', ['+require golang.org/x/sync v0.7.0'], ['golang.org/x/sync']],
    ['Cargo.toml', 'Cargo.toml', ['[dependencies]', 'serde = "1"', '+tokio = { version = "1", features = ["full"] }'], ['tokio']],
    ['Cargo.toml dev table', 'Cargo.toml', ['[dev-dependencies]', '+proptest = "1.4"'], ['proptest']],
    ['Cargo.toml dotted table', 'Cargo.toml', ['+[dependencies.reqwest]', '+version = "0.12"'], ['reqwest']],
    ['Gemfile', 'Gemfile', ["gem 'rails', '~> 7.1'", "+gem 'sidekiq'"], ['sidekiq']],
    ['composer.json', 'composer.json', ['    "require": {', '+        "guzzlehttp/guzzle": "^7.8",', '    }'], ['guzzlehttp/guzzle']],
  ])('%s', (_name, file, lines, names) => {
    const l = find(hunk(file, lines), 'dependency-added');
    expect(l?.severity).toBe('warn');
    for (const n of names) expect(l?.detail).toContain(n);
  });

  it.each([
    ['version bump (package.json)', 'package.json', ['  "dependencies": {', '-    "lodash": "^4.17.20",', '+    "lodash": "^4.17.21",', '  }']],
    ['version bump (requirements)', 'requirements.txt', ['-requests==2.31.0', '+requests==2.32.0']],
    ['version bump (go.mod)', 'go.mod', ['require (', '-\tgithub.com/spf13/cobra v1.8.0', '+\tgithub.com/spf13/cobra v1.8.1', ')']],
    ['package version field', 'package.json', ['-  "version": "0.1.0",', '+  "version": "0.2.0",']],
    ['package.json script', 'package.json', ['  "scripts": {', '+    "lint": "eslint .",', '  }']],
    ['package.json engines (unknown section)', 'package.json', ['+    "node": ">=20"']],
    ['requirements comment / include', 'requirements.txt', ['+# pinned for CI', '+-r base.txt']],
    ['pyproject keywords', 'pyproject.toml', ['[project]', 'keywords = [', '+    "cli",', ']']],
    ['pyproject classifiers', 'pyproject.toml', ['classifiers = [', '+    "License :: OSI Approved :: MIT License",', ']']],
    ['poetry python constraint', 'pyproject.toml', ['[tool.poetry.dependencies]', '-python = "^3.10"', '+python = "^3.11"']],
    ['Cargo package metadata', 'Cargo.toml', ['[package]', '-version = "0.1.0"', '+version = "0.2.0"']],
    ['go.mod go directive', 'go.mod', ['-go 1.21', '+go 1.22']],
    ['go.mod exclude block', 'go.mod', ['exclude (', '+\tgithub.com/bad/mod v1.0.0', ')']],
    ['lockfile is not a manifest', 'package-lock.json', ['+    "lodash": "^4.17.21",']],
  ])('ignores %s', (_name, file, lines) => {
    expect(kinds(hunk(file, lines))).not.toContain('dependency-added');
  });
});

// ---------------------------------------------------------------------------
// lint-suppressed
// ---------------------------------------------------------------------------

describe('lint-suppressed', () => {
  it.each([
    ['src/a.ts', '// eslint-disable-next-line no-console', 'eslint-disable-next-line'],
    ['src/a.ts', '/* eslint-disable */', 'eslint-disable'],
    ['src/a.tsx', '{/* eslint-disable-line react/no-danger */}', 'eslint-disable-line'],
    ['src/a.ts', '  // @ts-ignore', '@ts-ignore'],
    ['src/a.ts', '  // @ts-expect-error wrong types upstream', '@ts-expect-error'],
    ['src/a.ts', '// @ts-nocheck', '@ts-nocheck'],
    ['src/a.ts', '// biome-ignore lint/suspicious/noExplicitAny: legacy', 'biome-ignore'],
    ['src/a.ts', '/* istanbul ignore next */', 'istanbul ignore'],
    ['src/app.py', 'import os  # noqa: F401', '# noqa'],
    ['src/app.py', 'x = foo()  # type: ignore[attr-defined]', '# type: ignore'],
    ['src/app.py', 'def f():  # pylint: disable=too-many-branches', '# pylint: disable'],
    ['src/app.py', 'if DEBUG:  # pragma: no cover', '# pragma: no cover'],
    ['main.go', 'x := f() //nolint:errcheck', '//nolint'],
    ['src/lib.rs', '#[allow(dead_code)]', '#[allow(...)]'],
    ['src/lib.rs', '#![allow(clippy::all)]', '#[allow(...)]'],
    ['app/models/user.rb', 'def foo # rubocop:disable Metrics/AbcSize', 'rubocop:disable'],
    ['src/Foo.java', '@SuppressWarnings("unchecked")', '@SuppressWarnings'],
    ['src/Foo.cs', '#pragma warning disable CS0618', '#pragma warning disable'],
  ])('%s: %s', (file, line, name) => {
    const l = find(hunk(file, [`+${line}`]), 'lint-suppressed');
    expect(l?.severity).toBe('warn');
    expect(l?.detail).toContain(name);
  });

  it.each([
    ['string mentioning @ts-ignore', 'src/a.ts', 'log("never use // @ts-ignore here");'],
    ['docs quoting the directive', 'README.md', 'Add `// eslint-disable-next-line` to silence it.'],
    ['noqa as a word', 'src/app.py', 'noqa_count = 0'],
    ['#[allow( outside Rust', 'src/app.py', 'x = 1  #[allow(x)] is rust syntax'],
    ['@SuppressWarnings in TS', 'src/a.ts', '@SuppressWarnings("x")'],
    ['already-present directive moved', 'src/a.ts', ''],
  ])('ignores %s', (name, file, line) => {
    const lines = name.startsWith('already') ? ['-  // @ts-ignore', '+    // @ts-ignore'] : [`+${line}`];
    expect(kinds(hunk(file, lines))).not.toContain('lint-suppressed');
  });
});

// ---------------------------------------------------------------------------
// type-any-added
// ---------------------------------------------------------------------------

describe('type-any-added', () => {
  it.each([
    ['function f(x: any) {}', '`: any`'],
    ['const y = data as any;', '`as any`'],
    ['const z = <any>window;', '`<any>`'],
    ['let list: any[] = [];', '`any[]`'],
    ['const u = value as unknown as User;', '`as unknown as`'],
    ['const m: Record<string, any> = {};', 'type argument'],
    ['type T = string | any;', '`: any`'],
  ])('%s', (line, name) => {
    const l = find(hunk('src/a.ts', [`+${line}`]), 'type-any-added');
    expect(l?.severity).toBe('warn');
    expect(l?.detail).toContain(name);
  });

  it.each([
    ['JS file', 'src/a.js', 'function f(x /* : any */) {}'],
    ['Python file', 'src/a.py', 'def f(x: any): pass'],
    ['identifier containing any', 'src/a.ts', 'const company: Company = anyCompany;'],
    ['word in a string', 'src/a.ts', 'const s = "pass as any value";'],
    ['word in a comment', 'src/a.ts', 'const n = 1; // accepts any number'],
    ['Array.some (any-like)', 'src/a.ts', 'const hasAny = items.some(Boolean);'],
    ['moved line', 'src/a.ts', ''],
  ])('ignores %s', (name, file, line) => {
    const lines = name === 'moved line' ? ['-let x: any;', '+  let x: any;'] : [`+${line}`];
    expect(kinds(hunk(file, lines))).not.toContain('type-any-added');
  });
});

// ---------------------------------------------------------------------------
// secret-like
// ---------------------------------------------------------------------------

describe('secret-like', () => {
  // Built at runtime so this file does not trip secret scanners.
  const aws = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  const openai = ['sk-', 'proj-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'].join('');
  const gh = ['ghp_', 'a'.repeat(10), '1B2c3D4e5F6g7H8i9J0k1L2m3N4o'].join('');
  const slack = ['xoxb-', '1234567890-abcdefghij'].join('');
  const pem = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
  const hex = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const b64 = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u';

  it.each([
    ['AWS key', `const id = "${aws}";`, 'AWS access key', aws],
    ['sk- key', `OPENAI_API_KEY=${openai}`, 'sk-', openai],
    ['GitHub token', `token: ${gh}`, 'GitHub token', gh],
    ['Slack token', `const t = '${slack}';`, 'Slack token', slack],
    ['private key', pem, 'private key', pem],
    ['hex assigned to secret', `const apiSecret = "${hex}";`, 'apiSecret', hex],
    ['base64 assigned to password', `  "db_password": "${b64}",`, 'db_password', b64],
    ['dotenv token', `export SERVICE_TOKEN=${b64}`, 'SERVICE_TOKEN', b64],
  ])('%s', (_name, line, detail, secret) => {
    const l = find(hunk('src/config.ts', [`+${line}`]), 'secret-like');
    expect(l?.severity).toBe('risk');
    expect(l?.detail).toContain(detail);
    // The secret itself must never appear in the detail.
    expect(l?.detail).not.toContain(secret);
    expect(l?.detail).not.toContain(secret.slice(4, 20));
  });

  it.each([
    ['placeholder', 'const apiKey = "your-api-key-goes-here-please-1234";'],
    ['env lookup', 'const apiKey = process.env.OPENAI_API_KEY_FOR_PRODUCTION_USE;'],
    ['short password', 'const password = "hunter2";'],
    ['low entropy', `const token = "${'a1'.repeat(20)}";`],
    ['long camelCase identifier value', 'const authProvider = createAuthProviderFromEnvironment2024();'],
    ['hash not assigned to a secret name', `const checksum = "${hex}";`],
    ['integrity in lockfile', `"integrity": "sha512-${b64}"`],
    ['template interpolation', 'const token = `${prefix}${suffixWithAVeryLongName123456}`;'],
  ])('ignores %s', (_name, line) => {
    const file = _name.includes('lockfile') ? 'package-lock.json' : 'src/config.ts';
    expect(kinds(hunk(file, [`+${line}`]))).not.toContain('secret-like');
  });
});

// ---------------------------------------------------------------------------
// out-of-scope
// ---------------------------------------------------------------------------

describe('out-of-scope', () => {
  const work = [
    hunk('src/parser/lexer.ts', ['+a']),
    hunk('src/parser/tokens.ts', ['+b']),
    hunk('src/parser/ast/nodes.ts', ['+c']),
  ];

  function run(extra: AttributedHunk, text: string): Label | undefined {
    const out = labelHunks([...work, extra], { repoRoot: '/repo', prompts: [prompt(text)] });
    return out.at(-1)?.labels.find((l) => l.kind === 'out-of-scope');
  }

  it('flags an unmentioned file away from the rest of the work', () => {
    const l = run(hunk('src/billing/invoice.ts', ['+x']), 'Fix the lexer bug with string tokens');
    expect(l?.severity).toBe('warn');
    expect(l?.detail).toContain('src/billing/');
  });

  it.each([
    ['basename mentioned', 'Fix the lexer and update invoice.ts too'],
    ['stem mentioned', 'Also clean up the invoice code'],
    ['directory mentioned', 'Something is off in billing as well'],
    ['case-insensitive', 'And the INVOICE thing'],
  ])('does not flag when %s', (_name, text) => {
    expect(run(hunk('src/billing/invoice.ts', ['+x']), text)).toBeUndefined();
  });

  it('does not count a substring of a longer word as a mention', () => {
    expect(run(hunk('src/billing/invoice.ts', ['+x']), 'Fix invoices2 in the lexer')).toBeDefined();
  });

  it('does not flag files near the agent work', () => {
    expect(run(hunk('src/parser/ast/visit.ts', ['+x']), 'Fix the lexer')).toBeUndefined();
  });

  it('does not flag human hunks', () => {
    expect(run(hunk('src/billing/invoice.ts', ['+x'], { agent: false }), 'Fix the lexer')).toBeUndefined();
  });

  it('does not flag lockfiles or snapshots', () => {
    expect(run(hunk('package-lock.json', ['+x']), 'Fix the lexer')).toBeUndefined();
    expect(run(hunk('web/__snapshots__/a.snap', ['+x']), 'Fix the lexer')).toBeUndefined();
  });

  it('does nothing without prompts', () => {
    const out = labelHunks([...work, hunk('src/billing/invoice.ts', ['+x'])], { repoRoot: '/repo', prompts: [] });
    expect(out.at(-1)?.labels.map((l) => l.kind)).not.toContain('out-of-scope');
  });

  it('does nothing when the agent touched a single file', () => {
    const out = labelHunks([hunk('src/billing/invoice.ts', ['+x'])], { repoRoot: '/repo', prompts: [prompt('Fix the lexer')] });
    expect(out[0]?.labels).toEqual([]);
  });

  it('does not flag files the agent created in the same prompt, or siblings of them', () => {
    const hs: AttributedHunk[] = [];
    const prompts: Prompt[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `s1:${i}`;
      prompts.push({ ...prompt(`build module m${i}`), id, index: i });
      for (const f of ['index', 'util', 'types']) {
        const h = hunk(`src/m${i}/${f}.ts`, ['+x']);
        h.hunk.status = 'added';
        h.edits = h.edits.map((e) => ({ ...e, kind: 'write', tool: 'Write', promptId: id }));
        h.prompt = prompts[i];
        hs.push(h);
      }
    }
    const out = labelHunks(hs, { repoRoot: '/repo', prompts });
    expect(out.flatMap((h) => h.labels).filter((l) => l.kind === 'out-of-scope')).toEqual([]);
  });

  it('does not flag an edit next to a file the same prompt mentions', () => {
    const a = hunk('src/cart.js', ['+x']);
    const b = hunk('src/checkout.js', ['+y']);
    const far = hunk('lib/other/x.ts', ['+z']);
    const out = labelHunks([a, b, far, hunk('docs/guide/readme.md', ['+q'])], { repoRoot: '/repo', prompts: [prompt('fix src/cart.js')] });
    expect(out[1]?.labels.map((l) => l.kind)).not.toContain('out-of-scope');
    expect(out[2]?.labels.map((l) => l.kind)).toContain('out-of-scope');
  });

  const written = (file: string): AttributedHunk => {
    const h = hunk(file, ['+x']);
    h.hunk.status = 'added';
    h.edits = h.edits.map((e) => ({ ...e, kind: 'write', tool: 'Write' }));
    return h;
  };
  const flagged = (h: AttributedHunk | undefined): boolean => !!h?.labels.some((l) => l.kind === 'out-of-scope');

  it('flags files the agent creates in unrelated areas while working on src/cart.js', () => {
    const out = labelHunks([hunk('src/cart.js', ['+x']), written('infra/terraform/main.tf')], { repoRoot: '/repo', prompts: [prompt('fix src/cart.js')] });
    expect(flagged(out[1])).toBe(true);
    const two = labelHunks(
      [hunk('src/cart.js', ['+x']), written('infra/terraform/main.tf'), hunk('infra/terraform/other.tf', ['+y'])],
      { repoRoot: '/repo', prompts: [prompt('fix src/cart.js')] },
    );
    expect(flagged(two[1])).toBe(true);
    expect(flagged(two[2])).toBe(true);
    const ci = labelHunks([hunk('src/cart.js', ['+x']), written('.github/workflows/deploy.yml')], { repoRoot: '/repo', prompts: [prompt('fix src/cart.js')] });
    expect(flagged(ci[1])).toBe(true);
  });

  it('wandering files do not vouch for each other under an anchored prompt', () => {
    const p = [prompt('fix src/cart.js')];
    const three = labelHunks([hunk('src/cart.js', ['+x']), hunk('infra/a.tf', ['+1']), hunk('infra/b.tf', ['+2']), hunk('infra/c.tf', ['+3'])], { repoRoot: '/repo', prompts: p });
    expect(three.slice(1).map(flagged)).toEqual([true, true, true]);
    const two = labelHunks([hunk('src/cart.js', ['+x']), hunk('infra/a.tf', ['+1']), hunk('infra/b.tf', ['+2'])], { repoRoot: '/repo', prompts: p });
    expect(two.slice(1).map(flagged)).toEqual([true, true]);
    expect(flagged(three[0])).toBe(false);
  });

  it('does not treat URLs in a prompt as paths', () => {
    const out = labelHunks([hunk('src/cart.js', ['+x']), hunk('ab/cd/ref.md', ['+y'])], {
      repoRoot: '/repo',
      prompts: [prompt('fix src/cart.js, see https://example.com/ab/cd/z and example.com/ab/cd/y')],
    });
    expect(flagged(out[1])).toBe(true);
  });

  it('still flags an unrelated infra file when the prompt is about src/cart.js', () => {
    const out = labelHunks([hunk('src/cart.js', ['+x']), hunk('src/totals.js', ['+x']), hunk('infra/terraform/main.tf', ['+y'])], {
      repoRoot: '/repo',
      prompts: [prompt('fix the cart in src/cart.js')],
    });
    expect(out[2]?.labels.map((l) => l.kind)).toContain('out-of-scope');
  });

  it('treats the repo root as unrelated to subdirectories', () => {
    const l = run(hunk('Makefile', ['+x']), 'Fix the lexer');
    expect(l?.detail).toContain('repo root');
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('combined', () => {
  it('stacks several labels on one tampered test hunk', () => {
    const h = hunk('src/cart.test.ts', [
      '   it("totals", () => {',
      '-    expect(total(cart)).toBe(30);',
      '+    // @ts-ignore',
      '+    expect(total(cart as any)).toBeDefined();',
      '   });',
      '+  it.skip("discounts", () => {});',
    ]);
    expect(kinds(h).sort()).toEqual(
      ['assertion-removed', 'lint-suppressed', 'test-modified', 'test-skip-added', 'type-any-added'].sort(),
    );
  });

  it('labels a clean source edit with nothing', () => {
    expect(kinds(hunk('src/cart.ts', ['-  return a + b;', '+  return a + b + shipping;']))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tests-disabled
// ---------------------------------------------------------------------------

describe('tests-disabled', () => {
  const flagged: Array<[string, string, string[]]> = [
    ['vitest test.exclude entry', 'vitest.config.ts', [' export default defineConfig({', '   test: {', "+    exclude: ['src/**/*.test.ts'],", '   },']],
    ['vitest test.exclude array item', 'vitest.config.ts', ['   test: {', "     exclude: [", "+      'test/flaky.test.ts',", '     ],']],
    ['vitest exclude of a tests dir', 'vite.config.ts', ['   test: {', "+    exclude: [...configDefaults.exclude, 'tests/**'],"]],
    ['vitest broad glob', 'vitest.config.ts', ['   test: {', "+    exclude: ['**/*'],"]],
    ['jest testPathIgnorePatterns', 'jest.config.js', ["+  testPathIgnorePatterns: ['/integration/'],"]],
    ['jest modulePathIgnorePatterns on specs', 'jest.config.js', ["+  modulePathIgnorePatterns: ['<rootDir>/spec/'],"]],
    ['package.json jest ignore', 'package.json', [' "jest": {', '+  "testPathIgnorePatterns": ["/api/"]', ' }']],
    ['test script passWithNoTests', 'package.json', [' "scripts": {', '-  "test": "vitest run",', '+  "test": "vitest run --passWithNoTests",', ' }']],
    ['test script || true', 'package.json', [' "scripts": {', '-  "test": "vitest run",', '+  "test": "vitest run || true",', ' }']],
    ['test script || exit 0', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "jest || exit 0",', ' }']],
    ['test script || echo', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "jest || echo skipped",', ' }']],
    ['test script || :', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "jest || :",', ' }']],
    ['test script exit 0', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "exit 0",', ' }']],
    ['test script true', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "true",', ' }']],
    ['test script :', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": ":",', ' }']],
    ['test script echo', 'package.json', [' "scripts": {', '-  "test": "jest",', '+  "test": "echo no tests",', ' }']],
    ['test script loses its runner', 'package.json', [' "scripts": {', '-  "test": "vitest run",', '+  "test": "node scripts/noop.js",', ' }']],
    ['pytest -k not', 'pytest.ini', [' [pytest]', '-addopts = -q', '+addopts = -q -k "not slow"']],
    ['pytest --deselect', 'pyproject.toml', ['[tool.pytest.ini_options]', '-addopts = "-q"', '+addopts = "-q --deselect tests/test_a.py::test_x"']],
    ['pytest --ignore', 'setup.cfg', ['[tool:pytest]', '-addopts = -q', '+addopts = -q --ignore=tests/integration']],
    ['pytest multi-line addopts', 'pytest.ini', [' [pytest]', ' addopts =', '+    -k "not network"', ' testpaths = tests']],
    ['pytest array addopts', 'pyproject.toml', ['[tool.pytest.ini_options]', ' addopts = [', '+  "--deselect=tests/test_a.py",', ' ]']],
    ['tox pytest --ignore tests', 'tox.ini', [' [testenv]', '-commands = pytest', '+commands = pytest --ignore=tests/slow']],
    ['CI continue-on-error on test step', '.github/workflows/ci.yml', [' steps:', '   - name: Run tests', '     run: npm test', '+    continue-on-error: true']],
    ['CI || true after test', '.github/workflows/ci.yml', ['   - name: Run tests', '-    run: npm test', '+    run: npm test || true']],
    ['CI pytest || true', '.github/workflows/ci.yml', ['   - name: Run tests', '-    run: pytest -q', '+    run: pytest -q || true']],
  ];

  it.each(flagged)('flags %s', (_name, file, lines) => {
    expect(find(hunk(file, lines), 'tests-disabled')?.severity).toBe('risk');
  });

  it.each([
    ['exclude node_modules', 'vitest.config.ts', ['   test: {', "+    exclude: ['node_modules', 'dist'],"]],
    ['exclude dist item', 'vitest.config.ts', ['   test: {', '     exclude: [', "+      '**/dist/**',", '     ],']],
    ['coverage.exclude with tests', 'vitest.config.ts', ['   test: {', '     coverage: {', "+      exclude: ['**/*.test.ts', 'tests/**'],", '     },']],
    ['optimizeDeps.exclude', 'vite.config.ts', ['   optimizeDeps: {', "+    exclude: ['some-dep'],", '   },']],
    ['exclude outside the test block', 'vite.config.ts', ['   build: {', "+    exclude: ['tests/**'],"]],
    ['nyc exclude in package.json', 'package.json', [' "nyc": {', '+  "exclude": ["**/*.test.js", "test/**"]', ' }']],
    ['configDefaults plus e2e', 'vitest.config.ts', ['   test: {', "+    exclude: [...configDefaults.exclude, 'e2e/**'],"]],
    ['exclude fixtures', 'vitest.config.ts', ['   test: {', "+    exclude: ['**/fixtures/**', '**/__mocks__/**'],"]],
    ['exclude d.ts and stories', 'vitest.config.ts', ['   test: {', "+    exclude: ['**/*.d.ts', '**/*.stories.tsx', 'src/generated/**'],"]],
    ['jest ignore build', 'jest.config.js', ["+  testPathIgnorePatterns: ['/node_modules/', '/build/'],"]],
    ['jest ignore fixtures', 'jest.config.js', ["+  testPathIgnorePatterns: ['/fixtures/'],"]],
    ['pytest ignore build', 'pytest.ini', [' [pytest]', '+addopts = --ignore=build']],
    ['-k not outside addopts', 'pyproject.toml', ['[tool.mytool]', '+description = "run with -k not slow"']],
    ['tox pytest --ignore docs', 'tox.ini', [' [testenv]', '+commands = pytest --ignore=docs']],
    ['CI continue-on-error on non-test step', '.github/workflows/ci.yml', ['   - name: Upload coverage', '     uses: codecov/codecov-action@v4', '+    continue-on-error: true']],
    ['CI continue-on-error on upload test results', '.github/workflows/ci.yml', ['   - name: Upload test results', '     uses: actions/upload-artifact@v4', '+    continue-on-error: true']],
    ['CI mkdir test-results || true', '.github/workflows/ci.yml', ['   - name: Prepare', '+    run: mkdir test-results || true']],
    ['CI continue-on-error in the next job', '.github/workflows/ci.yml', ['   - name: Run tests', '     run: npm test', ' lint:', '   steps:', '     - uses: x/y@v1', '+      continue-on-error: true']],
    ['unrelated exclude in webpack', 'webpack.config.js', ["+  exclude: ['src/legacy'],"]],
    ['removing an exclude', 'vitest.config.ts', ['   test: {', "-    exclude: ['src/**/*.test.ts'],"]],
    ['removing --passWithNoTests', 'package.json', [' "scripts": {', '-  "test": "vitest run --passWithNoTests",', '+  "test": "vitest run",', ' }']],
    ['plain test script edit', 'package.json', [' "scripts": {', '-  "test": "vitest run",', '+  "test": "vitest run --coverage",', ' }']],
    ['CI continue-on-error: false', '.github/workflows/ci.yml', ['   - name: Run tests', '     run: npm test', '+    continue-on-error: false']],
  ])('does not flag %s', (_name, file, lines) => {
    expect(kinds(hunk(file, lines))).not.toContain('tests-disabled');
  });

  function renameHunk(from: string, to: string, status: 'renamed' | 'deleted', lines: string[] = []): AttributedHunk {
    const h = hunk(status === 'deleted' ? from : to, lines);
    h.hunk = { ...h.hunk, status, ...(status === 'renamed' ? { oldFile: from } : {}) };
    return h;
  }

  it.each([
    ['test/a.test.js', 'test/a.test.js.disabled'],
    ['pkg/a_test.go', 'pkg/a_test.go.txt'],
    ['test/a.test.js', 'test/a.test.js.skip'],
    ['test/a.test.js', 'test/a.test.js.bak'],
    ['test/a.test.js', 'test/a.test.js~'],
    ['test/a.test.js', 'test/a.js'],
    ['src/a.spec.ts', 'src/a.ts'],
  ])('flags renaming %s to %s', (from, to) => {
    expect(find(renameHunk(from, to, 'renamed'), 'tests-disabled')?.severity).toBe('risk');
  });

  it.each([
    ['test/a.test.js', 'test/b.test.js'],
    ['test/a.test.js', 'test/unit/a.test.js'],
    ['test/a.test.js', 'test/a.test.js.snap'],
    ['test/a.test.js', 'test/a.test.js.map'],
    ['tests/foo.js', 'lib/foo.js'],
    ['src/a.ts', 'src/b.ts'],
  ])('does not flag renaming %s to %s', (from, to) => {
    expect(kinds(renameHunk(from, to, 'renamed'))).not.toContain('tests-disabled');
  });

  it('flags deleting a test file next to test-modified', () => {
    const h = renameHunk('test/a.test.js', '', 'deleted', ['-it("works", () => {})']);
    expect(kinds(h)).toEqual(expect.arrayContaining(['tests-disabled', 'test-modified']));
  });

  it('does not flag deleting a non-test file', () => {
    expect(kinds(renameHunk('src/a.ts', '', 'deleted', ['-x']))).not.toContain('tests-disabled');
  });

  it('does not flag deleting a test whose source file is deleted in the same diff', () => {
    const test = renameHunk('test/a.test.js', '', 'deleted', ['-it("x", () => {})']);
    const src = renameHunk('src/a.js', '', 'deleted', ['-export const a = 1']);
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).toContain('test-modified');
    expect(t?.labels.map((l) => l.kind)).not.toContain('tests-disabled');
  });

  it('does not flag deleting a test whose source file is renamed away in the same diff', () => {
    const test = renameHunk('pkg/a_test.go', '', 'deleted', ['-func TestA() {}']);
    const src = renameHunk('pkg/a.go', 'pkg/b.go', 'renamed');
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).not.toContain('tests-disabled');
  });

  it('Python: a top-level test pairs only with a single same-stem source under a source-like root', () => {
    const labelsOf = (testPath: string, ...srcs: string[]): LabelKind[] => {
      const test = renameHunk(testPath, '', 'deleted', ['-def test_x(): pass']);
      const gone = srcs.map((p) => renameHunk(p, '', 'deleted', ['-x = 1']));
      return labelHunks([test, ...gone], ctx)[0]?.labels.map((l) => l.kind) ?? [];
    };
    expect(labelsOf('tests/test_foo.py', 'src/pkg/foo.py')).not.toContain('tests-disabled');
    expect(labelsOf('tests/test_foo.py', 'foo.py')).not.toContain('tests-disabled');
    expect(labelsOf('tests/test_foo.py', 'scripts/old/foo.py', 'src/pkg/foo.py')).toContain('tests-disabled');
    expect(labelsOf('tests/test_foo.py', 'tools/foo.py')).toContain('tests-disabled');
  });

  it.each([
    ['test/index.test.js', 'x/index.js'],
    ['src/test/java/com/a/FooTest.java', 'src/main/java/com/b/Foo.java'],
    ['test/a/x.test.js', 'src/b/x.js'],
  ])('still flags deleting %s with a same-stem source in an unrelated directory %s', (testPath, srcPath) => {
    const test = renameHunk(testPath, '', 'deleted', ['-it("x", () => {})']);
    const src = renameHunk(srcPath, '', 'deleted', ['-export const x = 1']);
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).toContain('tests-disabled');
  });

  it('still flags deleting a test when a same-stem source file in an unrelated directory is deleted', () => {
    const test = renameHunk('test/index.test.js', '', 'deleted', ['-it("x", () => {})']);
    const src = renameHunk('x/index.js', '', 'deleted', ['-export const x = 1']);
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).toContain('tests-disabled');
  });

  it.each([
    ['src/test/java/com/a/FooTest.java', 'src/main/java/com/a/Foo.java'],
    ['src/test/kotlin/com/a/FooTest.kt', 'src/main/kotlin/com/a/Foo.kt'],
    ['tests/test_foo.py', 'src/pkg/foo.py'],
    ['tests/test_foo.py', 'foo.py'],
    ['tests/test_foo.py', 'pkg/foo.py'],
    ['tests/foo_test.py', 'pkg/foo.py'],
    ['app/test/x.test.ts', 'app/src/x.ts'],
    ['__tests__/x.test.js', 'x.js'],
    ['src/__tests__/x.test.js', 'src/x.js'],
    ['test/util/x.test.js', 'src/util/x.js'],
    ['packages/p/test/x.test.ts', 'packages/p/src/x.ts'],
    ['pkg/x_test.go', 'pkg/x.go'],
  ])('does not flag deleting %s together with its source %s', (testPath, srcPath) => {
    const test = renameHunk(testPath, '', 'deleted', ['-it("x", () => {})']);
    const src = renameHunk(srcPath, '', 'deleted', ['-export const x = 1']);
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).not.toContain('tests-disabled');
  });

  it('still flags deleting a test when an unrelated source file is deleted', () => {
    const test = renameHunk('test/a.test.js', '', 'deleted', ['-it("x", () => {})']);
    const src = renameHunk('src/other.js', '', 'deleted', ['-x']);
    const [t] = labelHunks([test, src], ctx);
    expect(t?.labels.map((l) => l.kind)).toContain('tests-disabled');
  });
});

describe('tests-disabled with the full post-image (fileText)', () => {
  /** Hunk whose lines carry real new-file line numbers, starting at `startNew`. */
  function hunkAt(file: string, startNew: number, lines: string[]): AttributedHunk {
    const h = hunk(file, []);
    let n = startNew;
    h.hunk = {
      ...h.hunk,
      newStart: startNew,
      lines: lines.map((raw) => {
        const sign = raw.charAt(0);
        const text = raw.slice(1);
        return sign === '+' ? { type: 'add' as const, text, newNo: n++ } : { type: 'ctx' as const, text, oldNo: n, newNo: n++ };
      }),
    };
    return h;
  }
  const kindsWith = (h: AttributedHunk, files: Record<string, string>): LabelKind[] =>
    labelHunks([h], { ...ctx, fileText: (p) => files[p] })[0]?.labels.map((l) => l.kind) ?? [];

  const vitest = (scope: string): string => [
    "import { defineConfig } from 'vitest/config';", //1
    'export default defineConfig({', //2
    `  ${scope}: {`, //3
    "    environment: 'node',", //4
    '    globals: true,', //5
    "    include: ['src/**/*.ts'],", //6
    "    setupFiles: ['./setup.ts'],", //7
    '    retry: 1,', //8
    "    exclude: ['**/*.test.ts'],", //9
    "    reporters: ['default'],", //10
    '    testTimeout: 5000,', //11
    '    hookTimeout: 5000,', //12
    '  },', //13
    '});', //14
  ].join('\n');
  const vitestHunk = (): AttributedHunk => hunkAt('vitest.config.ts', 6, [
    "     include: ['src/**/*.ts'],", "     setupFiles: ['./setup.ts'],", '     retry: 1,',
    "+    exclude: ['**/*.test.ts'],",
    "     reporters: ['default'],", '     testTimeout: 5000,', '     hookTimeout: 5000,',
  ].map((l) => (l.startsWith('+') ? l : l)));

  it('flags a test.exclude whose test: key is outside the hunk', () => {
    expect(kindsWith(vitestHunk(), { 'vitest.config.ts': vitest('test') })).toContain('tests-disabled');
  });

  it('does not flag the same shape under coverage', () => {
    expect(kindsWith(vitestHunk(), { 'vitest.config.ts': vitest('coverage') })).not.toContain('tests-disabled');
  });

  it('stays quiet without fileText (hunk only)', () => {
    expect(kinds(vitestHunk())).not.toContain('tests-disabled');
  });

  it('falls back to the hunk when the file text does not match the hunk', () => {
    expect(kindsWith(vitestHunk(), { 'vitest.config.ts': 'export default {};' })).not.toContain('tests-disabled');
  });

  it('flags pytest addopts when the hunk starts mid-continuation', () => {
    const text = ['[pytest]', 'testpaths = tests', 'addopts =', '    -q', '    --strict-markers', '    -k "not network"', '    --tb=short', 'markers =', '    slow'].join('\n');
    const h = hunkAt('pytest.ini', 4, ['     -q', '     --strict-markers', '+    -k "not network"', '     --tb=short', ' markers =']);
    expect(kindsWith(h, { 'pytest.ini': text })).toContain('tests-disabled');
    expect(kinds(h)).not.toContain('tests-disabled');
  });

  it('a nested `- key:` list inside a step does not start a new step (hunk starts mid-step)', () => {
    const h = hunkAt('.github/workflows/ci.yml', 6, [
      '        run: npm test',
      '        strategy:',
      '          matrix:',
      '            include:',
      '              - os: linux',
      '              - os: macos',
      '+        continue-on-error: true',
    ]);
    expect(kinds(h)).toContain('tests-disabled');
  });

  it('a nested `- key:` list under with: does not end the step (whole step in the hunk)', () => {
    const h = hunkAt('.github/workflows/ci.yml', 4, [
      '      - name: Test',
      '        run: npm test',
      '        with:',
      '          matrix:',
      '            - node: 20',
      '+        continue-on-error: true',
    ]);
    expect(kinds(h)).toContain('tests-disabled');
  });

  it('a real next step after a mid-step hunk start still ends the test step', () => {
    const h = hunkAt('.github/workflows/ci.yml', 6, [
      '        run: npm test',
      '      - name: Upload',
      '        uses: actions/upload-artifact@v4',
      '+        continue-on-error: true',
    ]);
    expect(kinds(h)).not.toContain('tests-disabled');
  });

  it('bounds a CI step to its job using the full file', () => {
    const text = ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v4', '      - name: Run', '        run: npm test', '        env:', '          A: 1', '          B: 2', '        continue-on-error: true'].join('\n');
    const h = hunkAt('.github/workflows/ci.yml', 8, ['           A: 1', '           B: 2', '+        continue-on-error: true']);
    expect(kindsWith(h, { '.github/workflows/ci.yml': text })).toContain('tests-disabled');
  });
});


describe('out-of-scope performance', () => {
  /** 20 prompts: one wanders over `wide` files, the other 19 touch one file each. */
  function diff(wide: number): { prompts: Prompt[]; hunks: AttributedHunk[] } {
    const prompts: Prompt[] = [];
    const hunks: AttributedHunk[] = [];
    for (let p = 0; p < 20; p++) {
      const id = `s1:${p}`;
      prompts.push({ id, sessionId: 's1', harness: 'claude-code', index: p, at: '2026-10-31T09:59:00Z', text: `work on module${p} in the repository` });
      for (let f = 0; f < (p === 0 ? wide : 1); f++) {
        const h = hunk(`pkg${p}/dir${f}/file${f}.ts`, ['+export const x = 1;']);
        h.prompt = prompts[p];
        h.edits = [{ ...h.edits[0]!, promptId: id }];
        hunks.push(h);
      }
    }
    return { prompts, hunks };
  }

  it('labels a 1000-file, 20-prompt diff well within a ceiling and scales sub-quadratically', () => {
    const small = diff(231); // 250 hunks
    const large = diff(981); // 1000 hunks
    expect(labelHunks(large.hunks, { prompts: large.prompts, repoRoot: '/repo' })).toHaveLength(1000);
    expect(bestOf(() => labelHunks(large.hunks, { prompts: large.prompts, repoRoot: '/repo' }), 3)).toBeLessThan(5000);
    expectScalesSubQuadratically(
      () => labelHunks(small.hunks, { prompts: small.prompts, repoRoot: '/repo' }),
      () => labelHunks(large.hunks, { prompts: large.prompts, repoRoot: '/repo' }),
    );
  });
});

describe('prompt text performance (pasted blobs)', () => {
  const blobs: Array<[string, (n: number) => string]> = [
    ['one long word run', (n) => 'a'.repeat(n)],
    ['a dotted run', (n) => 'a.'.repeat(n / 2)],
    ['a word run ending in a slash', (n) => `${'a'.repeat(n - 1)}/`],
    ['a scheme-like run', (n) => `${'a'.repeat(n - 3)}:/x`],
  ];
  for (const [name, blob] of blobs) {
    it(`labels a 200 KB prompt made of ${name} in linear time`, () => {
      const run = (n: number) => () => labelHunks([hunk('src/x.ts', ['+export const x = 1;'])], { prompts: [prompt(blob(n))], repoRoot: '/repo' });
      expect(bestOf(run(200_000), 3)).toBeLessThan(1000);
      expectScalesSubQuadratically(run(50_000), run(200_000));
    });
  }

  it('still reads path tokens and file mentions from an ordinary prompt', () => {
    const h = hunk('src/cart/total.ts', ['+export const x = 1;']);
    expect(kinds(h)).not.toContain('out-of-scope');
    expect(labelsOf(h, [prompt('please fix src/cart/total.ts')]).map((l) => l.kind)).not.toContain('out-of-scope');
  });
});
