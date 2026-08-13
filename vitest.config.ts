import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // node:sqlite is still flagged experimental in Node 22; the warning is
    // noise in test output.
    silent: false,
    testTimeout: 20_000,
    pool: 'forks',
  },
});
