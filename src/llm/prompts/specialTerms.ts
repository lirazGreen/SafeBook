/**
 * The harder of the two calls, for three reasons visible in the samples:
 *
 * 1. Order forms number their special terms but never LABEL them. Acme's two
 *    terms are just "1." and "2." — nothing says "Burst" or "Technical Account
 *    Manager", so each paragraph has to be classified by meaning.
 *    (POs do label them, and use a deterministic strategy instead of this call.)
 *
 * 2. ONE paragraph can yield SEVERAL terms. CloudShield's burst clause contains
 *    three percentages — 38.89% for Year 1, 28.21% for Year 2, 19.05% for Year 3
 *    — so the output is a list, not one object per paragraph.
 *
 * 3. The vocabulary is open. CloudShield has eight terms of which only one is
 *    burst and none is a TAM; the other seven are a free trial, tiered pricing,
 *    conversion rights, a renewal cap, a prepaid credit and an SLA deadline.
 *    Unrecognised terms are kept as 'unknown' rather than dropped.
 */
export const SPECIAL_TERMS_INSTRUCTION = `Extract every special term in this excerpt.

Return a LIST. One paragraph may produce several entries — if a clause states a
different percentage for each year of the term, emit one entry per year.

For each entry set \`term_type\` to one of:
  burst                      - a right to exceed the purchased quantity at no extra cost
  technical_account_manager  - a named person or role assigned to support the customer
  free_trial                 - use of something at no charge for a bounded period
  tiered_pricing             - unit prices that change by volume band
  conversion_right           - a right to exchange one unit type for another
  renewal_cap                - a limit on price increases at renewal
  credit                     - a monetary credit applied to the customer
  sla                        - a service-level commitment or a deadline to agree one
  unknown                    - anything else. Use this rather than forcing a fit.

Then, where the clause states them:
  percent      the percentage, as a number ("up to 38.89%" -> 38.89)
  cap_value    an absolute ceiling, as a number
  cap_unit     what the ceiling counts ("Billable Units", "workloads")
  period       what the allowance resets over: subscription_year | contract_year |
               24_months | contract_term
  applies_to   the product the clause names, copied as written
  ordinal      the term's number in the document ("1.", "2.", ...)

Classify on MEANING, not on wording. A clause can describe a role of this kind
without ever using its usual name — if the customer is assigned a dedicated
person or role for technical support, that is technical_account_manager even if
the phrase "Technical Account Manager" never appears.

Omit a field rather than guessing it. Every entry still needs its verbatim quote.`;

/**
 * Profiles may supply extra wording hints, injected after the instruction.
 * Acme needs this: its TAM term reads "Customer will be assigned a Customer
 * Support Manager and Product Architect" and never says "Technical Account
 * Manager", so the profile declares those synonyms.
 */
export function withSynonyms(instruction: string, synonyms: Record<string, string[]>): string {
  const lines = Object.entries(synonyms)
    .filter(([, list]) => list.length > 0)
    .map(([type, list]) => `  ${type}: ${list.map((s) => `"${s}"`).join(', ')}`);
  if (lines.length === 0) return instruction;
  return `${instruction}

This customer is known to use the following wording for these term types:
${lines.join('\n')}`;
}
