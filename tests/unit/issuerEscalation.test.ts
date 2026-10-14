import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ESCALATABLE_FIELDS, extractField, issuerIsNotCounterparty } from '../../src/extract/engine.ts';
import { inferIssuer, matchCustomerByName, normaliseOrgName } from '../../src/classify/inferIssuer.ts';
import { evidenceResolver } from '../../src/llm/evidence.ts';
import { issuerInstruction } from '../../src/llm/prompts/issuer.ts';

const text = (s: string) => readFileSync(`tests/fixtures/text/${s}.txt`, 'utf8');
const REGISTRY = [
  { id: 1, slug: 'acme', name: 'Acme' },
  { id: 2, slug: 'cloudshield', name: 'CloudShield Security, Inc.' },
  { id: 3, slug: 'brightops', name: 'BrightOps Analytics Ltd.' },
  { id: 4, slug: 'novafleet', name: 'NovaFleet Technologies Inc.' },
];

describe('issuer escalation', () => {
  it('is escalatable, so a layout defeating all three rules still gets asked', () => {
    expect(ESCALATABLE_FIELDS.has('issuer_name')).toBe(true);
  });

  it('does NOT escalate for the four samples — the rules already succeed', async () => {
    for (const slug of ['acme', 'cloudshield', 'brightops', 'novafleet']) {
      const raw = text(slug);
      const docType = slug.startsWith('acme') || slug.startsWith('cloud') ? 'order_form' : 'purchase_order';
      const escalate = vi.fn();
      const out = await extractField<string>({
        field: 'issuer_name',
        rule: () => inferIssuer(raw, docType as never).name,
        parse: (s) => s,
        sections: ['signature'],
        escalate,
        resolveEvidence: () => null,
      });
      expect(out.source, slug).toBe('rule');
      expect(escalate, slug).not.toHaveBeenCalled();
    }
  });

  it('escalates when every deterministic method fails', async () => {
    // no PO title, no Buyer heading, no signature block, no preamble
    const odd = 'ACQUISITION SCHEDULE\nref 99-X\nsupplied under framework terms\nitems follow';
    expect(inferIssuer(odd, 'purchase_order').name).toBeNull();

    const escalate = vi.fn().mockResolvedValue({
      value: 'Globex Ltd.', quote: 'supplied under framework terms',
    });
    const out = await extractField<string>({
      field: 'issuer_name',
      rule: () => inferIssuer(odd, 'purchase_order').name,
      parse: (s) => s,
      sections: ['signature'],
      escalate,
      resolveEvidence: (q) => evidenceResolver(odd).resolve(q),
    });
    expect(escalate).toHaveBeenCalledOnce();
    expect(out.value).toBe('Globex Ltd.');
    expect(out.source).toBe('llm');
  });

  it('an invented name cannot route anywhere: the closed set rejects it', () => {
    // even if Claude hallucinated a name, matching is against registered customers
    expect(matchCustomerByName('Totally Made Up GmbH', REGISTRY)).toBeNull();
  });

  it('rejects naming the COUNTERPARTY — the one failure the closed set misses', () => {
    // On BrightOps' PO the issuer is the buyer. If Claude returned the vendor
    // and that vendor were registered, we would route to the wrong profile.
    expect(issuerIsNotCounterparty('DataPulse Software Inc.', 'DataPulse Software Inc.', normaliseOrgName)).toBe(false);
    expect(issuerIsNotCounterparty('BrightOps Analytics Ltd.', 'DataPulse Software Inc.', normaliseOrgName)).toBe(true);
    // tolerant of punctuation/case differences
    expect(issuerIsNotCounterparty('datapulse software inc', 'DataPulse Software Inc.', normaliseOrgName)).toBe(false);
  });

  it('names the role explicitly in the prompt, because it inverts by doc type', () => {
    expect(issuerInstruction('purchase_order')).toMatch(/issued BY THE BUYER/);
    expect(issuerInstruction('purchase_order')).toMatch(/Do NOT return the vendor/);
    expect(issuerInstruction('order_form')).toMatch(/issued BY THE SELLER/);
    expect(issuerInstruction('order_form')).toMatch(/Do NOT return the customer or buyer/);
  });
});
