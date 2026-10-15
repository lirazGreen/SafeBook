import pg from 'pg';
import { env } from '../config/env.ts';
// Registers the DATE and NUMERIC parsers. Must be imported before any query:
// see db/types.ts for why the driver's defaults lose information.
import './types.ts';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

/**
 * Fails loudly when no DATABASE_URL is configured. Called by the ENTRYPOINTS.
 *
 * This used to be a bare throw at module scope, which was wrong in a way only a
 * fresh clone revealed: the integration tests probe for a database by catching a
 * failed QUERY, but a module-level throw happens at IMPORT, before any try/catch
 * can see it. So on a clone with no .env, three whole suites FAILED TO LOAD
 * instead of skipping -- and the error text claimed npm test did not need it.
 *
 * A module should not throw on import. Boot-time failure is still right for the
 * api and the worker, so the assertion moved to them, where it is explicit.
 */
export function assertDatabaseConfigured(): void {
  if (env.DATABASE_URL !== undefined) return;
  throw new Error(
    'DATABASE_URL is required to connect to Postgres. Copy .env.example to .env, ' +
      'or start Postgres with: docker compose up -d. ' +
      '(npm run accuracy and npm test do not need a database.)',
  );
}

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
