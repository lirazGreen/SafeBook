/**
 * Imported from 'zod/v4', NOT 'zod'.
 *
 * `zodOutputFormat` from the Anthropic SDK accepts a zod v4 schema; zod 3.25
 * ships both APIs on separate subpaths. The PROFILE schema
 * (src/profiles/schema.ts) stays on v3 because nothing hands it to the SDK — so
 * the two live side by side deliberately rather than by accident.
 */
import * as z from 'zod/v4';

/**
 * Output schemas for escalated fields.
 *
 * Every one allows `value: null` with a reason, and the prompts instruct returning
 * null rather than guessing — an explicit "not stated" is far better signal than a
 * confident wrong answer, and CloudShield genuinely has no Technical Account
 * Manager term.
 *
 * `quote` is mandatory alongside any non-null value: it is checked against
 * `raw_text` before the value is accepted, which is what catches an invented
 * citation.
 *
 * Note the absence of a `confidence` field. Self-reported confidence is not
 * calibrated and nothing gates on it; flagging comes from the deterministic
 * checks instead.
 */
const quoted = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value.nullable(),
    quote: z.string().nullable(),
    not_found_reason: z.string().nullable(),
  });

/** Days after invoicing within which payment is due. */
export const PaymentTermsOutput = quoted(z.number());

/** e.g. "Annual", "Monthly", "Quarterly". */
export const BillingFrequencyOutput = quoted(z.string());

/** Which organisation ISSUED the document — buyer on a PO, vendor on an order form. */
export const IssuerNameOutput = quoted(z.string());

export const DocTypeOutput = quoted(z.enum(['order_form', 'purchase_order']));

/**
 * Special terms are a LIST, because one paragraph can yield several entries:
 * CloudShield's burst clause states a different percentage for each of three
 * subscription years.
 */
export const SpecialTermsOutput = z.object({
  terms: z.array(
    z.object({
      term_type: z.enum([
        'burst', 'technical_account_manager', 'free_trial', 'tiered_pricing',
        'conversion_right', 'renewal_cap', 'credit', 'sla', 'unknown',
      ]),
      ordinal: z.number().nullable(),
      percent: z.number().nullable(),
      cap_value: z.number().nullable(),
      cap_unit: z.string().nullable(),
      period: z.string().nullable(),
      applies_to: z.string().nullable(),
      quote: z.string(),
    }),
  ),
});

export type SpecialTermsOutput = z.infer<typeof SpecialTermsOutput>;

export const SCHEMAS = {
  payment_terms_days: PaymentTermsOutput,
  billing_frequency: BillingFrequencyOutput,
  issuer_name: IssuerNameOutput,
  doc_type: DocTypeOutput,
  special_terms: SpecialTermsOutput,
} as const;

export type EscalatableField = keyof typeof SCHEMAS;
export const isEscalatableField = (f: string): f is EscalatableField => f in SCHEMAS;
