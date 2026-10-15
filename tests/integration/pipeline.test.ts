import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.ts';
import { extractDocument } from '../../src/ingest/extract.ts';
import { claim, fail, finish, getJob } from '../../src/jobs/repo.ts';
import { sha256 } from '../../src/storage/index.ts';
import { resetStabilityCache, scanInbox } from '../../src/poller/scan.ts';

/**
 * Phase 8's exit criterion, automated: drop PDFs in a folder and every one of
 * them lands in the database, routed by CONTENT.
 *
 * Two things make it safe to run against a shared development database:
 *
 * 1. It sweeps a TEMP directory, not the real `inbox/` — which a running worker
 *    is also sweeping, so a test pointed there would race whatever the developer
 *    had dropped in.
 * 2. Each copy gets a PER-RUN NONCE appended as a PDF comment after `%%EOF`.
 *    That changes the sha256 while leaving the document byte-identical to parse
 *    (verified: same page count, same text, same runs), so the test always
 *    exercises a genuinely NEW document. Without it the very first run inserts
 *    the four samples, and every run after that finds them already known and
 *    silently tests nothing — which is exactly what happened.
 *
 * Needs Postgres and skips itself without one, like the queue tests.
 */
let available = false;
try {
  await pool.query('SELECT 1 FROM jobs LIMIT 1');
  await pool.query('SELECT 1 FROM extraction_profiles WHERE is_active LIMIT 1');
  available = true;
} catch (err) {
  console.log(
    '[skip] pipeline integration test needs Postgres, a migrated schema and `npm run seed`: ' +
      (err instanceof Error ? err.message : String(err)),
  );
}
const maybe = available ? it : it.skip;

const NONCE = `${process.pid}-${Date.now()}`;
const created: number[] = [];
let inbox: string | null = null;

/** Copies a sample in, made content-unique but parse-identical. */
async function drop(sample: string, as: string): Promise<void> {
  const bytes = await readFile(join('sample docs', sample));
  await writeFile(
    join(inbox as string, as),
    Buffer.concat([bytes, Buffer.from(`\n% safebook-test-${NONCE}\n`)]),
  );
}

afterAll(async () => {
  for (const id of created) await pool.query('DELETE FROM documents WHERE id = $1', [id]).catch(() => {});
  // Belt and braces: a run that fails BEFORE recording an id would otherwise
  // leak the row, and the next run then sees its own document as a duplicate.
  await pool
    .query(`DELETE FROM documents WHERE original_filename = 'half-written.pdf'`)
    .catch(() => {});
  if (inbox !== null) await rm(inbox, { recursive: true, force: true });
  await pool.end().catch(() => {});
});

/**
 * Settles every job for the documents this test created, the way the worker
 * does — including the failure path.
 *
 * COOPERATIVE on purpose. The queue is shared, so a worker left running during
 * development claims the test's jobs out from under it; the first version used
 * `claim()` exclusively and reported 1 extraction instead of 2 for exactly that
 * reason. Looping until every job reaches a terminal state means the assertions
 * hold whoever did the work.
 */
