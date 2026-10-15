import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CustomerPattern } from '../src/classify/issuer.ts';
import { runExtraction, type ExtractionResult } from '../src/extract/pipeline.ts';
import { parsePdf } from '../src/pdf/parse.ts';
import { loadCustomers, loadProfiles, type DocType } from '../src/profiles/loader.ts';
import { buildEscalator } from '../src/llm/client.ts';
import { FixtureMissError } from '../src/llm/fixtures.ts';
import { compareDocument, type Comparison, type Expected } from './compare.ts';

/**
 * Runs the real pipeline over every scored sample.
 *
 * Shared by `npm run accuracy` and `tests/accuracy/kpi.test.ts` so the printed
 * number and the build-breaking assertion cannot drift apart.
 *
 * Still NO DATABASE: profiles and customers come from YAML and the import graph
 * never reaches db/pool.ts — verified by stopping Postgres and running it anyway.
 * That is what makes the printed number reproducible from a fresh clone, and it
 * is why `DATABASE_URL` is optional in the env schema while `db/pool.ts` demands
 * it.
 *
 * The escalator is passed as the real `buildEscalator`, which returns null under
 * `LLM_MODE=off` — so with no API key this behaves exactly as before, and with
 * one `LLM_MODE=record npm run accuracy` is the single command that records
 * every fixture.
 */
export const EXPECTED_DIR = 'accuracy/expected';
export const SAMPLES_DIR = 'sample docs';

export interface Scored {
  expected: Expected;
  result: ExtractionResult;
  comparisons: Comparison[];
  /**
   * Set when the document reached the escalator in `fixture` mode and no
   * recorded response existed. The miss stays LOUD — it is reported with the key
   * to record — and the document is then re-scored deterministically so the rest
   * of its fields are still measured.
   */
  fixtureMiss?: { field: string; key: string } | undefined;
}

export async function scoreAll(): Promise<Scored[]> {
  const customersYaml = await loadCustomers();
  const customers = customersYaml.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
  const slugById = new Map(customers.map((c) => [c.id, c.slug]));
  const patterns: CustomerPattern[] = customersYaml.flatMap((c, i) =>
    c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })));
  const profiles = await loadProfiles();
  const resolveProfile = async (customerId: number | null, docType: DocType) => {
    const slug = customerId === null ? null : slugById.get(customerId) ?? null;
    const p = profiles.find((x) => x.customerSlug === slug && x.docType === docType)
      ?? profiles.find((x) => x.customerSlug === null && x.docType === docType);
    return p === undefined ? null : { profileId: 0, definition: p.definition };
  };

  const files = (await readdir(EXPECTED_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: Scored[] = [];
  for (const f of files) {
    const expected = JSON.parse(await readFile(join(EXPECTED_DIR, f), 'utf8')) as Expected;
    const parsed = await parsePdf(join(SAMPLES_DIR, expected.file));
    const base = { parsed, customers, patterns, resolveProfile };

    let result: ExtractionResult;
    let fixtureMiss: { field: string; key: string } | undefined;
    let ranWithEscalator = true;
    try {
      result = await runExtraction({ ...base, escalate: buildEscalator });
    } catch (err) {
      // A fixture miss is a hard error by design — a silent fallthrough would
      // either turn an offline run into a billed one or hide prompt drift behind
      // passing tests. Catching it HERE is neither: it is named and reported, and
      // the document is then measured on everything that did not need the model.
      if (!(err instanceof FixtureMissError)) throw err;
      fixtureMiss = { field: err.field, key: err.key };
      result = await runExtraction({ ...base, escalate: null });
      ranWithEscalator = false;
    }
    const slug = result.customerId === null ? null : slugById.get(result.customerId) ?? null;
    out.push({
      expected, result, fixtureMiss,
      // `escalations`, NOT `llmCalls`: a fixture REPLAY answers the field while
      // making zero calls, so llmCalls > 0 reported "no escalator ran" and the
      // self-check then flagged all five recorded answers as stale declarations.
      // This is the exact distinction the two fields exist to keep apart, and the
      // first version of this line conflated them.
      comparisons: compareDocument(expected, result, slug, ranWithEscalator && result.escalations.length > 0),
    });
  }
  return out;
}

export interface Totals {
  passed: number;
  failed: number;
  pending: number;
  total: number;
  /**
   * passed / total, with `pending` counted in the DENOMINATOR but never as a
   * pass. So this is the WORST CASE: it gives the model no credit at all.
   *
   * It is also a FLOOR rather than a provisional figure, which is the useful
   * part. Recording a fixture turns a pending value into a pass or a fail;
   * a pass raises this number and a fail leaves it exactly where it is, because
   * a pending value was never counted as passing. It cannot go down.
   */
  pct: number;
  /** Passing values needed for >=95%. */
  required: number;
  /** Wrong values >=95% would tolerate. */
  allowed: number;
  /** Whether the floor already clears the brief's KPI. */
  meetsKpi: boolean;
}

export function totals(scored: Scored[]): Totals {
  const all = scored.flatMap((s) => s.comparisons);
  const passed = all.filter((c) => c.verdict === 'pass').length;
  const failed = all.filter((c) => c.verdict === 'fail').length;
  const pending = all.filter((c) => c.verdict === 'pending').length;
  const total = all.length;
  const pct = total === 0 ? 0 : (passed / total) * 100;
  return {
    passed, failed, pending, total, pct,
    required: Math.ceil(total * 0.95),
    allowed: Math.floor(total * 0.05),
    meetsKpi: pct >= 95,
  };
}
