import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CustomerPattern } from '../../src/classify/issuer.ts';
import type { EscalatorFactory, ExtractionResult } from '../../src/extract/pipeline.ts';
import { runExtraction } from '../../src/extract/pipeline.ts';
import { parsePdf, type ParsedPdf } from '../../src/pdf/parse.ts';
import { loadCustomers, loadProfiles, type DocType } from '../../src/profiles/loader.ts';

/**
 * Special terms are the LAST escalation to be wired, and the only one that
 * returns a LIST — one paragraph can yield several rows, because CloudShield's
 * burst clause states a different percentage for each of three subscription
 * years.
 *
 * It was also the path that looked wired and was not: the pipeline incremented
 * `llmCalls` when the bullet parse came back empty and never called anything, so
 * no order form ever got special terms AND the call count was a count of
 * intentions. Both are fixed here, and these tests are what hold them.
 *
 * Stubbed, not recorded: these assert the PLUMBING (mapping, evidence rejection,
 * synonyms reaching the prompt). Whether Claude actually finds 38.89% is the
 * accuracy harness's job, against a real recorded response — a mock there would
 * score the pipeline against output we imagined.
 */
const parsed: Record<string, ParsedPdf> = {};
let customers: { id: number; slug: string; name: string }[];
let patterns: CustomerPattern[];
let resolveProfile: (c: number | null, d: DocType) => Promise<{ profileId: number; definition: unknown } | null>;

beforeAll(async () => {
  const yaml = await loadCustomers();
  customers = yaml.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
  patterns = yaml.flatMap((c, i) =>
    c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })));
  const profiles = await loadProfiles();
  resolveProfile = async (customerId, docType) => {
    const slug = customerId === null ? null : customers.find((c) => c.id === customerId)?.slug ?? null;
    const d = profiles.find((p) => p.docType === docType && p.customerSlug === slug)
      ?? profiles.find((p) => p.docType === docType && p.customerSlug === null);
    return d ? { profileId: 1, definition: d.definition } : null;
  };
  for (const [key, file] of [
    ['acme', 'ACME Order From.pdf'],
    ['cloudshield', 'CloudShield Order Form.pdf'],
    ['brightops', 'Purchase Order – BrightOps Analytics Ltd.pdf'],
  ] as const) {
    parsed[key] = await parsePdf(join('sample docs', file));
  }
});

const term = (over: Record<string, unknown>) => ({
  term_type: 'burst', ordinal: 1, percent: null, cap_value: null, cap_unit: null,
  period: null, applies_to: null, quote: '', ...over,
});

/** Answers `special_terms` with the given list; every other field escalates to null. */
function stub(terms: Record<string, unknown>[]): { factory: EscalatorFactory; seen: ReturnType<typeof vi.fn> } {
  const seen = vi.fn();
  const factory: EscalatorFactory = (opts) => {
    seen(opts.synonyms, opts.docType);
    return async (field) => {
      if (field !== 'special_terms') return null;
      opts.onCall?.();
      return { terms };
    };
  };
  return { factory, seen };
}

const run = (key: string, factory: EscalatorFactory | null): Promise<ExtractionResult> =>
  runExtraction({
    parsed: parsed[key]!, customers, patterns,
    resolveProfile: resolveProfile as never, escalate: factory,
  });

describe('the escalator is built from the PROFILE, not by the caller', () => {
  it('receives Acme\'s TAM synonyms, which is why it has to be a factory', async () => {
    // Acme never writes the phrase "Technical Account Manager" — it names a
    // "Customer Support Manager and Product Architect". Those synonyms live in
    // its profile, and the profile resolves INSIDE the pipeline. Handing the
    // pipeline a ready-made escalator (which ingest.ts did) meant they were
    // silently never applied and withSynonyms was dead code.
    const { factory, seen } = stub([]);
    await run('acme', factory);
    expect(seen).toHaveBeenCalledWith(
      { technical_account_manager: ['Customer Support Manager', 'Product Architect'] },
      'order_form',
    );
  });
});

