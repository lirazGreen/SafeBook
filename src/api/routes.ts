import type { Express, Request, Response } from 'express';
import { pool } from '../db/pool.ts';
import { registerBytes } from '../ingest/register.ts';
import { JobError } from '../jobs/errors.ts';
import { enqueue, getJob, pendingJobId, waitForJob } from '../jobs/repo.ts';
import { storage } from '../storage/index.ts';
import * as present from './present.ts';

/**
 * Handlers. Every shape here is dictated by `openapi.yaml`, which
 * `express-openapi-validator` enforces on the way OUT as well as in — so a field
 * added here without a spec change fails the contract test rather than shipping.
 */
type Query = Record<string, string | undefined>;

/** Mutations enqueue and return 202. Nothing parses inside an HTTP handler. */
async function enqueueFor(res: Response, documentId: number, kind: 'ingest' | 'reextract') {
  const { jobId, alreadyQueued } = await enqueue(kind, documentId);
  res.status(202).json({ documentId, jobId, enqueued: !alreadyQueued });
}

async function documentExists(id: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM documents WHERE id = $1', [id]);
  return rows.length > 0;
}

const notFound = (res: Response, what: string) =>
  res.status(404).json({ error: what, code: 'NOT_FOUND' });

export function mountRoutes(app: Express): void {
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'database unavailable', code: 'DB_UNAVAILABLE' });
    }
  });

  // ---- ingest -------------------------------------------------------------

  app.post('/documents', async (req: Request, res) => {
    // `express-openapi-validator` runs multer for the declared multipart body.
    // multer hands back either an array (one field name repeated) or a map of
    // field name -> files, depending on how it was configured; normalise both.
    const raw = (req as Request & { files?: unknown }).files;
    const files = (
      Array.isArray(raw) ? raw
        : raw === null || raw === undefined ? []
        : Object.values(raw as Record<string, unknown>).flat()
    ) as { originalname: string; buffer: Buffer }[];

    // Per-file results, because ONE BAD FILE MUST NOT FAIL THE REST.
    const results = [];
    for (const file of files) {
      try {
        const out = await registerBytes(file.buffer, file.originalname, 'upload');
        results.push({
          file: file.originalname,
          status: out.duplicate ? 'duplicate' : 'queued',
          documentId: out.documentId,
          jobId: out.jobId,
        });
      } catch (err) {
        results.push({
          file: file.originalname,
          status: 'rejected',
          documentId: null,
          jobId: null,
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof JobError ? err.code : 'UNKNOWN',
        });
      }
    }
    // 207 only when something was actually rejected: a client then has one body
    // shape and one code path either way.
    res.status(results.some((r) => r.status === 'rejected') ? 207 : 202).json(results);
  });

  app.post('/scan', async (req, res) => {
    const waitMs = Number((req.query as Query)['wait'] ?? 0);
    try {
      const { jobId, alreadyQueued } = await enqueue('scan_inbox');
      // On a coalesce, wait on the sweep ALREADY pending rather than returning a
      // bare "already queued". The timer queues a tick every couple of seconds,
      // so losing that race is the common case — and without this `?wait=`
      // quietly degraded to fire-and-forget.
      const id = jobId ?? (await pendingJobId('scan_inbox'));
      if (id === null) {
        res.status(202).json({ status: 'already_completed', jobId: null, coalesced: true });
        return;
      }
      if (waitMs <= 0) {
        res.status(202).json({ status: 'queued', jobId: id, coalesced: alreadyQueued });
        return;
      }
      const row = await waitForJob(id, waitMs);
      const settled = row?.['status'] === 'done' || row?.['status'] === 'failed';
      res.status(settled ? 200 : 202).json({
        status: (row?.['status'] as string) ?? 'queued',
        jobId: id,
        coalesced: alreadyQueued,
        ...((row?.['result'] as Record<string, unknown> | null) ?? {}),
        ...(row?.['error'] ? { error: String(row['error']), code: String(row['error_code']) } : {}),
      });
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'DB_UNAVAILABLE',
      });
    }
  });

  // ---- inspect ------------------------------------------------------------

  app.get('/documents', async (req, res) => {
    const q = req.query as Query;
    const limit = Number(q['limit'] ?? 50);
    const offset = Number(q['offset'] ?? 0);
    const where = `
         ($1::text IS NULL OR d.status::text = $1)
     AND ($2::text IS NULL OR d.doc_type::text = $2)
     AND ($3::text IS NULL OR c.slug = $3)
     AND ($4::text IS NULL OR d.customer_resolution::text = $4)
     AND ($5::text IS NULL OR $5 = ANY(d.review_reasons))
     AND ($6::boolean IS NULL OR $6 = EXISTS (
           SELECT 1 FROM document_items i WHERE i.document_id = d.id AND i.has_inferred))`;
    const params = [
      q['status'] ?? null, q['docType'] ?? null, q['customer'] ?? null,
      q['resolution'] ?? null, q['reason'] ?? null,
      q['hasInferred'] === undefined ? null : q['hasInferred'] === 'true',
    ];

    const { rows } = await pool.query(
      `SELECT d.*, c.slug AS customer_slug, c.name AS customer_name,
              (SELECT count(*) FROM document_items i WHERE i.document_id = d.id) AS item_count,
              count(*) OVER () AS total
         FROM documents d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ${where}
        ORDER BY d.id DESC LIMIT $7 OFFSET $8`,
      [...params, limit, offset],
    );
    res.json({
      documents: rows.map(present.documentSummary),
      total: rows.length === 0 ? 0 : Number(rows[0]!['total']),
      limit,
      offset,
    });
  });

  app.get('/documents/:id', async (req, res) => {
    const id = Number(req.params['id']);
    const { rows } = await pool.query(
      `SELECT d.*, c.slug AS customer_slug, c.name AS customer_name
         FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return void notFound(res, `no document ${id}`);

    const [parties, items, terms, details] = await Promise.all([
      pool.query('SELECT * FROM document_parties WHERE document_id = $1 ORDER BY role', [id]),
      pool.query('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [id]),
      pool.query('SELECT * FROM special_terms WHERE document_id = $1 ORDER BY ordinal NULLS LAST, id', [id]),
      row['doc_type'] === 'purchase_order'
        ? pool.query('SELECT * FROM purchase_order_details WHERE document_id = $1', [id])
        : pool.query('SELECT * FROM order_form_details WHERE document_id = $1', [id]),
    ]);

    res.json(present.document(row, {
      parties: parties.rows, items: items.rows, terms: terms.rows, details: details.rows[0],
    }));
  });

  app.get('/documents/:id/runs', async (req, res) => {
    const id = Number(req.params['id']);
    if (!(await documentExists(id))) return void notFound(res, `no document ${id}`);
    const { rows } = await pool.query(
      `SELECT r.*, p.version AS profile_version, d.current_run_id
         FROM extraction_runs r
         JOIN documents d ON d.id = r.document_id
         LEFT JOIN extraction_profiles p ON p.id = r.profile_id
        WHERE r.document_id = $1 ORDER BY r.started_at DESC, r.id DESC`,
      [id],
    );
    const current = rows[0] === undefined ? null : present.extractionRun(rows[0], null);
    void current;
    const currentRunId = rows[0] === undefined ? null : Number(rows[0]['current_run_id'] ?? 0) || null;
    res.json(rows.map((r) => present.extractionRun(r, currentRunId)));
  });

  app.get('/documents/:id/trace', async (req, res) => {
    const id = Number(req.params['id']);
    const { rows } = await pool.query<{ id: string; field_confidence: Record<string, unknown>; raw_text: string }>(
      `SELECT r.id, r.field_confidence, d.raw_text
         FROM documents d JOIN extraction_runs r ON r.id = d.current_run_id
        WHERE d.id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return void notFound(res, `no extraction run for document ${id}`);
    res.json({
      documentId: id,
      runId: Number(row.id),
      fields: Object.entries(row.field_confidence ?? {}).map(([field, trace]) =>
        present.tracedField(field, trace, row.raw_text),
      ),
    });
  });

  app.get('/documents/:id/file', async (req, res) => {
    const id = Number(req.params['id']);
    const { rows } = await pool.query<{ storage_key: string | null; original_filename: string }>(
      'SELECT storage_key, original_filename FROM documents WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.storage_key === null) {
      return void notFound(res, `no archived file for document ${id}`);
    }
    const bytes = await storage.get(row.storage_key);
    res.type('application/pdf');
    // The CLIENT filename is used only for the download name, never to build a
    // path — the storage key is always the content hash.
    res.setHeader('Content-Disposition', `inline; filename="${row.original_filename.replace(/"/g, '')}"`);
    res.send(bytes);
  });

  app.get('/jobs/:id', async (req, res) => {
    const row = await getJob(Number(req.params['id']));
    if (row === null) return void notFound(res, `no job ${req.params['id']}`);
    res.json(present.job(row));
  });

  app.get('/special-terms', async (req, res) => {
    const q = req.query as Query;
    const { rows } = await pool.query(
      `SELECT t.*, d.customer_id, c.slug AS customer_slug, c.name AS customer_name
         FROM special_terms t
         JOIN documents d ON d.id = t.document_id
         LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ($1::text IS NULL OR t.term_type = $1)
          AND ($2::numeric IS NULL OR t.percent >= $2)
          AND ($3::text IS NULL
               OR ($3 = 'item' AND t.item_id IS NOT NULL)
               OR ($3 = 'document' AND t.item_id IS NULL))
          AND ($4::text IS NULL OR c.slug = $4)
        ORDER BY t.document_id, t.ordinal NULLS LAST, t.id
        LIMIT $5`,
      [q['type'] ?? null, q['minPercent'] ?? null, q['scope'] ?? null, q['customer'] ?? null,
       Number(q['limit'] ?? 50)],
    );
    res.json(rows.map(present.specialTermWithDocument));
  });

  app.get('/customers', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT count(*) FROM documents d WHERE d.customer_id = c.id) AS document_count
         FROM customers c ORDER BY c.slug`,
    );
    res.json(rows.map(present.customer));
  });

  app.get('/customers/:slug/profiles', async (req, res) => {
    const slug = req.params['slug'];
    const { rows: found } = await pool.query<{ id: number }>(
      'SELECT id FROM customers WHERE slug = $1', [slug],
    );
    if (found[0] === undefined) return void notFound(res, `no customer "${slug}"`);
    const { rows } = await pool.query(
      `SELECT * FROM extraction_profiles WHERE customer_id = $1
        ORDER BY doc_type, version DESC`,
      [found[0].id],
    );
    res.json(rows.map(present.profileVersion));
  });

  // ---- correct ------------------------------------------------------------

  app.patch('/documents/:id', async (req, res) => {
    const id = Number(req.params['id']);
    const body = req.body as { customerId?: number | null; docType?: string };
    if (!(await documentExists(id))) return void notFound(res, `no document ${id}`);

    // ROUTING ONLY. Both of these change the INPUT to extraction, never its
    // output — so re-extraction regenerates every field with fresh evidence and
    // even a manual override cannot produce an unevidenced value.
    if (body.customerId !== undefined) {
      const { rows } = await pool.query(
        'SELECT 1 FROM customers WHERE id = $1', [body.customerId],
      );
      if (body.customerId !== null && rows.length === 0) {
        res.status(400).json({ error: `no customer ${body.customerId}`, code: 'BAD_REQUEST' });
        return;
      }
      await pool.query(
        `UPDATE documents SET customer_id = $2, customer_resolution = 'manual', updated_at = now()
          WHERE id = $1`,
        [id, body.customerId],
      );
    }
    if (body.docType !== undefined) {
      await pool.query(
        `UPDATE documents SET doc_type = $2::doc_type, doc_type_source = 'manual', updated_at = now()
          WHERE id = $1`,
        [id, body.docType],
      );
    }

    // The validator COERCES a declared boolean query parameter, so this arrives
    // as `false`, not `"false"`. Comparing against the string silently did
    // nothing and re-extraction ran anyway — and `Query` typing it as
    // `string | undefined` is what hid it.
    const reextract = (req.query as Record<string, unknown>)['reextract'];
    if (reextract === false || reextract === 'false') {
      res.status(202).json({ documentId: id, jobId: null, enqueued: false });
      return;
    }
    await enqueueFor(res, id, 'reextract');
  });

  app.post('/documents/:id/reprocess', async (req, res) => {
    const id = Number(req.params['id']);
    if (!(await documentExists(id))) return void notFound(res, `no document ${id}`);
    // The DELIBERATE retry path: resets attempts, which is correct after a
    // profile fix and is operator-driven, so re-dropping a failed PDF cannot
    // accumulate retries by itself.
    await pool.query(
      `UPDATE jobs SET attempts = 0 WHERE document_id = $1 AND kind = 'reextract' AND status = 'failed'`,
      [id],
    );
    await enqueueFor(res, id, 'reextract');
  });

  app.post('/documents/:id/review', async (req, res) => {
    const id = Number(req.params['id']);
    const body = req.body as { by: string; note?: string };
    // A judgement about the RECORD, not a claim about the document. It exists
    // because otherwise needs_review fills with already-approved documents.
    const { rows } = await pool.query(
      `UPDATE documents
          SET reviewed_at = now(), reviewed_by = $2, review_note = $3, updated_at = now()
        WHERE id = $1
        RETURNING id, status, reviewed_at, reviewed_by, review_note`,
      [id, body.by, body.note ?? null],
    );
    const row = rows[0];
    if (row === undefined) return void notFound(res, `no document ${id}`);
    res.json({
      id: Number(row['id']),
      status: String(row['status']),
      reviewedAt: new Date(row['reviewed_at'] as string).toISOString(),
      reviewedBy: String(row['reviewed_by']),
      note: row['review_note'] === null ? null : String(row['review_note']),
    });
  });

  app.post('/documents/reprocess', async (req, res) => {
    const q = req.query as Query;
    const filters = ['customer', 'status', 'docType', 'resolution'].filter((k) => q[k] !== undefined);
    if (filters.length === 0) {
      // An unfiltered bulk reprocess would re-bill every LLM call in the corpus.
      res.status(400).json({
        error: 'at least one of customer, status, docType, resolution is required',
        code: 'BAD_REQUEST',
      });
      return;
    }

    const { rows } = await pool.query<{ id: string }>(
      `SELECT d.id FROM documents d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ($1::text IS NULL OR c.slug = $1)
          AND ($2::text IS NULL OR d.status::text = $2)
          AND ($3::text IS NULL OR d.doc_type::text = $3)
          AND ($4::text IS NULL OR d.customer_resolution::text = $4)
        ORDER BY d.id`,
      [q['customer'] ?? null, q['status'] ?? null, q['docType'] ?? null, q['resolution'] ?? null],
    );

    // ONE JOB PER DOCUMENT, so each retries independently and progress is
    // observable, rather than one job that is all-or-nothing across dozens.
    const jobIds: number[] = [];
    let alreadyQueued = 0;
    for (const row of rows) {
      const out = await enqueue('reextract', Number(row.id));
      if (out.jobId === null) alreadyQueued++;
      else jobIds.push(out.jobId);
    }
    res.status(202).json({
      matched: rows.length, enqueued: jobIds.length, alreadyQueued, jobIds,
    });
  });
}
