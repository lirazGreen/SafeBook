import pg from 'pg';
import { env } from '../config/env.ts';
// Registers the DATE and NUMERIC parsers. Must be imported before any query:
// see db/types.ts for why the driver's defaults lose information.
import './types.ts';

/**
 * DATABASE_URL is optional in the env schema so the accuracy harness and the
 * test suite can run with no database. Anything that actually opens a pool needs
 * it, and importing THIS module is opening one — so the check belongs here,
 * where it still fires at startup for the api and the worker.
 */
if (env.DATABASE_URL === undefined) {
  throw new Error(
    "DATABASE_URL is required to connect to Postgres. Copy .env.example to .env, " +
      "or start Postgres with docker compose up -d. " +
      "(npm run accuracy and npm test do not need it.)",
  );
}

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
