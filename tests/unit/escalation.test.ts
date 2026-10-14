import { describe, expect, it, vi } from 'vitest';
import { extractField } from '../../src/extract/engine.ts';
import { evidenceResolver } from '../../src/llm/evidence.ts';
import { valueAppearsIn } from '../../src/llm/evidence.ts';
import { readFileSync } from 'node:fs';

const acme = readFileSync('tests/fixtures/text/acme.txt', 'utf8');
const netXx = (raw: string) => { const m = /\bNet\s+(\d+)\b/i.exec(raw); return m ? Number(m[1]) : null; };

/** The real "Payment Terms:" values from the four documents. */
const PAYMENT_TERMS_TEXT = {
  brightops: 'Net 30',
  novafleet: 'Net 45',
  acme: 'Payment of the Total Subscription Fee shall be made in advance of such period. Payment shall be made within thirty (30) days from invoice.',
  cloudshield: "Payment will be made within forty-five (45) days of Customer's receipt of an invoice.",
};

describe('the LLM is reached, never chosen', () => {
  it('POs parse deterministically, so Claude is never called', async () => {
    for (const slug of ['brightops', 'novafleet'] as const) {
      const escalate = vi.fn();
      const out = await extractField({
        field: 'payment_terms_days',
        rule: () => PAYMENT_TERMS_TEXT[slug],
        parse: netXx,
        sections: ['Payment Terms'],
        escalate,
        resolveEvidence: () => null,
      });
      expect(out.value).toBe(slug === 'brightops' ? 30 : 45);
      expect(out.source).toBe('rule');
      expect(escalate).not.toHaveBeenCalled();   // <- the point
    }
  });

  it('order forms escalate: the label matched but its text does not parse', async () => {
    const escalate = vi.fn().mockResolvedValue({
      value: 30,
      quote: 'Payment shall be made within thirty (30) days from invoice.',
    });
    const out = await extractField({
      field: 'payment_terms_days',
      rule: () => PAYMENT_TERMS_TEXT.acme,   // label IS present...
      parse: netXx,                          // ...but no "Net xx" in it
      sections: ['Payment Terms'],
      escalate,
      resolveEvidence: (q) => evidenceResolver(acme).resolve(q),
      valueSupportedBy: valueAppearsIn,
    });
    expect(escalate).toHaveBeenCalledOnce();
    expect(out.value).toBe(30);
    expect(out.source).toBe('llm');
    expect(out.evidence?.text).toContain('thirty (30) days');
  });

  it('escalates when the label is absent entirely (unknown customer wording)', async () => {
    const escalate = vi.fn().mockResolvedValue({
      value: 30, quote: 'Payment shall be made within thirty (30) days from invoice.',
    });
    const out = await extractField({
      field: 'payment_terms_days',
      rule: () => null,                      // no label matched at all
      parse: netXx,
      sections: ['Payment Terms'],
      escalate,
      resolveEvidence: (q) => evidenceResolver(acme).resolve(q),
    });
    expect(escalate).toHaveBeenCalledOnce();
    expect(out.value).toBe(30);
  });
});

describe('without an escalator the service still runs, with lower recall', () => {
  it('flags rather than failing when there is no API key (phase 2 behaviour)', async () => {
    const out = await extractField({
      field: 'payment_terms_days',
      rule: () => PAYMENT_TERMS_TEXT.acme,
      parse: netXx,
      sections: ['Payment Terms'],
      escalate: null,                        // <- no Claude available
      resolveEvidence: () => null,
    });
    expect(out.value).toBeNull();
    expect(out.reviewReason).toBe('FIELD_NOT_FOUND');
  });
});

describe('an escalated value must survive both evidence checks', () => {
  it('rejects a hallucinated citation', async () => {
    const out = await extractField({
      field: 'payment_terms_days',
      rule: () => null,
      parse: netXx,
      sections: ['Payment Terms'],
      escalate: async () => ({ value: 90, quote: 'Payment is due within ninety (90) days.' }),
      resolveEvidence: (q) => evidenceResolver(acme).resolve(q),
    });
    expect(out.value).toBeNull();
    expect(out.reviewReason).toBe('LLM_EVIDENCE_MISMATCH');
  });

  it('rejects a value its own citation does not support', async () => {
    const out = await extractField({
      field: 'payment_terms_days',
      // real quote, wrong answer
      rule: () => null,
      parse: netXx,
      sections: ['Payment Terms'],
      escalate: async () => ({
        value: 60, quote: 'Payment shall be made within thirty (30) days from invoice.',
      }),
      resolveEvidence: (q) => evidenceResolver(acme).resolve(q),
      valueSupportedBy: valueAppearsIn,
    });
    expect(out.value).toBeNull();
    expect(out.reviewReason).toBe('VALUE_NOT_IN_EVIDENCE');
  });
});

describe('the escalatable set matches what the strategies actually need', () => {
  it('includes signature presence, because signatureMarker returns null to escalate', async () => {
    const { ESCALATABLE_FIELDS } = await import('../../src/extract/engine.ts');
    const { signatureMarker } = await import('../../src/extract/strategies/locate.ts');
    const acmeText = readFileSync('tests/fixtures/text/acme.txt', 'utf8');

    // Acme has no "Buyer Signature:" label — it uses a two-column block
    expect(signatureMarker(acmeText, ['Buyer Signature'])).toBeNull();
    // ...so that null must have somewhere to go
    expect(ESCALATABLE_FIELDS.has('buyer_signature_present')).toBe(true);
  });

  it('excludes the item table: geometry, self-checked by the reconciliation', async () => {
    const { ESCALATABLE_FIELDS } = await import('../../src/extract/engine.ts');
    for (const f of ['items', 'product_name', 'quantity', 'unit_price', 'total_amount']) {
      expect(ESCALATABLE_FIELDS.has(f)).toBe(false);
    }
  });
});
