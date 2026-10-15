import pg from 'pg';
import { loadDotEnv } from '../../src/config/dotenv.ts';

/**
 * Creates, migrates and seeds a SEPARATE database for the integration tests.
 *
 * Sharing the development database did not work, and the reasons are worth
 * recording because both looked like flaky tests rather than a design problem:
 *
 *  - A worker running in another terminal (or in `docker compose`) claims the
 *    tests' jobs. `FOR UPDATE SKIP LOCKED` is doing exactly its job — two
 *    claimants are indistinguishable from two worker replicas — so the tests
 *    reported fewer extractions than they enqueued.
 *  - Worse, that worker runs with `LLM_MODE=off` (no key) while the test runner
 *    pins `fixture`. The same order form therefore SUCCEEDS with
 *    FIELD_NOT_FOUND under one and FAILS with a fixture miss under the other, so
 *    which assertion held depended on who got there first.
 *  - And rows leaked between runs, so a test's own document came back as a
 *    duplicate of itself.
 *
 * One database per concern fixes all three at the root.
 */
export const TEST_DB = 'safebook_test';

/** Swaps the database name, keeping credentials and host. */
export function testDatabaseUrl(from: string): string {
  const url = new URL(from);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  loadDotEnv();
  const configured = process.env['DATABASE_URL'];
  if (configured === undefined) return;   // the tests will skip; nothing to do

  const admin = new URL(configured);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch {
    return;   // no Postgres: every integration test skips, with its own reason
  }

  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) {
      // Not parameterisable — an identifier, not a value. TEST_DB is a constant
      // in this file, never input.
      await client.query(`CREATE DATABASE ${TEST_DB}`);
    }
  } finally {
    await client.end();
  }

  // Migrate and seed against the test database by pointing the env at it before
  // importing either module — both read `env` at import time.
  process.env['DATABASE_URL'] = testDatabaseUrl(configured);
  const { runMigrations } = await import('../../src/db/migrate.ts');
  const { seed } = await import('../../src/profiles/seed.ts');
  await runMigrations();
  await seed();
  const { pool } = await import('../../src/db/pool.ts');
  await pool.end();
}
