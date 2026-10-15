import { formatMmDdYyyy } from '../extract/normalize/date.ts';
import { formatNetTerms } from '../extract/normalize/netTerms.ts';

/**
 * Row -> DTO, shaping every response to match `openapi.yaml` exactly.
 *
 * This layer exists because `express-openapi-validator` checks RESPONSES as well
 * as requests, with `additionalProperties: false` throughout — so the spec is a
 * real contract rather than a description. Returning raw rows could not satisfy
 * that, and it was leaking the storage layer anyway: `document_id: "3"` as a
 * string (BIGINT comes back as text from the driver), snake_case mixed with
 * camelCase in one object, and internal columns like `raw_text` and
 * `file_sha256` a caller has no business seeing.
 *
 * Three conversions are applied HERE and nowhere else:
 *
 *   dates   DATE -> `mm-dd-yyyy`. Stored as DATE because these are calendar
 *           dates; storing the display format would break ordering and range
 *           queries.
 *   terms   INTEGER -> `Net xx`, for the same reason.
 *   bigint  the driver returns BIGINT as a string, so ids are Number()ed. Money
 *           is deliberately NOT — see `decimal`.
 */
type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Money and quantities stay STRINGS. `22916.67` becomes `22916.669999999998` as
 * an IEEE double, and the whole point of NUMERIC is defeated if anything parses
 * it on the way through.
 */
const decimal = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** DATE columns arrive as `yyyy-mm-dd` strings — see the driver parsers in db/types.ts. */
const date = (v: unknown): string | null =>
  v === null || v === undefined ? null : formatMmDdYyyy(String(v).slice(0, 10));

const stamp = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();

const json = (v: unknown): Record<string, unknown> =>
  v === null || v === undefined ? {} : (v as Record<string, unknown>);

export function customerRef(row: Row): Row | null {
  if (row['customer_id'] === null || row['customer_id'] === undefined) return null;
  return {
    id: Number(row['customer_id']),
    slug: String(row['customer_slug']),
    name: String(row['customer_name']),
  };
}

export function documentSummary(row: Row): Row {
  return {
    id: Number(row['id']),
    filename: String(row['original_filename']),
    ingress: str(row['ingress']),
    docType: row['doc_type'] ?? null,
    status: String(row['status']),
    amount: decimal(row['amount']),
    currency: str(row['currency']),
    startDate: date(row['start_date']),
    endDate: date(row['end_date']),
    customer: customerRef(row),
    customerResolution: row['customer_resolution'] ?? null,
    detectedIssuerName: str(row['detected_issuer_name']),
    reviewReasons: (row['review_reasons'] ?? []) as string[],
    itemCount: Number(row['item_count'] ?? 0),
    createdAt: stamp(row['created_at']),
  };
}

export function party(row: Row): Row {
  return {
    role: String(row['role']),
    name: str(row['name']),
    address: str(row['address']),
    shippingAddress: str(row['shipping_address']),
    contactName: str(row['contact_name']),
    contactEmail: str(row['contact_email']),
    contactPhone: str(row['contact_phone']),
    // Kept as a tri-state: null is "could not tell", which is a different
    // answer from false and must not collapse into it.
    signaturePresent: row['signature_present'] === null ? null : Boolean(row['signature_present']),
    signerName: str(row['signer_name']),
    signerTitle: str(row['signer_title']),
    signatureDate: date(row['signature_date']),
  };
}

export function item(row: Row): Row {
  return {
    id: Number(row['id']),
    lineNo: Number(row['line_no']),
    productName: str(row['product_name']),
    quantity: decimal(row['quantity']),
    unitPrice: decimal(row['unit_price']),
    totalAmount: decimal(row['total_amount']),
    currency: str(row['currency']),
    itemStartDate: date(row['item_start_date']),
    itemEndDate: date(row['item_end_date']),
    attributes: json(row['attributes']),
    fieldSources: json(row['field_sources']),
    hasInferred: Boolean(row['has_inferred']),
  };
}

export function specialTerm(row: Row): Row {
  return {
    id: Number(row['id']),
    // null means document-scoped. There is no `scope` column — this test is it.
    itemId: int(row['item_id']),
    termType: String(row['term_type']),
    ordinal: int(row['ordinal']),
    percent: decimal(row['percent']),
    capValue: decimal(row['cap_value']),
    capUnit: str(row['cap_unit']),
    period: str(row['period']),
    appliesTo: str(row['applies_to']),
    termText: String(row['term_text']),
    attributes: json(row['attributes']),
    pageNo: int(row['page_no']),
  };
}

export function specialTermWithDocument(row: Row): Row {
  return {
    ...specialTerm(row),
    documentId: Number(row['document_id']),
    customer: customerRef(row),
  };
}

