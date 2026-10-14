import express from 'express';
import { pool } from '../db/pool.ts';
import { formatMmDdYyyy } from '../extract/normalize/date.ts';
import { formatNetTerms } from '../extract/normalize/netTerms.ts';

/**
 * The brief's output formats are applied HERE and nowhere else: dates are stored
 * as DATE and payment terms as an integer, then rendered as `mm-dd-yyyy` and
 * `Net xx` at the boundary. Storing them pre-formatted would break ordering and
 * range queries.
 */
// DATE columns arrive as 'yyyy-mm-dd' strings (see the type parser in db/pool.ts),
// so there is no Date object to mishandle here.
const outDate = (d: string | null) => (d === null ? null : formatMmDdYyyy(d.slice(0, 10)));

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'database unavailable', code: 'DB_UNAVAILABLE' });
    }
  });

  app.get('/documents', async (req, res) => {
    const { status, docType, customer } = req.query as Record<string, string | undefined>;
    const { rows } = await pool.query(
      `SELECT d.id, d.original_filename, d.doc_type, d.status, d.amount, d.currency,
              d.start_date, d.end_date, c.slug AS customer, d.customer_resolution,
              d.detected_issuer_name, d.review_reasons,
              (SELECT count(*) FROM document_items i WHERE i.document_id = d.id) AS item_count
         FROM documents d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ($1::text IS NULL OR d.status::text = $1)
          AND ($2::text IS NULL OR d.doc_type::text = $2)
          AND ($3::text IS NULL OR c.slug = $3)
        ORDER BY d.id DESC LIMIT 100`,
      [status ?? null, docType ?? null, customer ?? null],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        start_date: outDate(r['start_date'] as string | null),
        end_date: outDate(r['end_date'] as string | null),
        item_count: Number(r['item_count']),
      })),
    );
  });

  app.get('/documents/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be an integer', code: 'BAD_REQUEST' });
      return;
    }

    const { rows: docs } = await pool.query(
      `SELECT d.*, c.slug AS customer_slug, c.name AS customer_name
         FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = $1`,
      [id],
    );
    const doc = docs[0];
    if (doc === undefined) {
      res.status(404).json({ error: `no document ${id}`, code: 'NOT_FOUND' });
      return;
    }

    const [parties, items, terms, details] = await Promise.all([
      pool.query('SELECT * FROM document_parties WHERE document_id = $1 ORDER BY role', [id]),
      pool.query('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [id]),
      pool.query('SELECT * FROM special_terms WHERE document_id = $1 ORDER BY ordinal NULLS LAST, id', [id]),
      doc['doc_type'] === 'purchase_order'
        ? pool.query('SELECT * FROM purchase_order_details WHERE document_id = $1', [id])
        : pool.query('SELECT * FROM order_form_details WHERE document_id = $1', [id]),
    ]);

    res.json({
      id: Number(doc['id']),
      filename: doc['original_filename'],
      ingress: doc['ingress'],
      docType: doc['doc_type'],
      docTypeConfidence: doc['doc_type_confidence'] === null ? null : Number(doc['doc_type_confidence']),
      customer: doc['customer_slug'] === null ? null : { slug: doc['customer_slug'], name: doc['customer_name'] },
      customerResolution: doc['customer_resolution'],
      detectedIssuerName: doc['detected_issuer_name'],
      status: doc['status'],
      reviewReasons: doc['review_reasons'],
      startDate: outDate(doc['start_date'] as string | null),
      endDate: outDate(doc['end_date'] as string | null),
      amount: doc['amount'],
      currency: doc['currency'],
      paymentTerms: doc['payment_terms_days'] === null ? null : formatNetTerms(Number(doc['payment_terms_days'])),
      billingFrequency: doc['billing_frequency'],
      attributes: doc['attributes'],
      typeDetails: details.rows[0] ?? null,
      parties: parties.rows.map((p) => ({ ...p, signature_date: outDate(p['signature_date'] as string | null) })),
      items: items.rows.map((i) => ({
        ...i,
        item_start_date: outDate(i['item_start_date'] as string | null),
        item_end_date: outDate(i['item_end_date'] as string | null),
      })),
      specialTerms: terms.rows,
      currentRunId: doc['current_run_id'] === null ? null : Number(doc['current_run_id']),
    });
  });

  /** Every stored value, with the exact document text it came from. */
  app.get('/documents/:id/trace', async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query<{ field_confidence: Record<string, unknown>; raw_text: string }>(
      `SELECT r.field_confidence, d.raw_text
         FROM documents d JOIN extraction_runs r ON r.id = d.current_run_id
        WHERE d.id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      res.status(404).json({ error: `no extraction run for document ${id}`, code: 'NOT_FOUND' });
      return;
    }
    // Re-slice raw_text at each recorded offset, so the response PROVES the
    // evidence rather than just quoting it back.
    const fields = Object.entries(row.field_confidence ?? {}).map(([field, t]) => {
      const trace = t as { value: unknown; source: string | null; evidence?: { start: number; end: number; text: string } };
      const verified = trace.evidence
        ? row.raw_text.slice(trace.evidence.start, trace.evidence.end) === trace.evidence.text
        : null;
      return { field, ...trace, evidenceVerified: verified };
    });
    res.json({ documentId: id, fields });
  });

  return app;
}
