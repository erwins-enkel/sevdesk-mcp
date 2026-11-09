import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test gets its own temporary home and local directories (foundation decision 7).
    setupFiles: ['test/setup.ts'],
  },
});