describe('mapping a returned list onto special_terms rows', () => {
  it('keeps percentages as decimal STRINGS, so 38.89 reaches NUMERIC intact', async () => {
    const { factory } = stub([
      term({ percent: 38.89, cap_value: 280000, cap_unit: 'Billable Units',
             period: 'subscription_year', applies_to: 'CloudShield Enterprise',
             quote: 'during Year 1, up to 38.89%' }),
      term({ percent: 28.21, quote: 'during Year 2, up to 28.21%' }),
      term({ percent: 19.05, quote: 'and (c) during Year 3, up to 19.05%' }),
    ]);
    const got = await run('cloudshield', factory);
    expect(got.specialTerms.map((t) => t.percent)).toEqual(['38.89', '28.21', '19.05']);
    expect(got.specialTerms[0]!.capValue).toBe('280000');
    expect(got.specialTerms[0]!.capUnit).toBe('Billable Units');
    expect(got.specialTerms[0]!.appliesTo).toBe('CloudShield Enterprise');
  });

  it('stores the DOCUMENT\'s characters as term_text, not the model\'s rendering', async () => {
    // Acme uses curly quotes around (the "Burst Threshold"); a model returns
    // ASCII. term_text is the source of truth and the parsed columns are a
    // projection of it, so it must be what the page actually says.
    const { factory } = stub([
      term({ percent: 5, quote: 'up to 5% more Billable Units in connection with SaaS subscription' }),
    ]);
    const got = await run('acme', factory);
    expect(got.specialTerms).toHaveLength(1);
    expect(got.specialTerms[0]!.termText)
      .toBe('up to 5% more Billable Units in connection with SaaS subscription');
  });

  it('matches a quote across a LINE BREAK, which a naive indexOf would reject', async () => {
    // Acme's burst clause wraps: "...Customer shall have\nthe right to utilize
    // up to 5% more...". A model returns it as one line.
    const { factory } = stub([
      term({ percent: 5, quote: 'Customer shall have the right to utilize up to 5% more Billable Units' }),
    ]);
    const got = await run('acme', factory);
    expect(got.specialTerms).toHaveLength(1);
    // the stored text keeps the document's own newline
    expect(got.specialTerms[0]!.termText).toContain('\n');
    expect(got.reviewReasons).not.toContain('LLM_EVIDENCE_MISMATCH');
  });

  it('DROPS a term whose citation is not in the document, and flags it', async () => {
    // Same rule as every other escalated value: an unverifiable value is treated
    // as no value. A model that invents a term will often invent a plausible
    // citation alongside it.
    const { factory } = stub([
      term({ percent: 5, quote: 'up to 5% more Billable Units in connection with SaaS subscription' }),
      term({ percent: 99, quote: 'Customer may burst without limit at no cost whatsoever.' }),
    ]);
    const got = await run('acme', factory);
    expect(got.specialTerms.map((t) => t.percent)).toEqual(['5']);
    expect(got.reviewReasons).toContain('LLM_EVIDENCE_MISMATCH');
  });

  it('ignores a malformed list rather than storing half a row', async () => {
    const { factory } = stub([{ term_type: 'burst' }]);   // missing every other key
    const got = await run('acme', factory);
    expect(got.specialTerms).toEqual([]);
  });
});

describe('call counting means what it says', () => {
  it('counts API CALLS, not intentions', async () => {
    // The old code did `llmCalls++` when the bullet parse was empty and never
    // called anything — so the number was unfalsifiable. It now comes from the
    // client's onCall hook, which means a replayed fixture correctly reports 0.
    const { factory } = stub([]);
    const got = await run('acme', factory);
    expect(got.llmCalls).toBe(1);                       // one special_terms call
    expect(got.escalations).toContain('special_terms');
    expect(got.escalations).toContain('payment_terms_days');
  });

  it('a purchase order never reaches the special-terms escalator', async () => {
    // Its terms are labelled bullets, so the deterministic parse answers.
    const { factory } = stub([term({ percent: 999, quote: 'nonsense' })]);
    const got = await run('brightops', factory);
    expect(got.escalations).toEqual([]);
    expect(got.llmCalls).toBe(0);
    expect(got.specialTerms.map((t) => `${t.termType} ${t.percent ?? ''}`.trim()))
      .toEqual(['burst 10', 'technical_account_manager']);
  });

  it('with no escalator at all, nothing is attempted and the document still persists', async () => {
    const got = await run('acme', null);
    expect(got.escalations).toEqual([]);
    expect(got.llmCalls).toBe(0);
    expect(got.specialTerms).toEqual([]);
    expect(got.reviewReasons).toContain('FIELD_NOT_FOUND');
    expect(got.amount).toBe('152500');                  // everything else intact
  });
});
