import { describe, expect, it } from 'vitest';
import { scoreAll, totals, type Scored } from '../../accuracy/runner.ts';

/**
 * Turns the brief's ">=95% field accuracy" KPI into a build-breaking assertion,
 * over the SAME comparison the printed number uses — so `npm run accuracy` and
 * `npm test` cannot drift apart.
 *
 * Runs the real pipeline with NO DATABASE and NO API KEY, so it is reproducible
 * from a fresh clone, which is what makes the printed number mean anything.
 *
 * Three verdicts, not two. A `pending` value is a field that MUST escalate and
 * has no recorded fixture yet: that is the documented behaviour with no key, not
 * a defect, so it does not fail the build. It also never counts as a pass — see
 * the KPI case at the bottom.
 */
const scored: Scored[] = await scoreAll();
const byFile = (name: string) => scored.find((s) => s.expected.file.includes(name))!;

describe('accuracy', () => {
  it.each(scored.map((s) => [s.expected.file, s] as const))(
    '%s has no WRONG values — every field either matches or awaits a fixture',
    (_file, s) => {
      const wrong = s.comparisons.filter((c) => c.verdict === 'fail');
      expect(wrong.map((c) => `${c.field}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`))
        .toEqual([]);
    },
  );

  it('scores all four samples', () => {
    expect(scored.map((s) => s.expected.file).sort()).toEqual([
      'ACME Order From.pdf',
      'CloudShield Order Form.pdf',
      'Purchase Order – BrightOps Analytics Ltd.pdf',
      'Purchase Order – NovaFleet Technologies Inc.pdf',
    ]);
  });
});

describe('what needs the model, and what does not', () => {
  it('NEITHER purchase order escalates anything', () => {
    // The claim the whole deterministic-first design rests on: the rules already
    // parse `Net 30`/`Net 45` and the labelled special-term bullets, so these two
    // documents cost nothing to process. Asserted rather than observed.
    for (const name of ['BrightOps', 'NovaFleet']) {
      expect(byFile(name).expected._escalates ?? []).toEqual([]);
      expect(byFile(name).result.escalations).toEqual([]);
      expect(byFile(name).result.llmCalls).toBe(0);
      expect(byFile(name).comparisons.filter((c) => c.verdict !== 'pass')).toEqual([]);
    }
  });

  it('both order forms escalate their PROSE fields and nothing else', () => {
    // Acme and CloudShield state payment terms only in prose, and number their
    // special terms without labelling them. CloudShield additionally states its
    // billing frequency only in prose, where Acme writes it as a plain label —
    // same field, same profile, decided by the document.
    expect(byFile('ACME').expected._escalates).toEqual(['paymentTermsDays', 'specialTerms']);
    expect(byFile('CloudShield').expected._escalates)
      .toEqual(['paymentTermsDays', 'billingFrequency', 'specialTerms']);
  });

  it('5 escalations across 2 documents, as the design claims', () => {
    expect(scored.flatMap((s) => s.expected._escalates ?? [])).toHaveLength(5);
  });

  it('makes ZERO api calls, with or without a key', () => {
    // Nothing in the suite may reach the network. tests/setup/offlineLlm.ts pins
    // LLM_MODE to `fixture`, so an escalation either replays a recording or
    // raises a named miss — it never dials out.
    expect(scored.map((s) => s.result.llmCalls)).toEqual([0, 0, 0, 0]);
  });
});

describe('the KPI', () => {
  const t = totals(scored);

  it('has nothing WRONG across all four documents', () => {
    expect(t.failed).toBe(0);
  });

  it('is withheld, not inflated, while any field awaits a fixture', () => {
    // The one rule that keeps the number honest: a ">=95%" computed over only the
    // fields that did not need a model is a claim about a SMALLER problem than the
    // brief set. So while anything is pending the KPI is reported as not yet
    // measurable — never as a pass.
    //
    // When the fixtures are recorded this flips: pending drops to 0 and the
    // assertion below becomes the real gate.
    if (t.pending > 0) {
      expect(t.passed + t.pending).toBe(t.total);
      return;
    }
    expect(t.pct).toBeGreaterThanOrEqual(95);
  });

  it('reports the deterministic score for the record', () => {
    // 230 / 239 at the time of writing: every value that does not need the model.
    expect(t.passed / t.total).toBeGreaterThan(0.95);
  });
});
