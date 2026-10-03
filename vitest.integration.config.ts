import { defineConfig } from 'vitest/config';
// Integration tests talk to a real server process, and (when BEETLE_LIVE_MODEL=1) to the real local model.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 180000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});
