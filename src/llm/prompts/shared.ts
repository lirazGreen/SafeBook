/**
 * The system prompt is identical for every call and every customer, so it sits
 * behind a `cache_control` breakpoint and is cached across documents. Per-field
 * instructions and the document excerpt go in the user message, after it.
 *
 * Every rule here exists because of something in the four sample documents —
 * see the comments.
 */
export const SYSTEM_PROMPT = `You extract fields from excerpts of commercial contracts (order forms and purchase orders).

Rules:

1. Return a value ONLY if this excerpt states it. If it does not, return null for
   the value and give a short reason. Never infer from industry convention, from
   what is typical, or from the other fields.

2. Every value must be accompanied by a \`quote\`: a span copied VERBATIM from the
   excerpt — character for character, including punctuation and capitalisation.
   No paraphrasing, no ellipsis, no reformatting, no joining of separated text.
   The quote is checked programmatically against the source document; a quote
   that does not appear there causes the value to be discarded.

3. The quote must itself contain the evidence. If the value is a number, that
   number must appear inside the quote.

4. Prefer the shortest quote that still contains the evidence.

5. An excerpt may state the same kind of fact more than once, or state a fact
   that only resembles the one asked for. Read the field instruction carefully
   and choose on meaning, not on position in the text.`;

/** Shared shape for every extracted field. */
export interface Extracted<T> {
  value: T | null;
  quote: string | null;
  not_found_reason?: string;
}