async function settleAll(timeoutMs = 30_000): Promise<{ extracted: number; failed: string[] }> {
  let extracted = 0;
  const failed: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM jobs
        WHERE document_id = ANY($1::bigint[]) AND status IN ('queued','running')`,
      [created.length === 0 ? [0] : created],
    );
    if (Number(rows[0]!.n) === 0) break;

    const job = await claim();
    if (job === null) { await new Promise((r) => setTimeout(r, 100)); continue; }
    if (job.kind !== 'ingest' || job.documentId === null) { await finish(job.id); continue; }
    try {
      await extractDocument(job.documentId, { trigger: 'ingest', jobId: job.id });
      // `finish` happened INSIDE the extraction transaction, via jobId — so a
      // crash can never separate the data from the completion.
      expect((await getJob(job.id))!['status']).toBe('done');
      extracted++;
    } catch (err) {
      const outcome = await fail(job, err);
      expect(outcome.willRetry).toBe(false);
      failed.push(outcome.code);
    }
  }
  return { extracted, failed };
}

/** The document id for a dropped file, found by CONTENT the way the scan does. */
async function documentIdFor(sample: string): Promise<number> {
  const bytes = await readFile(join('sample docs', sample));
  const hash = sha256(Buffer.concat([bytes, Buffer.from(`\n% safebook-test-${NONCE}\n`)]));
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM documents WHERE file_sha256 = $1', [hash]);
  return Number((rows[0] as { id: string }).id);
}
describe('folder -> queue -> database', () => {
  maybe('ingests every PDF dropped in the folder, and extracts each one', async () => {
    inbox = await mkdtemp(join(tmpdir(), 'safebook-inbox-'));
    resetStabilityCache();

    // A nested path on purpose: the sweep is recursive, so folder nesting can
    // never break ingestion.
    await mkdir(join(inbox, 'dropped'), { recursive: true });
    for (const f of await readdir('sample docs')) {
      if (f.endsWith('.pdf')) await drop(f, join('dropped', f));
    }

    // TWO sweeps. The first sees files with no previous tick to compare against
    // and holds them back; the second releases them.
    const first = await scanInbox(inbox);
    expect(first).toMatchObject({ found: 4, enqueued: 0, unstable: 4 });
    const second = await scanInbox(inbox);
    expect(second).toMatchObject({ found: 4, enqueued: 4, unstable: 0, duplicate: 0, rejected: 0 });

    // Collect the ids BEFORE settling, so the assertions do not depend on who
    // ran the jobs.
    for (const f of await readdir('sample docs')) {
      if (f.endsWith('.pdf')) created.push(await documentIdFor(f));
    }
    expect(new Set(created).size).toBe(4);

    const settled = await settleAll();

    // ALL FOUR extract completely, including the two order forms whose prose
    // fields escalate — their recorded fixtures are replayed, so no call is made
    // and nothing needs a key.
    //
    // This assertion previously expected two LLM_FIXTURE_MISSING failures, which
    // was correct when nothing had been recorded. It failed the moment the
    // fixtures landed, which is the test doing its job.
    expect(settled.failed).toEqual([]);
    expect(settled.extracted).toBe(4);
    const { rows } = await pool.query<{ slug: string; doc_type: string; amount: string; currency: string; items: string; ingress: string }>(
      `SELECT c.slug, d.doc_type, d.amount, d.currency, d.ingress,
              (SELECT count(*) FROM document_items i WHERE i.document_id = d.id) AS items
         FROM documents d JOIN customers c ON c.id = d.customer_id
        WHERE d.id = ANY($1::bigint[]) ORDER BY c.slug`,
      [created],
    );
    // Routed by CONTENT. The filenames play no part — one even misspells "Form",
    // and two are named after the buyer while two are named after the vendor.
    expect(rows.map((r) => [r.slug, r.doc_type, Number(r.amount), r.currency, Number(r.items), r.ingress])).toEqual([
      ['acme', 'order_form', 152500, 'USD', 5, 'poll'],
      ['brightops', 'purchase_order', 162000, 'USD', 4, 'poll'],
      ['cloudshield', 'order_form', 23640000, 'USD', 6, 'poll'],
      ['novafleet', 'purchase_order', 451000, 'USD', 4, 'poll'],
    ]);

    // Every one archived — never half written and never silently absent.
    const { rows: all } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM documents
        WHERE id = ANY($1::bigint[]) AND storage_key IS NOT NULL`,
      [created],
    );
    expect(Number(all[0]!.n)).toBe(4);
  }, 60_000);

  maybe('a re-dropped file costs NOTHING — no second document and no second job', async () => {
    // Content-addressed, so this holds under a DIFFERENT filename: the same bytes
    // arriving twice is one document and one extraction, not two rounds of LLM
    // calls.
    await drop('ACME Order From.pdf', 'renamed-by-someone-else.pdf');
    await scanInbox(inbox as string);
    const summary = await scanInbox(inbox as string);

    expect(summary).toMatchObject({ found: 5, enqueued: 0, duplicate: 5 });
    expect(await claim()).toBeNull();
  }, 30_000);

  maybe('holds back a file that is still being written, and judges it on the next tick', async () => {
    // This replaces what a watcher's awaitWriteFinish would have given us, and it
    // is not optional: a tick can otherwise catch a half-copied file — Acme's
    // 191 KB is not copied instantaneously — or, on a cloud drive, one that has
    // appeared but not finished syncing.
    //
    // NOTE: no resetStabilityCache() here. Clearing it would make all six files
    // look new and the assertion meaningless, which is how the first version of
    // this test "passed" against 6 instead of 1.
    const partial = join(inbox as string, 'half-written.pdf');
    // NONCE here too. Without it the truncated bytes are identical every run, so
    // the first run registers them and every run after that reports `duplicate`
    // instead of `enqueued` — which is how this assertion first failed.
    await writeFile(partial, Buffer.from(`%PDF-1.7\nnot finished yet ${NONCE}`));

    const first = await scanInbox(inbox as string);
    expect(first.unstable).toBe(1);        // only the new file; the rest are known stable

    const before = await stat(partial);
    const second = await scanInbox(inbox as string);
    // Unchanged since the previous tick, so now eligible — and ACCEPTED by the
    // scan, whose only content check is the `%PDF-` magic bytes, which a
    // truncated file still has. The scan stays cheap on purpose; judging the
    // document is the job's work.
    expect(second.unstable).toBe(0);
    expect(second.enqueued).toBe(1);
    expect((await stat(partial)).mtimeMs).toBe(before.mtimeMs);   // never modified by us

    // ...and it fails ONCE, permanently. PDF_CORRUPT was declared in the error
    // taxonomy from the start and NOTHING EVER RAISED IT: a truncated PDF came
    // through as a bare pdfjs exception, classified UNKNOWN and therefore
    // transient, so it was retried three times. Found by this test.
    const job = (await claim())!;
    expect(job.kind).toBe('ingest');
    created.push(job.documentId as number);
    const err = await extractDocument(job.documentId as number, { trigger: 'ingest', jobId: job.id })
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/^PDF_CORRUPT/);
    expect(await fail(job, err)).toMatchObject({
      code: 'PDF_CORRUPT', errorClass: 'permanent', willRetry: false,
    });
    expect((await getJob(job.id))!['status']).toBe('failed');
  }, 30_000);
});
