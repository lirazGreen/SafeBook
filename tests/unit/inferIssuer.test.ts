import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/classify/docType.ts';
import { inferIssuer, matchCustomerByName, normaliseOrgName } from '../../src/classify/inferIssuer.ts';
import { loadCustomers } from '../../src/profiles/loader.ts';

const text = (s: string) => readFileSync(`tests/fixtures/text/${s}.txt`, 'utf8');

describe('inferring the ISSUER with no per-customer configuration', () => {
  it.each([
    ['brightops', 'BrightOps Analytics Ltd.'],
    ['novafleet', 'NovaFleet Technologies Inc.'],
    ['acme', 'Acme'],
    ['cloudshield', 'CloudShield Security, Inc.'],
  ])('%s -> %s', (slug, expected) => {
    const raw = text(slug);
    expect(inferIssuer(raw, classify(raw).docType).name).toBe(expected);
  });

  it('a PO states its issuer TWICE, and the two agree — a free cross-check', () => {
    for (const slug of ['brightops', 'novafleet']) {
      const inf = inferIssuer(text(slug), 'purchase_order');
      const methods = inf.candidates.map((c) => c.method);
      expect(methods).toContain('po_title');
      expect(methods).toContain('po_buyer_label');
      const names = new Set(inf.candidates.map((c) => normaliseOrgName(c.name)));
      expect(names.size).toBe(1); // they agree
    }
  });

  it('an order form never states its issuer plainly — subtraction is required', () => {
    // Acme's name occurs ONCE in the whole document, on the shared signature line
    expect((text('acme').match(/\bAcme\b/g) ?? []).length).toBe(1);
    expect(text('acme')).toContain('Acme Appsoft Inc');
    // "Acme Appsoft Inc" minus the buyer "Appsoft Inc." leaves the issuer
    expect(inferIssuer(text('acme'), 'order_form').method).toBe('of_signature_minus_buyer');
    expect(inferIssuer(text('acme'), 'order_form').name).toBe('Acme');
  });

  it('subtracts positionally, so a shared "Inc." suffix is not duplicated', () => {
    // both parties end in "Inc." — token-set filtering yielded
    // "CloudShield Security, Inc. Inc." before this was done by offset
    const inf = inferIssuer(text('cloudshield'), 'order_form');
    expect(inf.name).toBe('CloudShield Security, Inc.');
    expect(inf.name).not.toMatch(/Inc\.\s*Inc/);
    expect(inf.name).not.toMatch(/\s\.$/); // nor an orphan period
  });

  it('CloudShield is corroborated by its legal preamble too', () => {
    const inf = inferIssuer(text('cloudshield'), 'order_form');
    const preamble = inf.candidates.find((c) => c.method === 'of_preamble');
    expect(preamble?.name).toBe('CloudShield Security, Inc.');
    // two independent methods, same answer
    expect(normaliseOrgName(preamble!.name)).toBe(normaliseOrgName(inf.name!));
  });
});

describe('matching an inferred name to a registered customer', () => {
  it('matches all four from the committed config, by NAME not regex', async () => {
    const registry = (await loadCustomers()).map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
    for (const slug of ['brightops', 'novafleet', 'acme', 'cloudshield']) {
      const raw = text(slug);
      const inferred = inferIssuer(raw, classify(raw).docType).name!;
      expect(matchCustomerByName(inferred, registry)?.slug, slug).toBe(slug);
    }
  });

  it('tolerates punctuation and case differences in a registered name', () => {
    const registry = [{ id: 1, slug: 'cs', name: 'CloudShield Security, Inc.' }];
    for (const variant of ['cloudshield security inc', 'CloudShield Security Inc.', 'CLOUDSHIELD SECURITY, INC']) {
      expect(matchCustomerByName(variant, registry)?.slug).toBe('cs');
    }
  });

  it('returns null for an unregistered issuer rather than a near-miss', () => {
    const registry = [{ id: 1, slug: 'acme', name: 'Acme' }];
    expect(matchCustomerByName('Globex Ltd.', registry)).toBeNull();
  });

  it('still names an unregistered issuer, which is what lets a human register it', () => {
    const raw = 'Purchase Order – Globex Ltd.\nPurchase Order Number: PO-GX-1\nVendor\nBuyer\nCompany Name: Globex Ltd.';
    expect(inferIssuer(raw, 'purchase_order').name).toBe('Globex Ltd.');
  });
});