export function typeDetails(docType: unknown, row: Row | undefined): Row | null {
  if (row === undefined) return null;
  if (docType === 'purchase_order') {
    return { poNumber: str(row['po_number']), poDate: date(row['po_date']) };
  }
  return {
    quoteNumber: str(row['quote_number']),
    quoteDate: date(row['quote_date']),
    quoteExpirationDate: date(row['quote_expiration_date']),
    proposedBy: str(row['proposed_by']),
    subscriptionTermMonths: decimal(row['subscription_term_months']),
    masterAgreementRef: str(row['master_agreement_ref']),
    poRequired: row['po_required'] === null ? null : Boolean(row['po_required']),
    poNumber: str(row['po_number']),
    poAmount: decimal(row['po_amount']),
  };
}

export function document(
  row: Row,
  parts: { parties: Row[]; items: Row[]; terms: Row[]; details: Row | undefined },
): Row {
  return {
    id: Number(row['id']),
    filename: String(row['original_filename']),
    ingress: str(row['ingress']),
    pageCount: int(row['page_count']),
    docType: row['doc_type'] ?? null,
    docTypeConfidence: row['doc_type_confidence'] === null ? null : Number(row['doc_type_confidence']),
    docTypeSource: str(row['doc_type_source']),
    customer: customerRef(row),
    customerResolution: row['customer_resolution'] ?? null,
    detectedIssuerName: str(row['detected_issuer_name']),
    status: String(row['status']),
    reviewReasons: (row['review_reasons'] ?? []) as string[],
    startDate: date(row['start_date']),
    endDate: date(row['end_date']),
    amount: decimal(row['amount']),
    currency: str(row['currency']),
    paymentTerms:
      row['payment_terms_days'] === null ? null : formatNetTerms(Number(row['payment_terms_days'])),
    billingFrequency: str(row['billing_frequency']),
    attributes: json(row['attributes']),
    typeDetails: typeDetails(row['doc_type'], parts.details),
    parties: parts.parties.map(party),
    items: parts.items.map(item),
    specialTerms: parts.terms.map(specialTerm),
    review:
      row['reviewed_at'] === null || row['reviewed_at'] === undefined
        ? null
        : {
            reviewedAt: stamp(row['reviewed_at']),
            reviewedBy: String(row['reviewed_by']),
            note: str(row['review_note']),
          },
    currentRunId: int(row['current_run_id']),
    createdAt: stamp(row['created_at']),
    updatedAt: stamp(row['updated_at']),
  };
}

export function job(row: Row): Row {
  return {
    id: Number(row['id']),
    kind: String(row['kind']),
    documentId: int(row['document_id']),
    status: String(row['status']),
    attempts: Number(row['attempts']),
    errorClass: str(row['error_class']),
    errorCode: str(row['error_code']),
    error: str(row['error']),
    result: (row['result'] ?? null) as Record<string, unknown> | null,
    runAfter: stamp(row['run_after']),
    lockedAt: stamp(row['locked_at']),
    lockedBy: str(row['locked_by']),
    createdAt: stamp(row['created_at']),
    finishedAt: stamp(row['finished_at']),
  };
}

export function extractionRun(row: Row, currentRunId: number | null): Row {
  return {
    id: Number(row['id']),
    trigger: String(row['trigger']),
    profileId: int(row['profile_id']),
    profileVersion: int(row['profile_version']),
    engine: json(row['engine']),
    llmCalls: Number(row['llm_calls']),
    outcome: String(row['outcome']),
    error: str(row['error']),
    startedAt: stamp(row['started_at']),
    finishedAt: stamp(row['finished_at']),
    isCurrent: Number(row['id']) === currentRunId,
  };
}

export function customer(row: Row): Row {
  return {
    id: Number(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    documentCount: Number(row['document_count'] ?? 0),
    createdAt: stamp(row['created_at']),
  };
}

export function profileVersion(row: Row): Row {
  return {
    id: Number(row['id']),
    docType: String(row['doc_type']),
    version: Number(row['version']),
    isActive: Boolean(row['is_active']),
    contentHash: String(row['content_hash']),
    createdAt: stamp(row['created_at']),
    definition: json(row['definition']),
  };
}

/**
 * One traced field, with its evidence RE-VERIFIED against the stored text.
 *
 * Recomputed on read rather than trusted: a quoted string alone could itself be
 * wrong, since a model can hallucinate its own citation alongside a plausible
 * value. Slicing `raw_text` at the recorded offsets is what makes the response
 * prove the evidence instead of repeating it.
 */
export function tracedField(field: string, trace: unknown, rawText: string): Row {
  const t = trace as {
    value?: unknown;
    source?: string | null;
    evidence?: { start: number; end: number; text: string };
  };
  const evidence = t.evidence ?? null;
  return {
    field,
    value: t.value ?? null,
    source: t.source ?? null,
    evidence,
    evidenceVerified:
      evidence === null ? null : rawText.slice(evidence.start, evidence.end) === evidence.text,
  };
}
