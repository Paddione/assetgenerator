import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['server.js', 'worker-manager.js', 'adapters/**/*.js'],
      thresholds: {
        'worker-manager.js': { lines: 85, functions: 85, branches: 80, statements: 85 },
      },
    },
  },
});
