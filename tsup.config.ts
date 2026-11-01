import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// Library build for the npm package (dist/): the library entry only. The CLI users run is the
// standalone bundle from scripts/build.mjs (plugin/bin/why-diff.mjs).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  define: { __WHY_DIFF_VERSION__: JSON.stringify(version) },
});
