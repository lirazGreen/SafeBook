import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomerPattern } from '../../src/classify/issuer.ts';
import { runExtraction } from '../../src/extract/pipeline.ts';
import { parsePdf } from '../../src/pdf/parse.ts';
import { loadCustomers, loadProfiles, type DocType } from '../../src/profiles/loader.ts';

/**
 * Turns the brief's ">=95% field accuracy" KPI into a build-breaking assertion.
 *
 * Runs the real pipeline with NO DATABASE and NO API KEY, so it is reproducible
 * from a fresh clone — which is what makes the printed number mean anything.
 */
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

const expectedFiles = (await readdir('accuracy/expected')).filter((f) => f.endsWith('.json')).sort();

describe('accuracy KPI', () => {
  it('has ground truth for at least one document per supported type so far', () => {
    expect(expectedFiles.length).toBeGreaterThan(0);
  });

  it.each(expectedFiles)('%s extracts exactly as hand-read from the PDF', async (file) => {
    const exp = JSON.parse(await readFile(join('accuracy/expected', file), 'utf8'));
    const parsed = await parsePdf(join('sample docs', exp.file));
    const got = await runExtraction({ parsed, customers, patterns, resolveProfile, escalate: null });

    // document-level
    expect(got.docType).toBe(exp.document.docType);
    expect(got.customerId === null ? null : slugById.get(got.customerId)).toBe(exp.document.customerSlug);
    expect(got.startDate).toBe(exp.document.startDate);
    expect(got.endDate).toBe(exp.document.endDate);
    expect(Number(got.amount)).toBe(Number(exp.document.amount));
    expect(got.currency).toBe(exp.document.currency);
    expect(got.paymentTermsDays).toBe(exp.document.paymentTermsDays);
    expect(got.billingFrequency).toBe(exp.document.billingFrequency);

    // parties
    for (const [role, fields] of Object.entries(exp.parties as Record<string, Record<string, unknown>>)) {
      const party = got.parties.find((p) => p.role === role)!;
      for (const [k, v] of Object.entries(fields)) {
        expect((party as unknown as Record<string, unknown>)[k], `${role}.${k}`).toBe(v);
      }
    }

    // items, including the reconciliation that validates the whole table parse
    expect(got.items).toHaveLength(exp.items.length);
    exp.items.forEach((e: Record<string, unknown>, i: number) => {
      const a = got.items[i]!;
      expect(a.productName, `item[${i}].productName`).toBe(e['productName']);
      expect(a.itemStartDate, `item[${i}].start`).toBe(e['itemStartDate']);
      expect(a.itemEndDate, `item[${i}].end`).toBe(e['itemEndDate']);
      expect(Number(a.quantity), `item[${i}].qty`).toBe(Number(e['quantity']));
      expect(Number(a.totalAmount), `item[${i}].total`).toBe(Number(e['totalAmount']));
    });
    expect(got.items.reduce((t, i) => t + Number(i.totalAmount), 0)).toBe(Number(exp.document.amount));

    // special terms
    for (const e of exp.specialTerms as Record<string, unknown>[]) {
      const a = got.specialTerms.find((t) => t.termType === e['termType']);
      expect(a, `term ${String(e['termType'])}`).toBeDefined();
      if (e['percent'] !== null) expect(Number(a!.percent)).toBe(Number(e['percent']));
    }

    // a clean document must raise no review flags at all
    expect(got.reviewReasons).toEqual([]);
  });

  it('needs no LLM call for a purchase order — the rules already parse', async () => {
    for (const file of expectedFiles) {
      const exp = JSON.parse(await readFile(join('accuracy/expected', file), 'utf8'));
      if (exp.document.docType !== 'purchase_order') continue;
      const parsed = await parsePdf(join('sample docs', exp.file));
      const got = await runExtraction({ parsed, customers, patterns, resolveProfile, escalate: null });
      expect(got.llmCalls, exp.file).toBe(0);
    }
  });
});
