import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    // Windows runners start processes slowly: a guard run spawns git many times and, once per
    // process, fsutil (or PowerShell) for the volume's file system type. Cleanup hooks also delete
    // fixture repos of thousands of files (the 5000-file submodule test), which takes over 10 s there.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
  },
});
