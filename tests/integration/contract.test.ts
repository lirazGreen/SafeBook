import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createApp, SPEC_PATH } from '../../src/api/server.ts';
import { pool } from '../../src/db/pool.ts';
import { extractDocument } from '../../src/ingest/extract.ts';
import { registerBytes } from '../../src/ingest/register.ts';
import { claim, finish } from '../../src/jobs/repo.ts';

/**
 * Exercises every operation in `openapi.yaml` against a real database.
 *
 * The point is not the status codes — it is that `express-openapi-validator` is
 * validating RESPONSES with `additionalProperties: false` throughout. So this
 * suite fails if a handler returns an undeclared field, omits a required one, or
 * renders a date in the wrong format. The hand-written spec therefore cannot
 * silently drift from behaviour, which is the only thing that makes "spec-first"
 * mean anything.
 *
 * A response-validation failure surfaces as a **500 with code INTERNAL**, named
 * distinctly so it cannot be mistaken for a client error.
 */
let available = false;
try {
  await pool.query('SELECT 1 FROM jobs LIMIT 1');
  await pool.query('SELECT 1 FROM extraction_profiles WHERE is_active LIMIT 1');
  available = true;
} catch (err) {
  console.log(
    '[skip] contract test needs Postgres, a migrated schema and `npm run seed`: ' +
      (err instanceof Error ? err.message : String(err)),
  );
}
const maybe = available ? it : it.skip;

const app = createApp();
const api = () => request(app);
const NONCE = `${process.pid}-${Date.now()}`;
const created: number[] = [];

/** A PO, because neither purchase order escalates — so it extracts fully offline. */
async function seedExtractedDocument(): Promise<number> {
  const bytes = await readFile('sample docs/Purchase Order – BrightOps Analytics Ltd.pdf');
  // Nonce appended as a PDF comment after %%EOF: changes the sha256 while
  // leaving the document byte-identical to parse, so the test database (which
  // persists between runs) always sees a genuinely new document.
  const tagged = Buffer.concat([bytes, Buffer.from(`\n% contract-test-${NONCE}\n`)]);
  const { documentId } = await registerBytes(tagged, 'contract-test.pdf', 'upload');
  created.push(documentId);

  for (let i = 0; i < 6; i++) {
    const job = await claim();
    if (job === null) break;
    if (job.kind === 'ingest' && job.documentId === documentId) {
      await extractDocument(documentId, { trigger: 'ingest', jobId: job.id });
    } else {
      await finish(job.id);
    }
  }
  return documentId;
}

const docId = available ? await seedExtractedDocument() : 0;

afterAll(async () => {
  for (const id of created) await pool.query('DELETE FROM documents WHERE id = $1', [id]).catch(() => {});
  await pool.end().catch(() => {});
});

