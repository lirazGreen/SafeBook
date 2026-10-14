import type { ItemRecord } from './items.ts';

/**
 * Validation NEVER blocks persistence. Everything it finds is recorded as a
 * `review_reasons` code on a document that is still written in full — partial
 * data with a flag beats no data. The cases where nothing can be persisted
 * (PDF_CORRUPT, NO_TEXT_LAYER, NO_ACTIVE_PROFILE) are pipeline failures that
 * never reach here.
 */
export type ReviewReason =
  | 'TOTAL_MISMATCH' | 'ITEM_ARITHMETIC' | 'MISSING_REQUIRED_FIELD' | 'NO_ITEMS_FOUND'
  | 'DATE_OUT_OF_RANGE' | 'DATE_RANGE_REVERSED' | 'DATE_ENVELOPE_MISMATCH'
  | 'NEGATIVE_AMOUNT' | 'NEGATIVE_QUANTITY' | 'MIXED_CURRENCY' | 'AMBIGUOUS_CURRENCY'
  | 'INFERRED_VALUES' | 'UNMATCHED_CUSTOMER' | 'AMBIGUOUS_CUSTOMER'
  | 'BURST_UNATTRIBUTED' | 'LLM_EVIDENCE_MISMATCH' | 'VALUE_NOT_IN_EVIDENCE'
  | 'FIELD_NOT_FOUND' | 'ISSUER_MISMATCH' | 'UNMAPPED_COLUMNS';

export interface ValidationInput {
  amount: string | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
  items: ItemRecord[];
  /** Per-item formula from the profile; CloudShield prices monthly. */
  reconcile?: string | undefined;
  tolerance?: number | undefined;
  tolerancePct?: number | undefined;
  requiredFields?: string[] | undefined;
  presentFields?: Set<string> | undefined;
}

export interface ValidationResult {
  reasons: ReviewReason[];
  /** Human-readable detail per reason, for the review queue. */
  notes: string[];
}

const dec = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

/**
 * Evaluates the profile's reconcile expression. Deliberately a tiny evaluator
 * over named item fields rather than `eval`: the expression comes from config,
 * and config should not be able to execute arbitrary code.
 */
function evaluateReconcile(expr: string, item: ItemRecord): number | null {
  const vars: Record<string, number | null> = {
    quantity: dec(item.quantity),
    unit_price: dec(item.unitPrice),
    total_amount: dec(item.totalAmount),
    order_term_months: dec(item.attributes['order_term_months'] ?? null),
  };
  const factors = expr.split('*').map((s) => s.trim());
  let product = 1;
  for (const f of factors) {
    const v = vars[f];
    // unknown name, or a factor we could not read: cannot evaluate, so skip the
    // check rather than invent a comparison
    if (v === undefined || v === null || Number.isNaN(v)) return null;
    product *= v;
  }
  return product;
}

export function validate(input: ValidationInput): ValidationResult {
  const reasons: ReviewReason[] = [];
  const notes: string[] = [];
  const add = (r: ReviewReason, note: string) => { reasons.push(r); notes.push(`${r}: ${note}`); };

  const amount = dec(input.amount);

  // --- items present at all
  if (input.items.length === 0) {
    add('NO_ITEMS_FOUND', 'no line items were recovered');
  }

  // --- currencies must be comparable before any sum is meaningful
  const currencies = new Set(input.items.map((i) => i.currency).filter((c): c is string => c !== null));
  const mixed = currencies.size > 1;
  if (mixed) add('MIXED_CURRENCY', `items span ${[...currencies].join(', ')}`);
  if (input.items.some((i) => i.currency === null) && input.amount !== null) {
    add('AMBIGUOUS_CURRENCY', 'an item amount carried an ambiguous symbol and no document code resolved it');
  }

  // --- the strongest check: sum of items equals the stated total
  if (amount !== null && input.items.length > 0 && !mixed) {
    const sum = input.items.reduce((t, i) => t + (dec(i.totalAmount) ?? 0), 0);
    if (Math.abs(sum - amount) > 0.01) {
      add('TOTAL_MISMATCH', `items sum to ${sum} but the document states ${amount}`);
    }
  }

  // --- per-item arithmetic, using the profile's own formula
  if (input.reconcile !== undefined) {
    for (const item of input.items) {
      const expected = evaluateReconcile(input.reconcile, item);
      const actual = dec(item.totalAmount);
      if (expected === null || actual === null) continue;
      const absTol = input.tolerance ?? 0.01;
      const pctTol = ((input.tolerancePct ?? 0) / 100) * Math.abs(actual);
      if (Math.abs(expected - actual) > Math.max(absTol, pctTol)) {
        add('ITEM_ARITHMETIC', `line ${item.lineNo}: ${input.reconcile} = ${expected} but total is ${actual}`);
      }
    }
  }

  // --- value checks WARN, never block: a credit note is legitimate
  if (amount !== null && amount < 0) add('NEGATIVE_AMOUNT', `document total is ${amount}`);
  for (const i of input.items) {
    const q = dec(i.quantity);
    if (q !== null && q < 0) add('NEGATIVE_QUANTITY', `line ${i.lineNo} quantity is ${q}`);
  }

  // --- dates
  if (input.startDate !== null && input.endDate !== null && input.endDate < input.startDate) {
    add('DATE_RANGE_REVERSED', `${input.startDate} .. ${input.endDate}`);
  }
  const starts = input.items.map((i) => i.itemStartDate).filter((d): d is string => d !== null);
  const ends = input.items.map((i) => i.itemEndDate).filter((d): d is string => d !== null);
  if (starts.length > 0 && ends.length > 0 && input.startDate !== null && input.endDate !== null) {
    const envStart = starts.reduce((a, b) => (a < b ? a : b));
    const envEnd = ends.reduce((a, b) => (a > b ? a : b));
    if (envStart !== input.startDate || envEnd !== input.endDate) {
      add('DATE_ENVELOPE_MISMATCH',
        `items span ${envStart}..${envEnd} but the document states ${input.startDate}..${input.endDate}`);
    }
  }

  // --- inferred values are surfaced, but group-row inheritance is not a guess
  const inferred = input.items.filter((i) =>
    Object.values(i.fieldSources).some((s) => s === 'filled_down' || s === 'from_document'));
  if (inferred.length > 0) {
    add('INFERRED_VALUES', `${inferred.length} item(s) carry filled-down values`);
  }

  // --- required fields
  for (const f of input.requiredFields ?? []) {
    if (!(input.presentFields ?? new Set()).has(f)) add('MISSING_REQUIRED_FIELD', f);
  }

  return { reasons: [...new Set(reasons)], notes };
}

/**
 * Derives the document's envelope from its items, for use when the document
 * states no dates. Exact on all four samples, which is why it also doubles as a
 * reconciliation check above.
 */
export function dateEnvelope(items: ItemRecord[]): { start: string | null; end: string | null } {
  const starts = items.map((i) => i.itemStartDate).filter((d): d is string => d !== null);
  const ends = items.map((i) => i.itemEndDate).filter((d): d is string => d !== null);
  return {
    start: starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    end: ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null,
  };
}
