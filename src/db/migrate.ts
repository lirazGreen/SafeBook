import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Exported and no longer self-invoking, so the integration-test setup can
 * migrate its own database. Importing a module must not have the side effect of
 * running migrations and then closing the pool — `seed.ts` already guarded its
 * CLI block this way and this one had not been brought into line.
 */
export async function runMigrations(): Promise<number> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  let ran = 0;
  for (const name of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const previous = applied.get(name);

    if (previous === checksum) continue;
    if (previous !== undefined) {
      // An applied migration was edited. Silently re-running it would leave
      // environments diverged, so refuse and make the operator decide.
      throw new Error(
        `Migration ${name} changed after being applied ` +
          `(was ${previous}, now ${checksum}). Add a new migration instead of editing this one.`,
      );
    }

    // Each migration is one transaction: it applies whole or not at all.
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
    });
    console.log(`applied ${name}`);
    ran++;
  }

  console.log(ran === 0 ? 'no pending migrations' : `${ran} migration(s) applied`);
  return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
