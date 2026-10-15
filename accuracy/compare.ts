import type { ExtractionResult } from '../src/extract/pipeline.ts';

/**
 * Scoring one document against hand-read ground truth.
 *
 * Extracted from score.ts so the harness and `tests/accuracy/kpi.test.ts` share
 * ONE comparison, rather than the printed number and the build-breaking
 * assertion drifting apart.
 */
export type Verdict = 'pass' | 'fail' | 'pending';

export interface Comparison {
  field: string;
  expected: unknown;
  actual: unknown;
  verdict: Verdict;
}

export interface Expected {
  file: string;
  /**
   * Fields whose deterministic rule cannot succeed on this document, so they
   * reach Claude. Declared rather than derived, for two reasons: it documents
   * the design claim ("5 escalations across 2 documents, 2 documents need zero
   * calls") where a reviewer can check it, and it is what lets the harness tell
   * "no fixture recorded yet" apart from "the parser is wrong".
   *
   * Both purchase orders declare NONE, and a test asserts that.
   */
  _escalates?: string[];
  document: Record<string, unknown>;
  parties: Record<string, Record<string, unknown>>;
  typeDetails: Record<string, unknown>;
  items: Record<string, unknown>[];
  specialTerms: Record<string, unknown>[];
}

/** Keys beginning with `_` are notes for the reader, not values to score. */
const scored = (o: Record<string, unknown>) =>
  Object.entries(o).filter(([k]) => !k.startsWith('_'));

/** Money and quantities are decimal strings; 72000 and "72000.00" are equal. */
export function equal(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === 'string' && typeof actual === 'string') {
    const en = Number(expected);
    const an = Number(actual);
    if (!Number.isNaN(en) && !Number.isNaN(an)) return Math.abs(en - an) < 0.005;
    return expected.trim() === actual.trim();
  }
  return expected === actual;
}

/**
 * Which escalating fields got no answer at all.
 *
 * A declared escalation that came back empty is **pending a fixture**, not a
 * parser failure — `LLM_MODE=off` (no API key) is the documented graceful
 * degradation, and reporting it as a miss would blame the extractor for a
 * missing key. But it is NOT a pass either: see the KPI rule in score.ts.
 */
function unanswered(exp: Expected, got: ExtractionResult): Set<string> {
  const out = new Set<string>();
  for (const field of exp._escalates ?? []) {
    if (field === 'specialTerms') {
      if (got.specialTerms.length === 0) out.add(field);
      continue;
    }
    if ((got as unknown as Record<string, unknown>)[field] === null) out.add(field);
  }
  return out;
}

export function compareDocument(
  exp: Expected,
  got: ExtractionResult,
  slug: string | null,
  /** False when the run had no escalator, which is when the check below is valid. */
  ranWithEscalator = false,
): Comparison[] {
  const pending = unanswered(exp, got);
  const actual: Record<string, unknown> = {
    docType: got.docType,
    customerSlug: slug,
    startDate: got.startDate,
    endDate: got.endDate,
    amount: got.amount,
    currency: got.currency,
    paymentTermsDays: got.paymentTermsDays,
    billingFrequency: got.billingFrequency,
  };

  const out: Comparison[] = scored(exp.document).map(([k, v]) => ({
    field: k,
    expected: v,
    actual: actual[k],
    verdict: pending.has(k) ? 'pending' : equal(v, actual[k]) ? 'pass' : 'fail',
  }));

  for (const [role, fields] of Object.entries(exp.parties)) {
    const party = got.parties.find((p) => p.role === role);
    for (const [k, v] of scored(fields)) {
      const a = party === undefined ? null : (party as unknown as Record<string, unknown>)[k];
      out.push({ field: `${role}.${k}`, expected: v, actual: a, verdict: equal(v, a) ? 'pass' : 'fail' });
    }
  }

  for (const [k, v] of scored(exp.typeDetails)) {
    const a = got.typeDetails[k] ?? null;
    out.push({ field: `type.${k}`, expected: v, actual: a, verdict: equal(v, a) ? 'pass' : 'fail' });
  }

  const n = Math.max(exp.items.length, got.items.length);
  for (let i = 0; i < n; i++) {
    const e = exp.items[i];
    const a = got.items[i] as unknown as Record<string, unknown> | undefined;
    if (e === undefined) {
      out.push({ field: `item[${i}]`, expected: '(no item)', actual: 'extra item', verdict: 'fail' });
      continue;
    }
    for (const [k, v] of scored(e)) {
      const av = a?.[k] ?? null;
      out.push({ field: `item[${i}].${k}`, expected: v, actual: av, verdict: equal(v, av) ? 'pass' : 'fail' });
    }
  }

  out.push(...compareTerms(exp, got, pending.has('specialTerms')));

  // The declaration is SELF-CHECKING. A field listed in `_escalates` that the
  // deterministic rule actually answered is a stale declaration, and silently
  // trusting it would hand that field a permanent 'pending' — i.e. it would be
  // excluded from the KPI forever on the strength of a comment.
  for (const field of exp._escalates ?? []) {
    const answered = field === 'specialTerms'
      ? got.specialTerms.length > 0
      : (got as unknown as Record<string, unknown>)[field] !== null;
    if (answered && !ranWithEscalator) {
      out.push({
        field: `_escalates.${field}`,
        expected: 'needs the model (declared)',
        actual: 'the deterministic rule answered it',
        verdict: 'fail',
      });
    }
  }
  return out;
}

/**
 * Special terms are matched by (termType, percent) and CONSUMED, because one
 * paragraph can yield several rows: CloudShield's burst clause states a
 * different percentage for each of three subscription years, so matching by
 * type alone would let one correct row satisfy all three expectations.
 *
 * `absent: true` asserts a type is NOT present. CloudShield genuinely has no
 * Technical Account Manager term, and an explicit absence is a real answer —
 * which is why the column must be nullable. It is only scored once the section
 * has actually been extracted, though: with no escalator the list is empty and
 * every absence would pass for free.
 */
function compareTerms(exp: Expected, got: ExtractionResult, pending: boolean): Comparison[] {
  const available = [...got.specialTerms];
  return exp.specialTerms.map((e, i) => {
    const type = String(e['termType']);
    const label = `term[${i}].${type}`;
    if (e['absent'] === true) {
      const found = available.find((t) => t.termType === type);
      return {
        field: `${label} (absent)`,
        expected: 'no such term',
        actual: found === undefined ? 'absent' : `present ${found.percent ?? ''}`,
        verdict: pending ? 'pending' : found === undefined ? 'pass' : 'fail',
      };
    }
    const idx = available.findIndex((t) => t.termType === type && equal(e['percent'], t.percent));
    const matched = idx === -1 ? undefined : available.splice(idx, 1)[0];
    return {
      field: label,
      expected: `${type}${e['percent'] === null ? '' : ` ${String(e['percent'])}%`}`,
      actual: matched === undefined ? '(missing)' : `${matched.termType}${matched.percent === null ? '' : ` ${matched.percent}%`}`,
      verdict: pending ? 'pending' : matched === undefined ? 'fail' : 'pass',
    };
  });
}
