import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/types.ts'],
      thresholds: {
        // Baseline for all factory code (docs/11-test-strategy.md §6).
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,

        // Scoring and stop rules decide what the agent is allowed to do.
        // An untested branch here is an unverified permission path, so these
        // demand full branch coverage rather than the general baseline.
        'src/scoring/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/stop-rules/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The CLIs are the CI entry points that compute oversight scores before
        // the agent starts, so an untested branch here is an unverified
        // permission decision (docs/06 §5.1).
        'src/cli/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The pipeline decides which terminal state a work item reaches, so an
        // untested branch here is an unverified path through the gates.
        'src/pipeline/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Model-tier routing decides which LLM a work item uses (cost/capability,
        // docs/ADR/011); an untested branch is an unverified routing decision.
        'src/model-tier/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/issue-analysis/**/*.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
})
