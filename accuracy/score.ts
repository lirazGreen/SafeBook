import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CustomerPattern } from '../src/classify/issuer.ts';
import { runExtraction, type ExtractionResult } from '../src/extract/pipeline.ts';
import { parsePdf } from '../src/pdf/parse.ts';
import { loadCustomers, loadProfiles, type DocType } from '../src/profiles/loader.ts';

/**
 * Scores extraction against hand-read ground truth and prints a number.
 *
 * Deliberately runs the real pipeline with NO DATABASE: profiles and customers
 * come from YAML, so `npm run accuracy` works from a fresh clone with no Docker
 * and no API key. That keeps the number reproducible for whoever reviews this.
 *
 * It exists at phase 3 rather than at the end because it is a TOOL, not a
 * deliverable — every later change is measured instead of guessed at.
 */
const EXPECTED_DIR = 'accuracy/expected';
const SAMPLES_DIR = 'sample docs';

interface Comparison { field: string; expected: unknown; actual: unknown; ok: boolean }

/** Money and quantities are decimal strings; 72000 and "72000.00" are equal. */
function equal(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === 'string' && typeof actual === 'string') {
    const en = Number(expected);
    const an = Number(actual);
    if (!Number.isNaN(en) && !Number.isNaN(an)) return Math.abs(en - an) < 0.005;
    return expected.trim() === actual.trim();
  }
  return expected === actual;
}

function compareDocument(exp: Record<string, unknown>, got: ExtractionResult, slugById: Map<number, string>): Comparison[] {
  const actual: Record<string, unknown> = {
    docType: got.docType,
    customerSlug: got.customerId === null ? null : slugById.get(got.customerId) ?? null,
    startDate: got.startDate,
    endDate: got.endDate,
    amount: got.amount,
    currency: got.currency,
    paymentTermsDays: got.paymentTermsDays,
    billingFrequency: got.billingFrequency,
  };
  return Object.entries(exp).map(([k, v]) => ({
    field: k, expected: v, actual: actual[k], ok: equal(v, actual[k]),
  }));
}

function compareParties(exp: Record<string, Record<string, unknown>>, got: ExtractionResult): Comparison[] {
  const out: Comparison[] = [];
  for (const [role, fields] of Object.entries(exp)) {
    const party = got.parties.find((p) => p.role === role);
    for (const [k, v] of Object.entries(fields)) {
      const actual = party === undefined ? null : (party as unknown as Record<string, unknown>)[k];
      out.push({ field: `${role}.${k}`, expected: v, actual, ok: equal(v, actual) });
    }
  }
  return out;
}

function compareItems(exp: Record<string, unknown>[], got: ExtractionResult): Comparison[] {
  const out: Comparison[] = [];
  const n = Math.max(exp.length, got.items.length);
  for (let i = 0; i < n; i++) {
    const e = exp[i];
    const a = got.items[i] as unknown as Record<string, unknown> | undefined;
    if (e === undefined) { out.push({ field: `item[${i}]`, expected: '(no item)', actual: 'extra item', ok: false }); continue; }
    for (const [k, v] of Object.entries(e)) {
      const actual = a?.[k] ?? null;
      out.push({ field: `item[${i}].${k}`, expected: v, actual, ok: equal(v, actual) });
    }
  }
  return out;
}

function compareTerms(exp: Record<string, unknown>[], got: ExtractionResult): Comparison[] {
  return exp.map((e, i) => {
    const a = got.specialTerms.find((t) => t.termType === e['termType']);
    const okType = a !== undefined;
    const okPct = equal(e['percent'], a?.percent ?? null);
    return {
      field: `term[${i}].${String(e['termType'])}`,
      expected: `${String(e['termType'])}${e['percent'] === null ? '' : ` ${String(e['percent'])}%`}`,
      actual: a === undefined ? '(missing)' : `${a.termType}${a.percent === null ? '' : ` ${a.percent}%`}`,
      ok: okType && okPct,
    };
  });
}

async function main() {
  const customersYaml = await loadCustomers();
  const customers = customersYaml.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
  const slugById = new Map(customers.map((c) => [c.id, c.slug]));
  const patterns: CustomerPattern[] = customersYaml.flatMap((c, i) =>
    c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })));
  const profiles = await loadProfiles();
  const resolveProfile = async (customerId: number | null, docType: DocType) => {
    const slug = customerId === null ? null : slugById.get(customerId) ?? null;
    const p = profiles.find((x) => x.customerSlug === slug && x.docType === docType);
    return p === undefined ? null : { profileId: 0, definition: p.definition };
  };

  const files = (await readdir(EXPECTED_DIR)).filter((f) => f.endsWith('.json')).sort();
  let total = 0;
  let passed = 0;
  const failures: string[] = [];

  for (const f of files) {
    const exp = JSON.parse(await readFile(join(EXPECTED_DIR, f), 'utf8'));
    const parsed = await parsePdf(join(SAMPLES_DIR, exp.file));
    const got = await runExtraction({ parsed, customers, patterns, resolveProfile, escalate: null });

    const comparisons = [
      ...compareDocument(exp.document, got, slugById),
      ...compareParties(exp.parties, got),
      ...Object.entries(exp.typeDetails as Record<string, unknown>).map(([k, v]) => ({
        field: `type.${k}`, expected: v, actual: got.typeDetails[k] ?? null, ok: equal(v, got.typeDetails[k] ?? null),
      })),
      ...compareItems(exp.items, got),
      ...compareTerms(exp.specialTerms, got),
    ];

    const ok = comparisons.filter((c) => c.ok).length;
    total += comparisons.length;
    passed += ok;

    const pct = ((ok / comparisons.length) * 100).toFixed(1);
    console.log(`\n${exp.file}`);
    console.log(`  ${ok}/${comparisons.length} (${pct}%)  llm calls: ${got.llmCalls}  review: ${got.reviewReasons.join(',') || '(none)'}`);
    for (const c of comparisons.filter((x) => !x.ok)) {
      console.log(`  ✗ ${c.field}`);
      console.log(`      expected ${JSON.stringify(c.expected)}`);
      console.log(`      got      ${JSON.stringify(c.actual)}`);
      failures.push(`${exp.file} :: ${c.field}`);
    }
  }

  const pct = total === 0 ? 0 : (passed / total) * 100;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${passed} / ${total} scored values  =  ${pct.toFixed(1)}%`);
  console.log(`  KPI is >=95%: ${pct >= 95 ? 'PASS' : 'FAIL'}  (allows ${Math.floor(total * 0.05)} wrong, ${total - passed} wrong)`);
  console.log('='.repeat(64));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
