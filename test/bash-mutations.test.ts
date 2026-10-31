import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectBashMutations } from '../src/adapters/bash-mutations.js';

const CWD = '/repo';
const abs = (p: string): string => path.resolve(CWD, p);
const paths = (cmd: string): string[] => detectBashMutations(cmd, CWD).map((m) => `${m.op}:${m.path}`);

describe('detectBashMutations', () => {
  it('detects sed -i (GNU and BSD forms) and perl -pi', () => {
    expect(paths(`sed -i 's/a/b/' src/a.ts src/b.ts`)).toEqual([`edit:${abs('src/a.ts')}`, `edit:${abs('src/b.ts')}`]);
    expect(paths(`sed -i '' -e 's/a/b/' package.json`)).toEqual([`edit:${abs('package.json')}`]);
    expect(paths(`sed -i.bak -e 's/a/b/' -e 's/c/d/' lib/x.js`)).toEqual([`edit:${abs('lib/x.js')}`]);
    expect(paths(`sed -n 's/a/b/p' src/a.ts`)).toEqual([]); // not in place
    expect(paths(`perl -pi -e 's/foo/bar/g' src/*.ts`)).toEqual([`edit:${abs('src/*.ts')}`]);
    expect(paths(`perl -0777 -i.orig -pe 's/x/y/' a.txt`)).toEqual([`edit:${abs('a.txt')}`]);
  });

  it('detects redirects and tee, recovering heredoc and echo content', () => {
    const [m] = detectBashMutations(`cat > notes.md <<'EOF'\n# Title\n\nbody line\nEOF`, CWD);
    expect(m).toEqual({ path: abs('notes.md'), op: 'write', content: '# Title\n\nbody line\n' });
    const [e] = detectBashMutations(`echo "export FOO=1" >> .env`, CWD);
    expect(e).toEqual({ path: abs('.env'), op: 'append', content: 'export FOO=1\n' });
    expect(paths(`ls -la > /dev/null 2>&1`)).toEqual([]);
    expect(paths(`make 2> build.log`)).toEqual([`write:${abs('build.log')}`]);
    expect(paths(`echo hi | tee -a out.txt other.txt`)).toEqual([`append:${abs('out.txt')}`, `append:${abs('other.txt')}`]);
    // Heredoc body must not be parsed as commands.
    expect(paths(`cat <<EOF > script.sh\nrm -rf /important\nsed -i x y\nEOF`)).toEqual([`write:${abs('script.sh')}`]);
  });

  it('detects mv, cp, rm, touch, chmod and git file operations', () => {
    expect(paths(`mv src/old.ts src/new.ts`)).toEqual([`move:${abs('src/old.ts')}`, `write:${abs('src/new.ts')}`]);
    expect(paths(`mv a.ts b.ts dir/`)).toEqual([`move:${abs('a.ts')}`, `write:${abs('dir/a.ts')}`, `move:${abs('b.ts')}`, `write:${abs('dir/b.ts')}`]);
    expect(paths(`cp -r templates/base.ts src/gen.ts`)).toEqual([`copy:${abs('src/gen.ts')}`]);
    expect(paths(`rm -rf dist src/legacy.ts`)).toEqual([`delete:${abs('dist')}`, `delete:${abs('src/legacy.ts')}`]);
    expect(paths(`touch src/index.ts`)).toEqual([`touch:${abs('src/index.ts')}`]);
    expect(paths(`chmod +x scripts/run.sh`)).toEqual([`chmod:${abs('scripts/run.sh')}`]);
    expect(paths(`git checkout -- src/a.ts`)).toEqual([`restore:${abs('src/a.ts')}`]);
    expect(paths(`git checkout main -- src/b.ts`)).toEqual([`restore:${abs('src/b.ts')}`]);
    expect(paths(`git restore --staged src/c.ts`)).toEqual([`restore:${abs('src/c.ts')}`]);
    expect(paths(`git rm -q old.md`)).toEqual([`delete:${abs('old.md')}`]);
    expect(paths(`git status && git diff`)).toEqual([]);
  });

  it('handles mv/cp target-directory forms, git mv -k, rm -- and globs', () => {
    expect(paths(`mv -t old test/a.test.js`)).toEqual([`move:${abs('test/a.test.js')}`, `write:${abs('old/a.test.js')}`]);
    expect(paths(`mv --target-directory=old a.js b.js`)).toEqual([`move:${abs('a.js')}`, `write:${abs('old/a.js')}`, `move:${abs('b.js')}`, `write:${abs('old/b.js')}`]);
    expect(paths(`mv test/a.js -t old`)).toEqual([`move:${abs('test/a.js')}`, `write:${abs('old/a.js')}`]);
    expect(paths(`cp -t out src/a.js`)).toEqual([`copy:${abs('out/a.js')}`]);
    expect(paths(`git mv -k test/a.test.js test/b.test.js`)).toEqual([`move:${abs('test/a.test.js')}`, `write:${abs('test/b.test.js')}`]);
    expect(paths(`rm -- -weird.js`)).toEqual([`delete:${abs('-weird.js')}`]);
    expect(paths(`rm test/*.test.js`)).toEqual([`delete:${abs('test/*.test.js')}`]);
    expect(paths(`rm -f tests/**/*.spec.ts`)).toEqual([`delete:${abs('tests/**/*.spec.ts')}`]);
    expect(paths(`rm -rf test/*`)).toEqual([`delete:${abs('test/*')}`, `delete:${abs('test/*/**')}`]);
    expect(paths(`git rm -r -q test/*`)).toEqual([`delete:${abs('test/*')}`, `delete:${abs('test/*/**')}`]);
  });

  it('maps package manager commands to manifest and lockfile', () => {
    expect(paths(`npm install picocolors`)).toEqual([`install:${abs('package.json')}`, `install:${abs('package-lock.json')}`]);
    expect(paths(`npm ci`)).toEqual([`install:${abs('package-lock.json')}`]);
    expect(paths(`pnpm add -D vitest`)).toEqual([`install:${abs('package.json')}`, `install:${abs('pnpm-lock.yaml')}`]);
    expect(paths(`yarn add zod`)).toEqual([`install:${abs('package.json')}`, `install:${abs('yarn.lock')}`]);
    expect(paths(`cargo add serde`)).toEqual([`install:${abs('Cargo.toml')}`, `install:${abs('Cargo.lock')}`]);
    expect(paths(`go get github.com/x/y`)).toEqual([`install:${abs('go.mod')}`, `install:${abs('go.sum')}`]);
    expect(paths(`npm test`)).toEqual([]);
    expect(paths(`npm run build`)).toEqual([]);
  });

  it('follows cd across && chains and handles wrappers', () => {
    expect(paths(`cd packages/web && npm install react`)).toEqual([
      `install:${abs('packages/web/package.json')}`,
      `install:${abs('packages/web/package-lock.json')}`,
    ]);
    expect(paths(`sudo rm -f /etc/thing.conf`)).toEqual([`delete:/etc/thing.conf`]);
    expect(paths(`FOO=1 sed -i 's/a/b/' x.ts; npx prettier --write src/`)).toEqual([`edit:${abs('x.ts')}`, `format:${abs('src')}`]);
    expect(paths(`npx prettier --check src/`)).toEqual([]);
    expect(paths(`pnpm exec eslint --fix src/a.ts`)).toEqual([`format:${abs('src/a.ts')}`]);
  });

  it('detects files written by inline python and node scripts, not files they only read', () => {
    const py = "cd sub && python3 - <<'EOF'\np='docs/plan.md';s=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nprint(open('other.json').read())\nEOF";
    expect(paths(py)).toEqual(['edit:/repo/sub/docs/plan.md']);
    const loop = "python3 - <<'EOF'\nfor f in ['a/one.md', 'b/two.md']:\n    open(f, 'w').write('x')\nopen(f'out/{n}.md', 'w')\nEOF";
    expect(paths(loop)).toEqual(['edit:/repo/a/one.md', 'edit:/repo/b/two.md']);
    expect(paths(`python3 -c "import pathlib; pathlib.Path('x/y.txt').write_text('hi')"`)).toEqual(['edit:/repo/x/y.txt']);
    expect(paths(`node -e "const fs=require('fs'); const f='pkg/a.json'; fs.writeFileSync(f, '{}')"`)).toEqual(['edit:/repo/pkg/a.json']);
    expect(paths(`python3 -c "print(open('README.md').read())"`)).toEqual([]);
  });

  it('ignores commands that only read', () => {
    expect(paths(`grep -rn "foo" src && cat README.md | head -n 5`)).toEqual([]);
    expect(paths(`curl -s https://example.com/api | jq '.items[]'`)).toEqual([]);
    expect(paths(`node -e "console.log(process.cwd())"`)).toEqual([]);
    expect(paths(`echo "a > b" # redirect-looking text inside quotes`)).toEqual([]);
  });
});
