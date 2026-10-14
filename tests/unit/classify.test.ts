import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/classify/docType.ts';
import { resolveIssuer, type CustomerPattern } from '../../src/classify/issuer.ts';

const text = (slug: string) => readFileSync(`tests/fixtures/text/${slug}.txt`, 'utf8');

describe('document type, from content only', () => {
  it.each([
    ['brightops', 'purchase_order'],
    ['novafleet', 'purchase_order'],
    ['acme', 'order_form'],
    ['cloudshield', 'order_form'],
  ])('%s -> %s', (slug, expected) => {
    const r = classify(text(slug));
    expect(r.docType).toBe(expected);
    expect(r.needsEscalation).toBe(false);
  });

  it('is not fooled by CloudShield\'s own "Purchase Order Information" section', () => {
    const raw = text('cloudshield');
    // the trap is really there
    expect(raw).toMatch(/Purchase Order Information/);
    expect(raw).toMatch(/PO Number:/);
    const r = classify(raw);
    expect(r.docType).toBe('order_form');
    // and the PO title signal must NOT have fired, because that phrase is
    // mid-document rather than in the title region
    expect(r.matched.purchase_order).not.toContain('title');
    expect(r.scores.order_form).toBeGreaterThan(r.scores.purchase_order);
  });

  it('a naive substring match WOULD misclassify it — the reason for weighting', () => {
    const raw = text('cloudshield');
    const naive = /purchase order/i.test(raw) ? 'purchase_order' : 'order_form';
    expect(naive).toBe('purchase_order');          // wrong
    expect(classify(raw).docType).toBe('order_form'); // right
  });

  it('scores both POs on the Vendor+Buyer heading pair, which order forms never have', () => {
    for (const slug of ['brightops', 'novafleet']) {
      expect(classify(text(slug)).matched.purchase_order).toContain('vendor_and_buyer_headings');
    }
    for (const slug of ['acme', 'cloudshield']) {
      expect(classify(text(slug)).matched.purchase_order).not.toContain('vendor_and_buyer_headings');
    }
  });

  it('escalates rather than guessing when nothing scores', () => {
    const r = classify('Dear Sir or Madam,\nPlease find enclosed our brochure.\nRegards.');
    expect(r.docType).toBeNull();
    expect(r.needsEscalation).toBe(true);
  });

  it('ignores the filename entirely — "ACME Order From.pdf" misspells "Form"', () => {
    // classification takes only text; there is no filename parameter to pass
    expect(classify(text('acme')).docType).toBe('order_form');
  });
});

describe('issuer resolution', () => {
  const PATTERNS: CustomerPattern[] = [
    { customerId: 1, slug: 'acme', kind: 'signature_block', pattern: '^Acme\\b' },
    { customerId: 2, slug: 'cloudshield', kind: 'text', pattern: 'CloudShield Security, Inc\\.' },
    { customerId: 3, slug: 'brightops', kind: 'text', pattern: 'BrightOps Analytics Ltd\\.' },
    { customerId: 3, slug: 'brightops', kind: 'doc_id', pattern: 'PO-BO-\\d+' },
    { customerId: 4, slug: 'novafleet', kind: 'text', pattern: 'NovaFleet Technologies Inc\\.' },
    { customerId: 4, slug: 'novafleet', kind: 'doc_id', pattern: 'PO-NF-\\d+' },
  ];

  it.each([['brightops', 3], ['novafleet', 4], ['cloudshield', 2], ['acme', 1]])(
    'resolves %s', (slug, id) => {
      const r = resolveIssuer(text(slug), PATTERNS);
      expect(r.resolution).toBe('matched');
      expect(r.customerId).toBe(id);
      expect(r.slug).toBe(slug);
    },
  );

  it('finds Acme ONLY via the signature block — its name occurs once in the document', () => {
    const raw = text('acme');
    expect((raw.match(/\bAcme\b/g) ?? []).length).toBe(1);
    // a whole-text pattern would be too weak to trust; the scoped one works
    expect(resolveIssuer(raw, PATTERNS).slug).toBe('acme');
    // and scoping matters: without the signature_block kind it would not resolve
    const unscoped = PATTERNS.filter((p) => p.slug !== 'acme');
    expect(resolveIssuer(raw, unscoped).resolution).toBe('unmatched');
  });

  it('reports unmatched for an unregistered customer, and still names the issuer', () => {
    const raw = 'Purchase Order – Globex Ltd.\nPurchase Order Number: PO-GX-1\nVendor\nBuyer';
    const r = resolveIssuer(raw, PATTERNS);
    expect(r.resolution).toBe('unmatched');
    expect(r.customerId).toBeNull();
    // this is what a human reads to register them
    expect(r.detectedIssuerName).toBe('Globex Ltd.');
  });

  it('flags ambiguity rather than picking a winner', () => {
    const both: CustomerPattern[] = [
      { customerId: 1, slug: 'a', kind: 'text', pattern: 'BrightOps' },
      { customerId: 2, slug: 'b', kind: 'text', pattern: 'Analytics' },
    ];
    const r = resolveIssuer(text('brightops'), both);
    expect(r.resolution).toBe('ambiguous');
    expect(r.customerId).toBeNull();
    expect(r.candidates.sort()).toEqual(['a', 'b']);
  });
});

describe('the REAL config/customers.yaml resolves all four (catches config/code drift)', () => {
  it('classifies and resolves every sample from the committed config', async () => {
    const { loadCustomers } = await import('../../src/profiles/loader.ts');
    const customers = await loadCustomers();
    const patterns: CustomerPattern[] = customers.flatMap((c, i) =>
      c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })),
    );

    const expected = {
      acme: 'order_form', cloudshield: 'order_form',
      brightops: 'purchase_order', novafleet: 'purchase_order',
    } as const;

    for (const [slug, docType] of Object.entries(expected)) {
      const raw = text(slug);
      expect(classify(raw).docType, slug).toBe(docType);
      const iss = resolveIssuer(raw, patterns);
      expect(iss.resolution, slug).toBe('matched');
      expect(iss.slug, slug).toBe(slug);
    }
  });

  it('separates the two types decisively — no sample is near the escalation margin', async () => {
    const margins = ['acme', 'cloudshield', 'brightops', 'novafleet'].map((s) => {
      const { scores } = classify(text(s));
      return Math.abs(scores.order_form - scores.purchase_order);
    });
    // the escalation threshold is 3; every sample clears it by a wide margin
    expect(Math.min(...margins)).toBeGreaterThanOrEqual(9);
  });
});
