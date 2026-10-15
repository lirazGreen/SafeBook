import { beforeAll, describe, expect, it } from 'vitest';
import type { CustomerPattern } from '../../src/classify/issuer.ts';
import { runExtraction, type ExtractionResult } from '../../src/extract/pipeline.ts';
import { parsePdfBytes } from '../../src/pdf/parse.ts';
import { loadCustomers, loadProfiles, type DocType } from '../../src/profiles/loader.ts';
import * as docs from '../helpers/documents.ts';

/**
 * The README's "Trying it with your own documents" claims, exercised.
 *
 * These are the first tests to run a document the system has NEVER SEEN — from a
 * customer nobody registered, in a layout nobody configured — through the real
 * parse → classify → infer issuer → resolve profile → extract → validate path.
 * Everything before this either used one of the four samples or reused their
 * geometry, so the central adaptability claim rested on reasoning rather than
 * evidence.
 *
 * Built with tests/helpers/makePdf.ts so `pdfjs` does the parsing for real.
 * Synthesising a `ParsedPdf` object would skip the layer that turns coordinates
 * into rows, which is exactly the layer most likely to be wrong on an unfamiliar
 * document.
 */
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
});

/** Runs the real pipeline, deterministic-only — no key, no escalator. */
async function extract(bytes: Buffer): Promise<ExtractionResult> {
  const parsed = await parsePdfBytes(bytes);
  return runExtraction({
    parsed, customers, patterns, resolveProfile: resolveProfile as never, escalate: null,
  });
}

const money = (v: string | null) => (v === null ? null : Number(v));

describe('a NEW customer sending a purchase order', () => {
  let r: ExtractionResult;
  beforeAll(async () => { r = await extract(docs.newCustomerPurchaseOrder()); });

  it('classifies it and names the issuer, with nothing configured', () => {
    expect(r.docType).toBe('purchase_order');
    // The PO path: the title AND `Company Name:` under Buyer, two independent
    // sources agreeing. No per-customer regex exists for this company.
    expect(r.detectedIssuerName).toBe('Northwind Logistics Ltd.');
    expect(r.customerId).toBeNull();
    expect(r.customerResolution).toBe('unmatched');
  });

  it('extracts the whole document from the BASE profile alone', () => {
    expect(r.startDate).toBe('2025-04-01');
    expect(r.endDate).toBe('2027-03-31');
    expect(money(r.amount)).toBe(220000);
    expect(r.currency).toBe('USD');
    expect(r.paymentTermsDays).toBe(60);          // `Net 60` parses; no escalation
    expect(r.billingFrequency).toBe('Annual');
    expect(r.typeDetails['po_number']).toBe('PO-NW-44120');
    expect(r.typeDetails['po_date']).toBe('2025-03-18');
  });

  it('recovers both parties, including a multi-line foreign address', () => {
    const by = (role: string) => r.parties.find((p) => p.role === role)!;
    expect(by('buyer').name).toBe('Northwind Logistics Ltd.');
    expect(by('buyer').address).toBe('8 Dock Road, Liverpool, L3 4AA, UK');
    expect(by('vendor').name).toBe('Helios Telematics GmbH');
    expect(by('vendor').address).toBe('17 Hafenstrasse, Hamburg, 20457, Germany');
    expect(by('buyer').signaturePresent).toBe(true);
    expect(by('buyer').signerName).toBe('Priya Raman');
    // a vendor never signs a PO — null is the right answer, not false
    expect(by('vendor').signaturePresent).toBeNull();
  });

  it('reconstructs a table it has never seen, and it RECONCILES', () => {
    // Five columns in a different order and with different widths from either
    // real PO, and no `quantity` column at all.
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.productName)).toEqual([
      'Fleet Telemetry Suite', 'Fleet Telemetry Suite', 'Onboarding Services',
    ]);
    expect(r.items.map((i) => money(i.totalAmount))).toEqual([96000, 104000, 20000]);
    expect(r.items.map((i) => i.itemStartDate)).toEqual(['2025-04-01', '2026-04-01', '2025-04-01']);
    // Σ items == amount, which is what proves the parse rather than asserting it
    expect(r.items.reduce((t, i) => t + Number(i.totalAmount), 0)).toBe(money(r.amount));
  });

  it('reads the labelled special terms without the model', () => {
    expect(r.escalations).toEqual([]);
    expect(r.specialTerms.map((t) => `${t.termType} ${t.percent ?? ''}`.trim()))
      .toEqual(['burst 12', 'technical_account_manager']);
  });

  it('is flagged ONLY because the customer is unregistered', () => {
    // Which is the design's claim: an unknown customer is extracted and
    // surfaced, never dropped and never silently accepted.
    expect(r.reviewReasons).toEqual(['UNMATCHED_CUSTOMER']);
  });
});

