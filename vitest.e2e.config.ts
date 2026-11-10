import { defineConfig } from 'vitest/config';

// The manual E2E run against a real sevDesk account (`bun run test:e2e`, PRD §8, decision 29). It
// runs locally and by hand only: `bun run test`, `bun run verify` and CI use vitest.config.ts, whose
// default include (`*.test.*`, `*.spec.*`) never matches `*.e2e.ts`. Without SEVDESK_E2E_TOKEN it
// skips.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    // Shows why a test was skipped.
    reporters: ['verbose'],
    // The real API, its rate limits and a spawned server are slow.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
