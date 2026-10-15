import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { CustomerPattern } from '../../src/classify/issuer.ts';
import { runExtraction, type ExtractionResult } from '../../src/extract/pipeline.ts';
import { parsePdf } from '../../src/pdf/parse.ts';
import { ProfileDefinition } from '../../src/profiles/schema.ts';
import { loadCustomers, loadProfiles, type DocType } from '../../src/profiles/loader.ts';

/**
 * The phase-6 capabilities, asserted END TO END on the real order forms rather
 * than only on their units: `default_currency`, `ignore_sections` + `in_section`,
 * `optional_fields`, `type` coercion, `occurrence`, `pattern`, and the vendor
 * half of the two-column signature block.
 *
 * Each one is here because it was DECLARED in a profile and silently doing
 * nothing. A key that reads as working configuration but has no effect is worse
 * than a missing one, so every one of them gets an assertion that would fail if
 * the wiring were removed.
 *
 * No escalator: these are all deterministic, so the only field that should go
 * unanswered is the prose payment term.
 */
const results: Record<string, ExtractionResult> = {};

beforeAll(async () => {
  const customersYaml = await loadCustomers();
  const customers = customersYaml.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
  const patterns: CustomerPattern[] = customersYaml.flatMap((c, i) =>
    c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })));
  const profiles = await loadProfiles();
  const resolveProfile = async (customerId: number | null, docType: DocType) => {
    const slug = customerId === null ? null : customers.find((c) => c.id === customerId)?.slug ?? null;
    const d = profiles.find((p) => p.docType === docType && p.customerSlug === slug)
      ?? profiles.find((p) => p.docType === docType && p.customerSlug === null);
    return d ? { profileId: 1, definition: d.definition } : null;
  };
  for (const [key, file] of [['acme', 'ACME Order From.pdf'], ['cloudshield', 'CloudShield Order Form.pdf']] as const) {
    const parsed = await parsePdf(join('sample docs', file));
    results[key] = await runExtraction({ parsed, customers, patterns, resolveProfile, escalate: null });
  }
});

describe('default_currency — Acme states no ISO code anywhere', () => {
  it('resolves $ from the profile, not from the billing address', () => {
    // Rule 1 ("exactly one distinct code in the document") finds none, so rule 2
    // applies. NovaFleet is the counterexample for inferring from geography: its
    // buyer is in Toronto and its own total reads "$451,000 USD".
    expect(results.acme!.currency).toBe('USD');
    expect(results.acme!.reviewReasons).not.toContain('AMBIGUOUS_CURRENCY');
  });

  it('reaches the item rows too, so Σ items == amount compares like with like', () => {
    expect(results.acme!.items.map((i) => i.currency)).toEqual(Array(5).fill('USD'));
  });
});

describe('ignore_sections + in_section — CloudShield\'s own PO block', () => {
  it('does not let the decoy become the contract total', () => {
    expect(results.cloudshield!.amount).toBe('23640000.00');
    expect(results.cloudshield!.amount).not.toBe('0.00');
  });

  it('still reads the fields that are ABOUT that block', () => {
    // The mask would otherwise delete the very data it was added to protect.
    const d = results.cloudshield!.typeDetails;
    expect(d['po_amount']).toBe('USD 0.00');
    expect(d['po_required']).toBe(false);   // "… required …? No"  -> type: boolean
  });

  it('is inert on a document with no such block', () => {
    // The base profile declares all three with in_section, so an order form
    // lacking the heading gets nulls rather than a value from elsewhere.
    expect(results.acme!.typeDetails['po_amount']).toBeNull();
    expect(results.acme!.typeDetails['po_required']).toBeNull();
  });
});

describe('type coercion — a declared `type` that was never read', () => {
  it('extracts 36.00 from a label followed by a parenthetical', () => {
    expect(results.cloudshield!.typeDetails['subscription_term_months']).toBe('36.00');
  });

  it('and the date envelope agrees with it — 3/1/2025 to 2/28/2028 is 36 months', () => {
    expect(results.cloudshield!.startDate).toBe('2025-03-01');
    expect(results.cloudshield!.endDate).toBe('2028-02-28');
  });
});

describe('optional_fields and pattern — shapes no label covers', () => {
  it('captures the marketplace from a bare unlabelled line', () => {
    expect(results.cloudshield!.attributes['marketplace']).toBe('Azure Private Offer');
  });

  it('captures the vendor address out of the legal preamble', () => {
    const vendor = results.cloudshield!.parties.find((p) => p.role === 'vendor')!;
    expect(vendor.address).toBe('500 Innovation Drive, San Jose, CA 95134');
  });

  it('captures nothing speculatively — Acme declares no optional fields', () => {
    // This is what bounds natural-language capture: Acme's GDPR sentence and tax
    // note stay in raw_text because no profile asks for them.
    expect(results.acme!.attributes['marketplace']).toBeUndefined();
  });
});

describe('occurrence — one label, two meanings', () => {
  it('separates the billing organisation from the billing contact', () => {
    const buyer = results.cloudshield!.parties.find((p) => p.role === 'buyer')!;
    expect(buyer.name).toBe('TechNova Solutions, Inc.');
    expect(buyer.contactName).toBe('Sarah Thompson');
  });
});

describe('the vendor half of the two-column signature block', () => {
  it('reads Acme\'s left column — the issuer signs an order form', () => {
    const vendor = results.acme!.parties.find((p) => p.role === 'vendor')!;
    expect(vendor.signaturePresent).toBe(true);
    expect(vendor.signerName).toBe('John Smith');
    expect(vendor.signerTitle).toBe('CFO');
    expect(vendor.signatureDate).toBe('2024-12-13');
  });

  it('reads CloudShield\'s as FALSE — the block exists but both columns are blank', () => {
    // Three outcomes from ONE capability: filled => true, placeholders => false,
    // no block at all => null. `placeholder_lines` was never a second strategy.
    for (const role of ['buyer', 'vendor'] as const) {
      expect(results.cloudshield!.parties.find((p) => p.role === role)!.signaturePresent).toBe(false);
    }
  });
});

describe('the retired knobs stay retired', () => {
  it('the schema REJECTS `placeholder_lines`, so a stale key fails loudly', () => {
    // Same policy as header_rows / wrapped_cells: a knob that silently does
    // nothing reads as working configuration, which is worse than a missing one.
    const r = ProfileDefinition.safeParse({
      parties: { buyer: { signature_present: { strategy: 'placeholder_lines' } } },
    });
    expect(r.success).toBe(false);
  });

  it('and still accepts the capability that replaced it', () => {
    expect(ProfileDefinition.safeParse({
      parties: { buyer: { signature_present: { strategy: 'two_column_signature' } } },
    }).success).toBe(true);
  });
});

describe('only the prose field goes unanswered without an escalator', () => {
  it.each(['acme', 'cloudshield'])('%s needs Claude for payment terms and nothing else', (key) => {
    expect(results[key]!.paymentTermsDays).toBeNull();
    expect(results[key]!.reviewReasons).toContain('FIELD_NOT_FOUND');
    // in particular: no longer AMBIGUOUS_CURRENCY, UNMAPPED_COLUMNS or a
    // reconciliation failure
    expect(results[key]!.reviewReasons.filter((r) => r !== 'FIELD_NOT_FOUND')).toEqual([]);
  });
});