describe('a NEW customer sending an order form', () => {
  let r: ExtractionResult;
  beforeAll(async () => { r = await extract(docs.newCustomerOrderForm()); });

  it('infers the vendor by SUBTRACTION, since order forms never label it', () => {
    expect(r.docType).toBe('order_form');
    // "Zenith Cloud Inc. Harbourline Freight Inc." minus the buyer. Positional,
    // not token-based — both names would otherwise contribute "Inc.".
    expect(r.detectedIssuerName).toBe('Zenith Cloud Inc.');
    expect(r.customerResolution).toBe('unmatched');
  });

  it('extracts the deterministic fields, including a long-month date format', () => {
    expect(r.startDate).toBe('2025-04-01');
    expect(r.endDate).toBe('2027-03-31');
    expect(money(r.amount)).toBe(180000);
    expect(r.billingFrequency).toBe('Annual');
    expect(r.typeDetails['quote_number']).toBe('Q-ZN-5513');
    expect(r.typeDetails['quote_date']).toBe('2025-03-03');
  });

  it('reads the TWO-COLUMN signature block from geometry, both roles', () => {
    // "Name:" appears twice on one text line; only x coordinates separate them.
    // Column positions are discovered from the anchor line, so these x values
    // (60/330) work without being configured anywhere.
    const by = (role: string) => r.parties.find((p) => p.role === role)!;
    expect(by('buyer').signerName).toBe('Tom Whitaker');
    expect(by('buyer').signerTitle).toBe('COO');
    expect(by('buyer').signatureDate).toBe('2025-03-20');
    expect(by('vendor').signerName).toBe('Dana Okafor');
    expect(by('vendor').signerTitle).toBe('CFO');
    expect(by('buyer').signaturePresent).toBe(true);
  });

  it('reconstructs a 6-column table with abbreviated dates', () => {
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => money(i.totalAmount))).toEqual([80000, 88000, 12000]);
    expect(r.items[2]!.quantity).toBe('30');
    expect(r.items[0]!.itemStartDate).toBe('2025-04-01');   // "Apr 1,2025"
    expect(r.items.reduce((t, i) => t + Number(i.totalAmount), 0)).toBe(money(r.amount));
  });

  it('ESCALATES exactly the prose fields, and flags them with no key', () => {
    // The whole point: the same code path that answered `Net 60` from the PO
    // above cannot parse "within sixty (60) days", so it escalates.
    expect(r.paymentTermsDays).toBeNull();
    expect(r.specialTerms).toEqual([]);
    expect(r.reviewReasons).toContain('FIELD_NOT_FOUND');
    expect(r.reviewReasons).toContain('UNMATCHED_CUSTOMER');
  });
});

describe('an EXISTING customer sending a type they have not sent before', () => {
  it('resolves to that type\'s base profile, with no new configuration', async () => {
    // Profiles are keyed (customer, doc_type). Acme has only an order_form
    // profile, so an Acme purchase order falls back to purchase_order/_base.
    const resolved = await resolveProfile(1, 'purchase_order');
    expect(resolved).not.toBeNull();
    expect((resolved!.definition as { doc_type: string }).doc_type).toBe('purchase_order');
  });
});

