import { describe, expect, it } from 'vitest';

import { countLines, groupByFile, parseUnifiedDiff, splitDiffGitPaths, unquotePath } from '../src/diff-parse.js';

const MODIFIED = `diff --git a/src/cart.ts b/src/cart.ts
index 3b18e51..9c2f0a1 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,3 +1,5 @@
+import { formatPrice } from './format.js';
+
 export interface CartItem {
   name: string;
   price: number;
@@ -7,7 +9,7 @@ export interface CartItem {
 export function cartTotal(items: CartItem[]): string {
   let total = 0;
   for (const item of items) {
-    total += item.price;
+    total += item.price * item.qty;
   }
-  return total;
+  return formatPrice(total);
 }
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file into hunks with ids, headers and line numbers', () => {
    const hunks = parseUnifiedDiff(MODIFIED);
    expect(hunks.map((h) => h.id)).toEqual(['h1', 'h2']);
    expect(hunks[0]).toMatchObject({ file: 'src/cart.ts', status: 'modified', oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 });
    expect(hunks[0]?.oldFile).toBeUndefined();
    expect(hunks[0]?.header).toBe('@@ -1,3 +1,5 @@');
    expect(hunks[1]?.header).toBe('@@ -7,7 +9,7 @@ export interface CartItem {');

    const first = hunks[0]?.lines ?? [];
    expect(first[0]).toEqual({ type: 'add', text: "import { formatPrice } from './format.js';", newNo: 1 });
    expect(first[1]).toEqual({ type: 'add', text: '', newNo: 2 });
    expect(first[2]).toEqual({ type: 'ctx', text: 'export interface CartItem {', oldNo: 1, newNo: 3 });

    const second = hunks[1]?.lines ?? [];
    expect(second.find((l) => l.type === 'del')).toEqual({ type: 'del', text: '    total += item.price;', oldNo: 10 });
    expect(second.filter((l) => l.type === 'add').map((l) => l.newNo)).toEqual([12, 14]);
    expect(countLines(hunks[1]!)).toEqual({ added: 2, removed: 2 });
  });

  it('parses added and deleted files', () => {
    const diff = `diff --git a/src/format.ts b/src/format.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/format.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function legacyTotal(prices: number[]): number {
-  return prices.reduce((a, b) => a + b, 0);
-}
`;
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ file: 'src/format.ts', status: 'added', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(hunks[0]?.lines.map((l) => l.newNo)).toEqual([1, 2]);
    expect(hunks[1]).toMatchObject({ file: 'src/legacy.ts', status: 'deleted', oldLines: 3, newLines: 0 });
    expect(hunks[1]?.lines.every((l) => l.type === 'del')).toBe(true);
    expect(hunks[1]?.lines.map((l) => l.oldNo)).toEqual([1, 2, 3]);
  });

  it('handles renames with and without content changes, keeping oldFile', () => {
    const diff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/lib/a.ts b/lib/b.ts
similarity index 90%
rename from lib/a.ts
rename to lib/b.ts
index 1111111..2222222 100644
--- a/lib/a.ts
+++ b/lib/b.ts
@@ -1,2 +1,2 @@
-export const name = 'a';
+export const name = 'b';
 export const two = 2;
`;
    const hunks = parseUnifiedDiff(diff);
    // A pure rename has no hunks (nothing to attribute); the changed rename has one.
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ file: 'lib/b.ts', oldFile: 'lib/a.ts', status: 'renamed' });
  });

  it('skips binary files and emits an empty hunk for mode-only changes', () => {
    const diff = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..89abcde
Binary files /dev/null and b/logo.png differ
diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
diff --git a/src/x.ts b/src/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-a
+b
`;
    const hunks = parseUnifiedDiff(diff);
    expect(hunks.map((h) => h.file)).toEqual(['scripts/run.sh', 'src/x.ts']);
    expect(hunks[0]).toMatchObject({ header: 'mode change 100644 => 100755', lines: [] });
    expect(hunks[1]?.id).toBe('h2');
  });

  it('understands "\\ No newline at end of file" and hunk headers without counts', () => {
    const diff = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-hello
\\ No newline at end of file
+hello world
\\ No newline at end of file
diff --git a/b.txt b/b.txt
index 1..2 100644
--- a/b.txt
+++ b/b.txt
@@ -4,0 +5,2 @@ context
+inserted one
+inserted two
`;
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines).toEqual([
      { type: 'del', text: 'hello', oldNo: 1 },
      { type: 'add', text: 'hello world', newNo: 1 },
    ]);
    // --unified=0 insertion: numbering starts at newStart.
    expect(hunks[1]).toMatchObject({ oldStart: 4, oldLines: 0, newStart: 5, newLines: 2 });
    expect(hunks[1]?.lines.map((l) => l.newNo)).toEqual([5, 6]);
  });

  it('does not mistake removed lines that look like headers for file boundaries', () => {
    const diff = `diff --git a/notes.md b/notes.md
index 1..2 100644
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,3 @@
--- a/this is a removed markdown line
-++ b/and another
+diff --git a/not a header b/either
 context
`;
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(['del', 'del', 'add', 'ctx']);
    expect(hunks[0]?.lines[2]?.text).toBe('diff --git a/not a header b/either');
  });

  it('decodes quoted paths and paths with spaces', () => {
    const diff = `diff --git "a/docs/caf\\303\\251 menu.md" "b/docs/caf\\303\\251 menu.md"
index 1..2 100644
--- "a/docs/caf\\303\\251 menu.md"
+++ "b/docs/caf\\303\\251 menu.md"
@@ -1 +1 @@
-old
+new
diff --git a/docs/my notes.md b/docs/my notes.md
index 1..2 100644
--- a/docs/my notes.md\t
+++ b/docs/my notes.md\t
@@ -1 +1 @@
-x
+y
`;
    const hunks = parseUnifiedDiff(diff);
    expect(hunks.map((h) => h.file)).toEqual(['docs/café menu.md', 'docs/my notes.md']);
  });

  it('handles --no-prefix diffs and an empty input', () => {
    const diff = `diff --git src/a.ts src/a.ts
index 1..2 100644
--- src/a.ts
+++ src/a.ts
@@ -1 +1 @@
-1
+2
`;
    expect(parseUnifiedDiff(diff)[0]?.file).toBe('src/a.ts');
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n')).toEqual([]);
  });

  it('treats a stripped empty context line as context', () => {
    const diff = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one

-three
+THREE
`;
    const lines = parseUnifiedDiff(diff)[0]?.lines ?? [];
    expect(lines.map((l) => l.type)).toEqual(['ctx', 'ctx', 'del', 'add']);
    expect(lines[1]).toEqual({ type: 'ctx', text: '', oldNo: 2, newNo: 2 });
  });

  it('groups hunks by file in first-appearance order', () => {
    const hunks = parseUnifiedDiff(MODIFIED);
    const grouped = groupByFile(hunks);
    expect([...grouped.keys()]).toEqual(['src/cart.ts']);
    expect(grouped.get('src/cart.ts')).toHaveLength(2);
  });
});

describe('path helpers', () => {
  it('unquotes git C-style escapes', () => {
    expect(unquotePath('"a/caf\\303\\251.ts"')).toBe('a/café.ts');
    expect(unquotePath('"with \\"quotes\\" and\\ttab"')).toBe('with "quotes" and\ttab');
    expect(unquotePath('plain/path.ts')).toBe('plain/path.ts');
    expect(unquotePath('a/b c.ts\t')).toBe('a/b c.ts');
  });

  it('splits diff --git header paths, including spaces and renames', () => {
    expect(splitDiffGitPaths('a/src/x.ts b/src/x.ts')).toEqual(['src/x.ts', 'src/x.ts']);
    expect(splitDiffGitPaths('a/my file.ts b/my file.ts')).toEqual(['my file.ts', 'my file.ts']);
    expect(splitDiffGitPaths('a/old.ts b/new.ts')).toEqual(['old.ts', 'new.ts']);
    expect(splitDiffGitPaths('"a/caf\\303\\251.ts" "b/caf\\303\\251.ts"')).toEqual(['café.ts', 'café.ts']);
  });
});
