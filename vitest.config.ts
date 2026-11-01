import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    // Windows runners start processes slowly: a guard run spawns git many times and, once per
    // process, fsutil (or PowerShell) for the volume's file system type.
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
  },
});
