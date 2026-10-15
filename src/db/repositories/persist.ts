import type { PoolClient } from 'pg';
import { withTransaction } from '../pool.ts';
import { finish } from '../../jobs/repo.ts';
import type { ExtractionResult } from '../../extract/pipeline.ts';

/**
 * Writes an extraction in ONE transaction: the documents row, both party rows,
 * the type-detail row, every item, every special term, and the audit run — plus
 * the job's completion when one is supplied. All of it or none, so a crash can
 * never leave half-extracted rows or a job marked done with no data.
 *
 * Items and special terms are DELETEd then INSERTed rather than diffed: a
 * re-extraction replaces current state, and extraction_runs keeps the history.
 */
export interface PersistInput {
  documentId: number;
  result: ExtractionResult;
  /**
   * Written here rather than at ingress, because the ingress path no longer
   * parses. FROZEN once set: evidence offsets index into it, so the trace stays
   * verifiable. A reprocess re-parses the archived PDF and may produce better
   * TABLES, but the text it indexes must not shift under existing offsets —
   * hence COALESCE below, writing it only the first time.
   */
  rawText: string;
  pageCount: number;
  profileId: number | null;
  trigger: string;
  engine: Record<string, unknown>;
  /**
   * Completed inside THIS transaction when given.
   *
   * That is the point of threading it down here rather than marking the job done
   * afterwards: a crash between the two would otherwise leave either a job
   * marked done with no data, or data with a job still `running` that the
   * stale-lock sweep would hand to another worker to redo.
   */
  jobId?: number | undefined;
}

const statusFor = (r: ExtractionResult) =>
  r.docType === null ? 'needs_classification'
    : r.reviewReasons.length > 0 ? 'needs_review'
    : 'extracted';

export async function persistExtraction(input: PersistInput): Promise<{ runId: number; status: string }> {
  return withTransaction(async (c: PoolClient) => {
    const { documentId, result } = input;
    const status = statusFor(result);

    const { rows: runRows } = await c.query<{ id: number }>(
      `INSERT INTO extraction_runs
         (document_id, profile_id, trigger, engine, field_confidence, llm_calls, outcome, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [
        documentId, input.profileId, input.trigger, input.engine,
        JSON.stringify(result.fieldTrace), result.llmCalls,
        result.docType === null ? 'partial' : result.reviewReasons.length > 0 ? 'partial' : 'ok',
      ],
    );
    const runId = (runRows[0] as { id: number }).id;

    // raw_text and page_count are set on the FIRST extraction and then left
    // alone. COALESCE rather than a conditional write, so the invariant is in
    // the SQL where it cannot be forgotten by a future caller.
    await c.query(
      `UPDATE documents SET
         raw_text = COALESCE(raw_text, $18), page_count = COALESCE(page_count, $19),
         doc_type = $2, doc_type_confidence = $3, doc_type_source = $4,
         customer_id = $5, customer_resolution = $6, detected_issuer_name = $7,
         start_date = $8, end_date = $9, amount = $10, currency = $11,
         payment_terms_days = $12, billing_frequency = $13, attributes = $14,
         status = $15, review_reasons = $16, current_run_id = $17, updated_at = now()
       WHERE id = $1`,
      [
        documentId, result.docType, result.docTypeConfidence, result.docTypeSource,
        result.customerId, result.customerResolution, result.detectedIssuerName,
        result.startDate, result.endDate, result.amount, result.currency,
        result.paymentTermsDays, result.billingFrequency, result.attributes,
        status, result.reviewReasons, runId,
        input.rawText, input.pageCount,
      ],
    );

    await c.query('DELETE FROM document_parties WHERE document_id = $1', [documentId]);
    for (const p of result.parties) {
      // skip a party the document never named at all
      if (p.name === null && p.address === null && p.signaturePresent === null) continue;
      await c.query(
        `INSERT INTO document_parties
           (document_id, role, name, address, shipping_address, contact_name, contact_email,
            contact_phone, signature_present, signer_name, signer_title, signature_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [documentId, p.role, p.name, p.address, p.shippingAddress, p.contactName,
         p.contactEmail, p.contactPhone, p.signaturePresent, p.signerName, p.signerTitle,
         p.signatureDate],
      );
    }

    const td = result.typeDetails;
    if (result.docType === 'purchase_order') {
      await c.query(
        `INSERT INTO purchase_order_details (document_id, po_number, po_date) VALUES ($1,$2,$3)
         ON CONFLICT (document_id) DO UPDATE SET po_number = EXCLUDED.po_number, po_date = EXCLUDED.po_date`,
        [documentId, td['po_number'] ?? null, td['po_date'] ?? null],
      );
    } else if (result.docType === 'order_form') {
      await c.query(
        `INSERT INTO order_form_details
           (document_id, quote_number, quote_date, quote_expiration_date, proposed_by,
            subscription_term_months, master_agreement_ref, po_required, po_number, po_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (document_id) DO UPDATE SET
           quote_number = EXCLUDED.quote_number, quote_date = EXCLUDED.quote_date,
           quote_expiration_date = EXCLUDED.quote_expiration_date, proposed_by = EXCLUDED.proposed_by`,
        [documentId, td['quote_number'] ?? null, td['quote_date'] ?? null,
         td['quote_expiration_date'] ?? null, td['proposed_by'] ?? null,
         td['subscription_term_months'] ?? null, td['master_agreement_ref'] ?? null,
         null, td['po_number'] ?? null, td['po_amount'] ?? null],
      );
    }

    // items first: special_terms.item_id references them
    await c.query('DELETE FROM special_terms WHERE document_id = $1', [documentId]);
    await c.query('DELETE FROM document_items WHERE document_id = $1', [documentId]);
    for (const i of result.items) {
      await c.query(
        `INSERT INTO document_items
           (document_id, line_no, product_name, quantity, unit_price, total_amount, currency,
            item_start_date, item_end_date, attributes, field_sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [documentId, i.lineNo, i.productName, i.quantity, i.unitPrice, i.totalAmount,
         i.currency, i.itemStartDate, i.itemEndDate, i.attributes,
         Object.keys(i.fieldSources).length > 0 ? i.fieldSources : null],
      );
    }

    for (const s of result.specialTerms) {
      await c.query(
        `INSERT INTO special_terms
           (document_id, item_id, term_type, ordinal, percent, cap_value, cap_unit,
            period, applies_to, term_text, attributes, page_no)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [documentId, s.termType, s.ordinal, s.percent, s.capValue, s.capUnit,
         s.period, s.appliesTo, s.termText, s.attributes, s.pageNo],
      );
    }

    // LAST, and inside the same transaction. See PersistInput.jobId.
    if (input.jobId !== undefined) {
      await finish(input.jobId, { runId, status, llmCalls: result.llmCalls }, c);
    }

    return { runId, status };
  });
}