describe('what goes wrong, and how it is surfaced', () => {
  it('a total that does not match its items is FLAGGED, never silently stored', async () => {
    const r = await extract(docs.purchaseOrderWithBadTotal());
    expect(money(r.amount)).toBe(99999);
    expect(r.items).toHaveLength(1);
    // Everything persists; the discrepancy is reported rather than resolved.
    expect(r.reviewReasons).toContain('TOTAL_MISMATCH');
    expect(r.reviewNotes.join(' ')).toMatch(/99999|10000/);
  });

  it('a bare $ with no ISO code anywhere is AMBIGUOUS, not guessed', async () => {
    // Never inferred from an address: NovaFleet's buyer is in Toronto and its
    // total reads "$451,000 USD".
    const r = await extract(docs.purchaseOrderAmbiguousCurrency());
    expect(money(r.amount)).toBe(10000);
    expect(r.currency).toBeNull();
    expect(r.reviewReasons).toContain('AMBIGUOUS_CURRENCY');
  });

  it('an unrecognised column is reported rather than dropped quietly', async () => {
    const r = await extract(docs.purchaseOrderUnknownColumn());
    expect(r.reviewReasons).toContain('UNMAPPED_COLUMNS');
    // and the columns it DOES understand still come through
    expect(money(r.items[0]!.totalAmount)).toBe(10000);
  });

  it('a document that is neither type is not extracted at all', async () => {
    // Field definitions are per doc type, so there is nothing meaningful to
    // extract. Correctable with PATCH + reprocess.
    const r = await extract(docs.unclassifiableDocument());
    expect(r.docType).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.amount).toBeNull();
    expect(r.reviewNotes.join(' ')).toContain('document type could not be determined');
  });

  it('a PDF with no text layer yields nothing to work with', async () => {
    // The ingest path turns this into NO_TEXT_LAYER and fails fast; here it is
    // the parse result that matters — empty, rather than hallucinated.
    const parsed = await parsePdfBytes(docs.pdfWithNoText());
    expect(parsed.rawText.trim()).toBe('');
    expect(parsed.pages[0]?.runs ?? []).toEqual([]);
  });
});

describe('registering the new customer is the fix that scales', () => {
  it('a matching pattern turns `unmatched` into `matched`, nothing else changes', async () => {
    const bytes = docs.newCustomerPurchaseOrder();
    const before = await extract(bytes);
    expect(before.customerResolution).toBe('unmatched');

    // Exactly what adding them to config/customers.yaml and re-seeding does.
    const withNorthwind = [...customers, { id: 99, slug: 'northwind', name: 'Northwind Logistics Ltd.' }];
    const parsed = await parsePdfBytes(bytes);
    const after = await runExtraction({
      parsed, customers: withNorthwind, patterns, resolveProfile: resolveProfile as never, escalate: null,
    });

    expect(after.customerId).toBe(99);
    expect(after.customerResolution).toBe('matched');
    expect(after.reviewReasons).toEqual([]);          // the only flag is gone
    // Registering changes ROUTING, not extraction: every value is identical.
    expect(after.amount).toBe(before.amount);
    expect(after.items).toEqual(before.items);
    expect(after.parties).toEqual(before.parties);
  });

  it('matches by NORMALISED NAME, so registering needs only the name', async () => {
    // No `match` pattern supplied above — just the name. That is what makes
    // registering a customer a one-line change.
    const parsed = await parsePdfBytes(docs.newCustomerOrderForm());
    const r = await runExtraction({
      parsed,
      customers: [...customers, { id: 98, slug: 'zenith', name: 'zenith cloud, inc.' }],
      patterns, resolveProfile: resolveProfile as never, escalate: null,
    });
    // casefolded, punctuation dropped
    expect(r.customerId).toBe(98);
    expect(r.customerResolution).toBe('matched');
  });
});
