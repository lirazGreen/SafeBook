import { describe, expect, it } from 'vitest';
import { fixtureKey, FixtureMissError, listFixtures } from '../../src/llm/fixtures.ts';
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

describe('the recorded fixtures', () => {
  it('cover exactly the five escalations, and nothing else', async () => {
    // Recorded in one real run against claude-opus-5. This replaces an earlier
    // assertion that the directory was EMPTY, which was correct while only the
    // two POs were scored — neither escalates — and became wrong the moment the
    // order forms entered the set.
    const all = await listFixtures();
    expect(all).toHaveLength(5);
    expect(all.map((f) => f.request.field).sort()).toEqual([
      'billing_frequency',        // CloudShield states it only in prose
      'payment_terms_days',       // Acme
      'payment_terms_days',       // CloudShield
      'special_terms',            // Acme — numbered prose, no labels
      'special_terms',            // CloudShield — eight paragraphs
    ]);
  });

  it('are REAL recordings, not hand-written placeholders', async () => {
    // The distinction the accuracy number rests on. A hand-written fixture would
    // score the pipeline against an invention of what the model says, so
    // `provisional` exists to mark one and nothing may carry it.
    const all = await listFixtures();
    expect(all.filter((f) => f.provisional === true)).toEqual([]);
    for (const f of all) expect(f.request.model).toBe('claude-opus-5');
  });

  it('are keyed on the PROMPT, so editing one invalidates its recording', async () => {
    // Keying on the field alone would replay an old response against a changed
    // prompt: tests would pass while live behaviour differed, and the printed
    // accuracy number would describe a prompt that no longer exists.
    const all = await listFixtures();
    for (const f of all) {
      // The filename IS the key, and the key hashes the instruction — so a
      // recorded file cannot be reused under a different prompt.
      expect(f.request.instruction_sha).toBe(f.key);
    }
    expect(new Set(all.map((f) => f.key)).size).toBe(5);

    // And the derivation is sensitive to the instruction, demonstrably: two
    // calls differing ONLY in prompt text land on different keys.
    const sample = all[0]!;
    expect(fixtureKey(sample.request.field, sample.request.model, 'PROMPT A', sample.request.input))
      .not.toBe(fixtureKey(sample.request.field, sample.request.model, 'PROMPT B', sample.request.input));
  });

  it('answered the hardest field in the set correctly', async () => {
    // CloudShield's burst clause is ~190 words carrying three percentages, a
    // 280,000-unit cap AND a $275,000 figure that is NOT the cap. "First
    // percentage" and "first money value" both give wrong answers, so this is
    // the one field where a real recording proves something a mock could not.
    const all = await listFixtures();
    const cloudshield = all
      .filter((f) => f.request.field === 'special_terms')
      .map((f) => f.response as { terms: { term_type: string; percent: number | null; cap_value: number | null }[] })
      .find((r) => r.terms.some((t) => t.percent === 38.89));
    expect(cloudshield).toBeDefined();

    const burst = cloudshield!.terms.filter((t) => t.term_type === 'burst');
    expect(burst.map((t) => t.percent).filter((p) => p !== null).sort((a, b) => b! - a!))
      .toEqual([38.89, 28.21, 19.05]);
    expect(burst.some((t) => t.cap_value === 280000)).toBe(true);
    // and it did NOT mistake the Premium Support cap for the burst cap
    expect(burst.some((t) => t.cap_value === 275000)).toBe(false);
  });
});
