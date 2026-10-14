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
    /** A named locator strategy, when a plain label lookup will not do. */
    strategy: z
      .enum(['label_value', 'multiline_after_label', 'signature_marker',
             'two_column_signature', 'placeholder_lines'])
      .optional(),
    /** For multiline_after_label. */
    max_lines: z.number().int().positive().max(10).optional(),
    /** Sections sent to Claude if this field escalates. */
    sections: z.array(z.string()).optional(),
    /** Which column of a two-column signature block is the buyer's. */
    buyer_column: z.enum(['left', 'right']).optional(),
    type: z.enum(['string', 'number', 'boolean', 'date']).optional(),
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
    header_rows: z.number().int().positive().max(5).optional(),
    wrapped_cells: z.boolean().optional(),
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
