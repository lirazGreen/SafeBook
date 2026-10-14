import { pool, withTransaction } from '../db/pool.ts';
import { loadCustomers, loadProfiles } from './loader.ts';

/**
 * Projects config/ into the database. The YAML is the single source of truth;
 * nothing else writes `customers`, `customer_match_patterns` or
 * `extraction_profiles`, which is why no precedence rule is needed.
 *
 * `extraction_profiles` is append-only: a changed definition inserts version+1
 * and activates it, leaving the old row readable so
 * `extraction_runs.profile_id` still resolves for documents extracted under it.
 */
export interface SeedReport {
  customers: { inserted: number; updated: number };
  patterns: number;
  profiles: { unchanged: number; newVersions: number };
}

export async function seed(configDir = 'config'): Promise<SeedReport> {
  const customers = await loadCustomers(configDir);
  const profiles = await loadProfiles(configDir);

  return withTransaction(async (client) => {
    const report: SeedReport = {
      customers: { inserted: 0, updated: 0 },
      patterns: 0,
      profiles: { unchanged: 0, newVersions: 0 },
    };

    const idBySlug = new Map<string, number>();
    for (const c of customers) {
      const { rows } = await client.query<{ id: number; inserted: boolean }>(
        `INSERT INTO customers (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [c.slug, c.name],
      );
      const row = rows[0] as { id: number; inserted: boolean };
      idBySlug.set(c.slug, row.id);
      if (row.inserted) report.customers.inserted++;
      else report.customers.updated++;

      // Patterns are replaced wholesale: the YAML is authoritative, so a pattern
      // deleted from it must disappear rather than linger in the table.
      await client.query('DELETE FROM customer_match_patterns WHERE customer_id = $1', [row.id]);
      for (const m of c.match) {
        await client.query(
          'INSERT INTO customer_match_patterns (customer_id, kind, pattern) VALUES ($1, $2, $3)',
          [row.id, m.kind, m.pattern],
        );
        report.patterns++;
      }
    }

    for (const p of profiles) {
      const customerId = p.customerSlug === null ? null : idBySlug.get(p.customerSlug);
      if (p.customerSlug !== null && customerId === undefined) {
        throw new Error(
          `profile ${p.customerSlug}/${p.docType} has no matching entry in customers.yaml`,
        );
      }

      const { rows: active } = await client.query<{ content_hash: string; version: number }>(
        `SELECT content_hash, version FROM extraction_profiles
         WHERE COALESCE(customer_id, 0) = COALESCE($1::bigint, 0) AND doc_type = $2 AND is_active`,
        [customerId ?? null, p.docType],
      );
      const current = active[0];
      if (current !== undefined && current.content_hash === p.contentHash) {
        report.profiles.unchanged++;
        continue;
      }

      const { rows: maxRows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM extraction_profiles
         WHERE COALESCE(customer_id, 0) = COALESCE($1::bigint, 0) AND doc_type = $2`,
        [customerId ?? null, p.docType],
      );
      const nextVersion = (maxRows[0] as { next: number }).next;

      // one active version per (customer, doc_type) — enforced by a partial unique index
      await client.query(
        `UPDATE extraction_profiles SET is_active = FALSE
         WHERE COALESCE(customer_id, 0) = COALESCE($1::bigint, 0) AND doc_type = $2 AND is_active`,
        [customerId ?? null, p.docType],
      );
      await client.query(
        `INSERT INTO extraction_profiles
           (customer_id, doc_type, version, definition, content_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [customerId ?? null, p.docType, nextVersion, p.definition, p.contentHash],
      );
      report.profiles.newVersions++;
    }

    return report;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((r) => {
      console.log(
        `customers: ${r.customers.inserted} new, ${r.customers.updated} updated | ` +
          `patterns: ${r.patterns} | profiles: ${r.profiles.newVersions} new version(s), ` +
          `${r.profiles.unchanged} unchanged`,
      );
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
