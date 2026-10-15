/**
 * Applies a field's declared `type` to the raw text a locator found.
 *
 * This closed a silent-knob gap: `type` was declared in the profile schema and
 * never read, so CloudShield's `subscription_term_months` stored the whole tail
 * of its line —
 *
 *   "(unless extended according to the terms of this Order Form): 36.00 months"
 *
 * — into a NUMERIC(6,2) column. The label `Subscription Term (months)` is
 * followed by a parenthetical before the value, which no label lookup can know
 * about; declaring the type is what says "take the number out of this".
 *
 * Numbers come back as DECIMAL STRINGS, never JS numbers, for the same reason
 * money does: 22916.67 becomes 22916.669999999998 as a float, and the point of
 * NUMERIC is defeated if anything parses it on the way to the DB.
 */
export type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'money';

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;
const TRUTHY = /\b(?:yes|true|signed|required|✔|✓)\b/i;
const FALSEY = /\b(?:no|false|none|not required|n\/?a)\b/i;

export function coerce(text: string, type: ValueType | undefined): string | boolean | null {
  switch (type) {
    case 'number': {
      const m = NUMBER.exec(text);
      return m === null ? null : (m[0] as string).replace(/,/g, '');
    }
    case 'boolean': {
      // Order matters only for text carrying both words; these documents don't,
      // and an unrecognisable answer returns null so the field escalates rather
      // than defaulting to a claim about the contract.
      if (TRUTHY.test(text)) return true;
      if (FALSEY.test(text)) return false;
      return null;
    }
    case 'date':
      // Dates go through parseDate, which needs the profile's input_format to
      // resolve the M/D vs D/M ambiguity. Returning the text unchanged lets the
      // caller do that rather than guessing here.
      return text;
    case 'money':
      // Likewise parseMoney, which needs the money_format and the document's
      // currency resolution. Handled in the pipeline; unchanged here.
      return text;
    case 'string':
    case undefined:
      return text;
  }
}
