import pg from 'pg';
import { env } from '../config/env.ts';
// Registers the DATE and NUMERIC parsers. Must be imported before any query:
// see db/types.ts for why the driver's defaults lose information.
import './types.ts';

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
