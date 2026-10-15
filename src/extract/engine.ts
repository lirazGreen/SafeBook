import type { Evidence } from '../llm/evidence.ts';

/** How a stored value came to be. Recorded so every value is traceable. */
export type FieldSource =
  | 'rule'          // a deterministic strategy found it on the page
  | 'llm'           // escalated to Claude because the rule failed
  | 'inherited'     // carried down a sparse column (CloudShield's subscription_year)
  | 'filled_down'   // copied from the previous row
  | 'from_document' // an item inherited a document-level value
  | 'from_items';   // a document value derived from min/max of its items

export interface FieldOutcome<T> {
  value: T | null;
  source: FieldSource | null;
  evidence?: Evidence;
  /** A `review_reasons` code, set when the value is absent or untrustworthy. */
  reviewReason?: string;
}

/**
 * Asks Claude for one field. Null in phase 2 (and whenever no API key is set),
 * which makes escalation a no-op rather than an error — the service then runs
 * deterministic-only, with lower recall on prose fields but no failures.
 */
export type Escalator = (
  field: string,
  sections: string[],
) => Promise<unknown>;

/**
 * Narrows an escalator answer to the scalar `{ value, quote }` shape.
 *
 * The escalator returns `unknown` on purpose. The live path validates against a
 * zod schema inside the SDK call, but the FIXTURE path reads JSON off disk and
 * the special-terms schema returns `{ terms: [...] }` rather than a scalar — so
 * the transport cannot promise one shape and the use site has to check. A
 * hand-edited or stale fixture used to flow straight into the pipeline
 * unvalidated.
 *
 * A null quote returns null here, which is also a bug fix: the schemas allow
 * `{ value: null, quote: null, not_found_reason }` — the explicit "not stated"
 * the prompts ask for — and that used to reach resolveEvidence() as a null.
 */
export function asQuoted(answer: unknown): { value: unknown; quote: string } | null {
  if (answer === null || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (typeof a["quote"] !== "string") return null;
  return { value: a["value"], quote: a["quote"] };
}

export interface ExtractFieldArgs<T> {
  field: string;
  /** Deterministic attempt: label lookup, bullet parse, signature marker, … */
  rule: () => string | null;
  /** Turns raw page text into the stored type, or null if it does not parse. */
  parse: (raw: string) => T | null;
  /** Document sections to send if this escalates. */
  sections: string[];
  escalate: Escalator | null;
  /** Resolves a quote to offsets in raw_text; rejects a hallucinated citation. */
  resolveEvidence: (quote: string) => Evidence | null;
  /** Optional: the parsed value must be supported by the quote it came with. */
  valueSupportedBy?: (quote: string, value: T) => boolean;
}

/**
 * Deterministic-first, escalate on failure.
 *
 * The LLM is never *chosen* — it is *reached*, when the deterministic strategy
 * produces nothing or produces something that fails to parse. Nothing about a
 * customer declares "this field needs an LLM", which is what lets an
 * unconfigured customer work: the document decides, not a human.
 *
 * Verified against the samples: BrightOps and NovaFleet state `Net 30`/`Net 45`
 * literally, so the rule parses and no call happens. Acme's label is present but
 * its value reads "...shall be made in advance of such period. Payment shall be
 * made within thirty (30) days from invoice", which does not parse as `Net xx` —
 * so it escalates. Identical code path, opposite outcome, no configuration.
 */
export async function extractField<T>(args: ExtractFieldArgs<T>): Promise<FieldOutcome<T>> {
  const { field, rule, parse, sections, escalate, resolveEvidence, valueSupportedBy } = args;

  // 1. deterministic
  const raw = rule();
  if (raw !== null) {
    const parsed = parse(raw);
    if (parsed !== null) return { value: parsed, source: 'rule' };
    // A label matched but its text did not parse. That is the signal to escalate,
    // not a failure — it is exactly Acme's payment-terms case.
  }

  // 2. escalate
  if (escalate === null) {
    return { value: null, source: null, reviewReason: 'FIELD_NOT_FOUND' };
  }
  const answer = asQuoted(await escalate(field, sections));
  if (answer === null) {
    // Covers both a refusal and the explicit `{ value: null, quote: null }` the
    // prompts ask for in preference to a guess.
    return { value: null, source: null, reviewReason: 'FIELD_NOT_FOUND' };
  }

  // 3. the citation must exist in the document
  const evidence = resolveEvidence(answer.quote);
  if (evidence === null) {
    return { value: null, source: null, reviewReason: 'LLM_EVIDENCE_MISMATCH' };
  }

  // 4. and the value must be supported by that citation
  const parsed = typeof answer.value === 'string' ? parse(answer.value) : (answer.value as T);
  if (parsed === null || parsed === undefined) {
    return { value: null, source: null, reviewReason: 'FIELD_NOT_FOUND' };
  }
  if (valueSupportedBy && !valueSupportedBy(answer.quote, parsed)) {
    return { value: null, source: null, reviewReason: 'VALUE_NOT_IN_EVIDENCE' };
  }

  return { value: parsed, source: 'llm', evidence };
}

/**
 * Fields that may escalate. The item TABLE never does: it is geometry rather
 * than language, reconstruction is self-checking through `Σ items == amount`,
 * and an LLM would be strictly worse at it.
 */
export const ESCALATABLE_FIELDS = new Set([
  'start_date', 'end_date', 'amount', 'payment_terms_days',
  'billing_frequency', 'billing_address', 'special_terms', 'doc_type',
  // Signature presence escalates too. signatureMarker returns NULL when it finds
  // no marker at all — "we could not tell" rather than "it is unsigned" — and
  // that null has to reach something. Acme has no "Buyer Signature:" label; its
  // two-column block needs either a strategy (phase 5) or this escalation.
  'buyer_signature_present', 'vendor_signature_present',
  // "Who issued this?" escalates too, when all three deterministic methods
  // fail (PO title, PO buyer label, signature-line subtraction). Safe because
  // the answer is matched against a CLOSED SET of registered customers: an
  // invented or unrecognised name degrades to unmatched + the base profile,
  // never to a WRONG profile. The dangerous failure is naming the counterparty
  // instead, so the prompt states the role and the result is cross-checked.
  'issuer_name',
]);

/**
 * Rejects an escalated issuer name that is really the counterparty.
 *
 * On a PO the issuer is the buyer; naming the vendor would route the document to
 * the wrong customer's profile if that vendor happened to be registered. This is
 * the one issuer failure mode the closed-set lookup does NOT catch, because a
 * counterparty name is a real organisation that may well be registered.
 */
export function issuerIsNotCounterparty(
  issuerName: string,
  counterpartyName: string | null,
  normalise: (s: string) => string,
): boolean {
  if (counterpartyName === null) return true;
  const a = normalise(issuerName);
  const b = normalise(counterpartyName);
  if (a.length === 0 || b.length === 0) return true;
  return !(a === b || a.startsWith(b) || b.startsWith(a));
}
