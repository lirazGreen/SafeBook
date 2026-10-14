import pg from 'pg';
import { env } from '../config/env.ts';

// Money arrives as NUMERIC. node-postgres hands NUMERIC back as a string by
// default, which is correct — parsing it into a JS float would reintroduce the
// rounding error NUMERIC exists to avoid. CloudShield's 22916.67 x 12 must stay
// exact. Callers convert deliberately, never implicitly.
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
