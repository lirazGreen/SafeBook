import { describe, expect, it } from 'vitest';
import { fixtureKey, FixtureMissError } from '../../src/llm/fixtures.ts';
import { isEscalatableField, SCHEMAS } from '../../src/llm/schemas.ts';

/**
 * Fixtures are a TESTING artifact, not a service path: a fixture key hashes the
 * INPUT TEXT, so a genuinely new document can only ever miss. The service runs
 * in `live`; `fixture` exists so tests and the accuracy run are offline and
 * reproducible.
 */
describe('fixture keying', () => {
  const base = ['payment_terms_days', 'claude-opus-5', 'INSTRUCTION', 'INPUT'] as const;

  it('is stable for identical inputs', () => {
    expect(fixtureKey(...base)).toBe(fixtureKey(...base));
  });

  it('changes when the PROMPT changes — the whole point', () => {
    // Keying on the field name alone would replay an OLD response against a
    // CHANGED prompt: tests would pass while live behaviour differed, and the
    // accuracy number would describe a prompt that no longer exists.
    expect(fixtureKey('payment_terms_days', 'claude-opus-5', 'INSTRUCTION v2', 'INPUT'))
      .not.toBe(fixtureKey(...base));
  });

  it('changes when the model, field or input changes', () => {
    expect(fixtureKey('payment_terms_days', 'claude-sonnet-5', 'INSTRUCTION', 'INPUT')).not.toBe(fixtureKey(...base));
    expect(fixtureKey('billing_frequency', 'claude-opus-5', 'INSTRUCTION', 'INPUT')).not.toBe(fixtureKey(...base));
    expect(fixtureKey('payment_terms_days', 'claude-opus-5', 'INSTRUCTION', 'OTHER')).not.toBe(fixtureKey(...base));
  });

  it('a miss names the field and how to re-record', () => {
    const err = new FixtureMissError('abc123', 'payment_terms_days', 'Payment Terms: ...');
    expect(err.message).toContain('payment_terms_days');
    expect(err.message).toContain('LLM_MODE=record');
  });
});

describe('output schemas', () => {
  it('cover exactly the fields that can escalate', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([
      'billing_frequency', 'doc_type', 'issuer_name', 'payment_terms_days', 'special_terms',
    ]);
    expect(isEscalatableField('payment_terms_days')).toBe(true);
    expect(isEscalatableField('product_name')).toBe(false); // the item table never escalates
  });

  it('allow an explicit null with a reason, rather than forcing a guess', () => {
    // CloudShield genuinely has no Technical Account Manager term
    const r = SCHEMAS.payment_terms_days.safeParse({
      value: null, quote: null, not_found_reason: 'the excerpt states no net payment period',
    });
    expect(r.success).toBe(true);
  });

  it('require a quote on every special term', () => {
    expect(SCHEMAS.special_terms.safeParse({ terms: [{ term_type: 'burst', ordinal: 1, percent: 10, cap_value: null, cap_unit: null, period: null, applies_to: null }] }).success).toBe(false);
    expect(SCHEMAS.special_terms.safeParse({ terms: [{ term_type: 'burst', ordinal: 1, percent: 10, cap_value: null, cap_unit: null, period: null, applies_to: null, quote: 'up to 10%' }] }).success).toBe(true);
  });

  it('model SEVERAL terms from one paragraph — CloudShield states three burst rates', () => {
    const r = SCHEMAS.special_terms.safeParse({
      terms: [38.89, 28.21, 19.05].map((percent, i) => ({
        term_type: 'burst', ordinal: 1, percent, cap_value: 280000, cap_unit: 'Billable Units',
        period: 'subscription_year', applies_to: 'CloudShield Enterprise',
        quote: `during Year ${i + 1}, up to ${percent}%`,
      })),
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.terms).toHaveLength(3);
  });

  it('carries NO confidence field — nothing gates on self-reported confidence', () => {
    const parsed = SCHEMAS.payment_terms_days.safeParse({
      value: 30, quote: 'thirty (30) days', not_found_reason: null, confidence: 0.95,
    });
    // zod strips the unknown key rather than storing it
    expect(parsed.success && 'confidence' in parsed.data).toBe(false);
  });
});

describe('zero fixtures are needed while only POs are scored', () => {
  it('neither PO escalates, so fixture mode passes with an empty fixture dir', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir('tests/fixtures/llm').catch(() => [] as string[]);
    const json = files.filter((f) => f.endsWith('.json'));
    // If this ever fails it means a PO started escalating, which is a finding in
    // itself — not something to paper over by adding a fixture.
    expect(json).toEqual([]);
  });
});
