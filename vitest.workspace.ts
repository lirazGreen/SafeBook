import { loadDotEnv } from './src/config/dotenv.ts';
import { testDatabaseUrl } from './tests/integration/setup.ts';

/**
 * Two projects, because the integration tests need a database of their own and
 * must not run in parallel with each other.
 *
 * Vitest runs test FILES concurrently by default, and both integration files
 * drive the same job queue — so they claimed each other's jobs and each reported
 * fewer than it enqueued. Individually green, together red, which is the worst
 * way to find out. That is not a bug in the queue: `FOR UPDATE SKIP LOCKED` is
 * doing exactly its job, and two test files are indistinguishable from two
 * worker replicas. It is the TESTS that need isolation.
 *
 * The separate DATABASE closes the other half, which `singleFork` alone could
 * not: a worker running in another terminal also claims those jobs, and it runs
 * with `LLM_MODE=off` while the test runner pins `fixture` — so the same order
 * form succeeded under one and failed under the other, and which assertion held
 * depended on who got there first. See tests/integration/setup.ts.
 *
 * The ~250 unit tests keep running concurrently and touch no database at all.
 */
loadDotEnv();
const configured = process.env['DATABASE_URL'];

export default [
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts', 'tests/accuracy/**/*.test.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      globalSetup: ['./tests/integration/setup.ts'],
      // Set HERE rather than in globalSetup: forked workers inherit the env of
      // the process that spawns them, and relying on that ordering is the kind
      // of implicit coupling this file exists to remove.
      ...(configured === undefined ? {} : { env: { DATABASE_URL: testDatabaseUrl(configured) } }),
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true } },
    },
  },
];
