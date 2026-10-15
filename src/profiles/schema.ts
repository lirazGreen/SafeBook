import { z } from 'zod';

/**
 * The shape of a profile `definition`.
 *
 * STRICT on purpose: an unknown key is an error, not something silently ignored.
 * A profile is the only thing standing between a document and a wrong answer, so
 * a typo like `labells:` must fail loudly at seed time rather than quietly
 * disabling a field in production.
 *
 * Note what is NOT here: no `strategy: llm`. Whether a field needs Claude is
 * decided by the document (does the deterministic rule parse?), never declared.
 */
const DateFormat = z.enum(['long_month', 'short_month_compact', 'slash_mdy', 'dash_mdy']);
const MoneyFormat = z.enum(['symbol_prefix', 'code_prefix', 'code_suffix']);

const FieldSpec = z
  .object({
    /** Label text to look for, tried in order. */
    labels: z.array(z.string()).optional(),
    /** Declared date format. Omitted => try all, and flag genuine ambiguity. */
    input_format: DateFormat.optional(),
    input_formats: z.array(DateFormat).optional(),
    money_format: MoneyFormat.optional(),
    /** Used only to resolve a bare ambiguous symbol such as `$`. */
    currency: z.string().length(3).optional(),
    /**
     * A regex, for the one-off shapes no label covers — CloudShield states its
     * marketplace as a bare line, `Azure Private Offer`, with nothing labelling
     * it. Capture group 1 is the value when present, else the whole match.
     * Compiled at load time, so a broken pattern fails at seed.
     */
    pattern: z.string().min(1).optional(),
    /** Which occurrence of the label to take, when a document reuses one. */
    occurrence: z.number().int().positive().max(20).optional(),
    /**
     * Read this field ONLY from inside the named section. The complement of
     * `ignore_sections`: CloudShield's `po_number` and `po_amount` live in the
     * very block the mask excludes, so scoping them in is what keeps the mask
     * from deleting the data it was added to protect.
     */
    in_section: z.string().min(1).optional(),
    /**
     * A named locator strategy, when a plain label lookup will not do.
     *
     * NOTE: no `placeholder_lines`. It was declared as a second strategy for
     * CloudShield's blank `Name: ____` block before the geometry was checked —
     * the two order forms' signature blocks are structurally identical, so it
     * was never a strategy, only `two_column_signature`'s `false` outcome. Same
     * policy as `header_rows`/`wrapped_cells`: the schema REJECTS a knob that
     * does nothing rather than accepting and ignoring it.
     */
    strategy: z
      .enum(['label_value', 'multiline_after_label', 'signature_marker',
             'two_column_signature'])
      .optional(),
    /** For multiline_after_label. */
    max_lines: z.number().int().positive().max(10).optional(),
    /** Sections sent to Claude if this field escalates. */
    sections: z.array(z.string()).optional(),
    /** Which column of a two-column signature block is the buyer's. */
    buyer_column: z.enum(['left', 'right']).optional(),
    /**
     * `money` matters as much as `number`: order_form_details.po_amount is
     * NUMERIC(18,2), and CloudShield's decoy block states it as `USD 0.00`.
     * Storing the raw text aborted the whole insert with
     * `invalid input syntax for type numeric: "USD 0.00"` — found only by
     * writing to a real database, because nothing before that layer cared.
     */
    type: z.enum(['string', 'number', 'boolean', 'date', 'money']).optional(),
  })
  .strict();

const ItemsSpec = z
  .object({
    /** Logical column -> the header wordings that mean it. */
    column_synonyms: z.record(z.string(), z.array(z.string())).optional(),
    /** Extra columns captured into document_items.attributes. */
    optional_columns: z.record(z.string(), z.array(z.string())).optional(),
    /** Sparse columns whose blank cells inherit from the row above. */
    carry_down: z.array(z.string()).optional(),
    date_format: DateFormat.optional(),
    /** Per-item arithmetic check. CloudShield prices monthly. */
    reconcile: z.string().optional(),
    tolerance: z.number().nonnegative().optional(),
    tolerance_pct: z.number().nonnegative().max(100).optional(),
    /** Table geometry overrides — defaults adapt to the table itself. */
    column_gap_pt: z.number().positive().optional(),
    anchor_column_ratio: z.number().positive().max(1).optional(),
    // NOTE: no header_rows / wrapped_cells. Both were declared early and never
    // read: the reconstruction detects the header block and joins wrapped cells
    // from the geometry itself. A knob that silently does nothing is a trap, so
    // the schema rejects them rather than accepting and ignoring them.
  })
  .strict();

const SpecialTermsSpec = z
  .object({
    section: z.string().optional(),
    /** term_type -> the labels that introduce it on a labelled-bullet document. */
    type_labels: z.record(z.string(), z.array(z.string())).optional(),
    /** Wording hints passed to Claude — Acme never says "Technical Account Manager". */
    synonyms: z.record(z.string(), z.array(z.string())).optional(),
    unknown_type: z.string().optional(),
  })
  .strict();

/**
 * Per-party locators. Keyed by role because the roles are symmetric and which
 * one is SafeBook's customer inverts by document type — on an order form the
 * issuer is the vendor, on a PO it is the buyer.
 */
const PartiesSpec = z
  .object({
    buyer: z.record(z.string(), FieldSpec).optional(),
    vendor: z.record(z.string(), FieldSpec).optional(),
  })
  .strict();

export const ProfileDefinition = z
  .object({
    doc_type: z.enum(['order_form', 'purchase_order']).optional(),
    extends: z.string().optional(),
    fields: z.record(z.string(), FieldSpec).optional(),
    parties: PartiesSpec.optional(),
    /** Locators for the doc-type-specific detail table (quote_number, po_number…). */
    type_fields: z.record(z.string(), FieldSpec).optional(),
    optional_fields: z.record(z.string(), FieldSpec).optional(),
    items: ItemsSpec.optional(),
    special_terms: SpecialTermsSpec.optional(),
    /** Blocks excluded during extraction — CloudShield's own PO section. */
    ignore_sections: z.array(z.string()).optional(),
    /** Overrides the default block-boundary heading list. */
    section_headings: z.array(z.string()).optional(),
    default_currency: z.string().length(3).optional(),
  })
  .strict();

export type ProfileDefinition = z.infer<typeof ProfileDefinition>;

export const CustomerRegistry = z
  .object({
    customers: z.array(
      z
        .object({
          slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase, digits and hyphens only'),
          name: z.string().min(1),
          match: z
            .array(
              z
                .object({
                  kind: z.enum(['text', 'signature_block', 'doc_id']),
                  pattern: z.string().min(1),
                })
                .strict(),
            )
            .min(1, 'a customer needs at least one match pattern or it can never be resolved'),
        })
        .strict(),
    ),
  })
  .strict();

export type CustomerRegistry = z.infer<typeof CustomerRegistry>;
