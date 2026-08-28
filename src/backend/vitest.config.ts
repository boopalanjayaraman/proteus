import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@proteus/schema': fileURLToPath(new URL('../../schema/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