describe('the spec is served and complete', () => {
  maybe('every operation in the spec is covered by a test in this file', async () => {
    // Guards against adding an endpoint to the spec and forgetting to exercise
    // it — at which point response validation would never run against it.
    const spec = parseYaml(await readFile(SPEC_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const declared = Object.values(spec.paths)
      .flatMap((p) => Object.entries(p))
      .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
      .map(([, op]) => op.operationId as string);

    const source = await readFile('tests/integration/contract.test.ts', 'utf8');
    const uncovered = declared.filter((id) => !source.includes(`[${id}]`));
    expect(uncovered).toEqual([]);
    expect(declared.length).toBe(16);
  });

  maybe('serves the raw spec and the Swagger UI', async () => {
    await api().get('/openapi.json').expect(200).expect('Content-Type', /json/);
    // Swagger UI renders a real file picker for the multipart upload, so the
    // samples can be submitted from a browser.
    await api().get('/docs/').expect(200).expect('Content-Type', /html/);
  });
});

describe('inspect', () => {
  maybe('[getHealth]', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  maybe('[listDocuments] and its filters', async () => {
    const res = await api().get('/documents?limit=5').expect(200);
    expect(res.body.documents.length).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ limit: 5, offset: 0 });
    // mm-dd-yyyy at the boundary, and money as a decimal STRING
    const doc = res.body.documents.find((d: { id: number }) => d.id === docId);
    expect(doc.startDate).toBe('03-01-2025');
    expect(doc.amount).toBe('162000.00');
    expect(doc.customer).toMatchObject({ slug: 'brightops' });

    await api().get('/documents?status=extracted&docType=purchase_order').expect(200);
    await api().get('/documents?resolution=unmatched&reason=FIELD_NOT_FOUND').expect(200);
    await api().get('/documents?hasInferred=true').expect(200);
  });

  maybe('[listDocuments] REJECTS an unknown query parameter rather than ignoring it', async () => {
    // A silently-ignored filter is worse than an error: the caller believes it
    // applied. `allowUnknownQueryParameters: false` is what makes that loud.
    const res = await api().get('/documents?customerSlug=brightops').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  maybe('[getDocument]', async () => {
    const res = await api().get(`/documents/${docId}`).expect(200);
    expect(res.body).toMatchObject({
      docType: 'purchase_order',
      status: 'extracted',
      amount: '162000.00',
      currency: 'USD',
      paymentTerms: 'Net 30',          // stored as an integer, rendered here
      startDate: '03-01-2025',
    });
    expect(res.body.typeDetails).toEqual({ poNumber: 'PO-BO-10458', poDate: '02-15-2025' });
    expect(res.body.items).toHaveLength(4);
    expect(res.body.parties.map((p: { role: string }) => p.role)).toEqual(['buyer', 'vendor']);
    // A PO's vendor never signs: null is the CORRECT answer, not a miss.
    expect(res.body.parties.find((p: { role: string }) => p.role === 'vendor').signaturePresent).toBeNull();
    expect(res.body.specialTerms.map((t: { termType: string }) => t.termType))
      .toEqual(['burst', 'technical_account_manager']);
  });

  maybe('[getDocument] 404s cleanly, with the shared error shape', async () => {
    const res = await api().get('/documents/999999').expect(404);
    expect(res.body).toEqual({ error: 'no document 999999', code: 'NOT_FOUND' });
  });

  maybe('[getTrace] re-slices raw_text and PROVES the evidence', async () => {
    const res = await api().get(`/documents/${docId}/trace`).expect(200);
    expect(res.body.documentId).toBe(docId);
    const amount = res.body.fields.find((f: { field: string }) => f.field === 'amount');
    expect(amount.evidence.text).toBe('$162,000 USD');
    // Recomputed on read, not trusted: a quoted string alone could itself be
    // wrong, since a model can hallucinate its own citation.
    expect(amount.evidenceVerified).toBe(true);
    // Rule-sourced values carry offsets too, so traceability has no exception
    // for the deterministic path.
    expect(amount.source).toBe('rule');
  });

  maybe('[listRuns]', async () => {
    const res = await api().get(`/documents/${docId}/runs`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ trigger: 'ingest', outcome: 'ok', isCurrent: true });
    // llmCalls counts calls ACTUALLY made; a PO escalates nothing.
    expect(res.body[0].llmCalls).toBe(0);
  });

  maybe('[getDocumentFile] returns the archived bytes', async () => {
    const res = await api().get(`/documents/${docId}/file`).expect(200).expect('Content-Type', /pdf/);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  maybe('[getJob]', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM jobs WHERE document_id = $1 ORDER BY id LIMIT 1', [docId],
    );
    const res = await api().get(`/jobs/${Number(rows[0]!.id)}`).expect(200);
    expect(res.body).toMatchObject({ kind: 'ingest', status: 'done', documentId: docId });
    expect(res.body.attempts).toBeGreaterThanOrEqual(1);
  });

  maybe('[listSpecialTerms] across documents', async () => {
    const res = await api().get('/special-terms?type=burst&limit=50').expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((t: { termType: string }) => t.termType === 'burst')).toBe(true);
    // term_text is the source of truth; the parsed columns are a projection
    expect(res.body[0].termText.length).toBeGreaterThan(0);

    await api().get('/special-terms?minPercent=5&scope=document').expect(200);
    await api().get('/special-terms?customer=brightops').expect(200);
  });

  maybe('[listCustomers]', async () => {
    const res = await api().get('/customers').expect(200);
    expect(res.body.map((c: { slug: string }) => c.slug))
      .toEqual(['acme', 'brightops', 'cloudshield', 'novafleet']);
  });

  maybe('[listCustomerProfiles] shows version history', async () => {
    const res = await api().get('/customers/cloudshield/profiles').expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    // `definition` is the MERGED result — extends already resolved, so the row
    // is self-contained and the audit never needs a re-merge.
    expect(res.body[0].definition['doc_type']).toBe('order_form');
    expect(res.body[0].isActive).toBe(true);
    await api().get('/customers/nobody/profiles').expect(404);
  });
});

describe('ingest', () => {
  maybe('[uploadDocuments] 202 for a good file, and dedupes by CONTENT', async () => {
    const bytes = await readFile('sample docs/Purchase Order – NovaFleet Technologies Inc.pdf');
    const tagged = Buffer.concat([bytes, Buffer.from(`\n% contract-upload-${NONCE}\n`)]);

    const first = await api().post('/documents').attach('file', tagged, 'novafleet.pdf').expect(202);
    expect(first.body).toHaveLength(1);
    expect(first.body[0]).toMatchObject({ file: 'novafleet.pdf', status: 'queued' });
    created.push(first.body[0].documentId);

    // The same bytes under a DIFFERENT filename: one document, no second job, so
    // the re-upload costs nothing in LLM calls.
    const again = await api()
      .post('/documents')
      .attach('file', tagged, 'someone-elses-name.pdf')
      .expect(202);
    expect(again.body[0]).toMatchObject({ status: 'duplicate', jobId: null });
    expect(again.body[0].documentId).toBe(first.body[0].documentId);
  });

  maybe('[uploadDocuments] 207 when one file in a batch is bad', async () => {
    const good = Buffer.concat([
      await readFile('sample docs/ACME Order From.pdf'),
      Buffer.from(`\n% contract-batch-${NONCE}\n`),
    ]);
    const res = await api()
      .post('/documents')
      .attach('file', good, 'acme.pdf')
      .attach('file', Buffer.from('this is plainly not a pdf'), 'notes.docx')
      .expect(207);

    const byName = Object.fromEntries(res.body.map((r: { file: string }) => [r.file, r]));
    expect(byName['acme.pdf'].status).toBe('queued');
    created.push(byName['acme.pdf'].documentId);
    // Magic bytes, not Content-Type — which is client-supplied and lies.
    expect(byName['notes.docx']).toMatchObject({ status: 'rejected', code: 'NOT_A_PDF' });
    expect(byName['notes.docx'].error).toContain('%PDF-');
  });

  maybe('[scanInbox] coalesces repeat calls', async () => {
    const first = await api().post('/scan').expect(202);
    expect(first.body.jobId).not.toBeNull();
    const second = await api().post('/scan').expect(202);
    // A partial unique index caps pending document-less jobs at one per kind.
    expect(second.body.coalesced).toBe(true);
    expect(second.body.jobId).toBe(first.body.jobId);
    await finish(first.body.jobId, { found: 0, enqueued: 0, duplicate: 0, unstable: 0, rejected: 0 });
  });
});

describe('correct — routing and acknowledgement only', () => {
  maybe('[patchDocument] reassigns the customer and enqueues re-extraction', async () => {
    const res = await api()
      .patch(`/documents/${docId}`)
      .send({ customerId: 1 })
      .expect(202);
    expect(res.body).toMatchObject({ documentId: docId, enqueued: true });

    const { rows } = await pool.query('SELECT customer_resolution FROM documents WHERE id = $1', [docId]);
    // Recorded as `manual`, so the audit shows a human decided the routing.
    expect(rows[0]!['customer_resolution']).toBe('manual');
  });

  maybe('[patchDocument] with ?reextract=false records the change and enqueues NOTHING', async () => {
    // The validator COERCES a declared boolean query parameter, so the handler
    // receives `false` rather than `"false"`. Comparing against the string
    // silently did nothing and re-extraction ran anyway.
    const res = await api()
      .patch(`/documents/${docId}?reextract=false`)
      .send({ docType: 'purchase_order' })
      .expect(202);
    expect(res.body).toEqual({ documentId: docId, jobId: null, enqueued: false });
  });

  maybe('[patchDocument] REFUSES to write an extracted value', async () => {
    // The spec says additionalProperties: false, so this is rejected by the
    // contract rather than by a hand-written check that could be forgotten.
    const res = await api().patch(`/documents/${docId}`).send({ amount: '1.00' }).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    await api().patch(`/documents/${docId}`).send({}).expect(400);              // minProperties
    await api().patch(`/documents/${docId}`).send({ docType: 'invoice' }).expect(400);
  });

  maybe('[reprocessDocument]', async () => {
    const res = await api().post(`/documents/${docId}/reprocess`).expect(202);
    expect(res.body.documentId).toBe(docId);
    await api().post('/documents/999999/reprocess').expect(404);
  });

  maybe('[reviewDocument] records a judgement about the RECORD', async () => {
    const res = await api()
      .post(`/documents/${docId}/review`)
      .send({ by: 'liraz', note: 'checked against the PDF' })
      .expect(200);
    expect(res.body).toMatchObject({ id: docId, reviewedBy: 'liraz', note: 'checked against the PDF' });
    await api().post(`/documents/${docId}/review`).send({}).expect(400);        // `by` is required
  });

  maybe('[reprocessDocuments] requires a filter', async () => {
    // An unfiltered bulk reprocess would re-bill every LLM call in the corpus.
    const refused = await api().post('/documents/reprocess').expect(400);
    expect(refused.body.error).toContain('at least one of');

    const res = await api().post('/documents/reprocess?customer=brightops').expect(202);
    expect(res.body.matched).toBeGreaterThanOrEqual(0);
    expect(res.body).toHaveProperty('jobIds');
  });

  maybe('[reprocessDocuments] filters by review REASON, for targeted recovery', async () => {
    // The case this exists for: a document processed while no API key was
    // configured is flagged FIELD_NOT_FOUND and NOTHING FAILED, so nothing
    // retries it — unlike an API outage, which is classed transient and recovers
    // on its own. `?status=needs_review` would also re-run everything in review
    // for unrelated reasons, re-billing them.
    const res = await api().post('/documents/reprocess?reason=FIELD_NOT_FOUND').expect(202);
    expect(res.body).toHaveProperty('matched');

    // and it is a real filter, not accepted-and-ignored
    const none = await api().post('/documents/reprocess?reason=BURST_UNATTRIBUTED').expect(202);
    expect(none.body.matched).toBe(0);

    // an unknown code is rejected by the spec rather than silently matching nothing
    await api().post('/documents/reprocess?reason=NOT_A_REAL_CODE').expect(400);
  });
});
