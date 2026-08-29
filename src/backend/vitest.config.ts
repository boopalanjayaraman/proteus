import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@proteus/schema': fileURLToPath(new URL('../../schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Starting a real replica set is slower than a mock, and worth it.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
