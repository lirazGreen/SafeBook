import { basename } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.ts';
import { JobError } from '../jobs/errors.ts';
import { enqueue } from '../jobs/repo.ts';
import { sha256, storage } from '../storage/index.ts';
import { env } from '../config/env.ts';

/**
 * The INGRESS half: hash, archive, register the document, enqueue the work.
 *
 * Nothing is parsed here. Both ingresses — the polling timer and
 * `POST /documents` — converge on this one function and stop, because parsing a
 * PDF is CPU-bound and single-threaded (it blocks Node's event loop) and
 * extraction makes network calls. Neither belongs in an HTTP handler or inside a
 * directory scan.
 */
const PDF_MAGIC = '%PDF-';

export interface RegisterResult {
  documentId: number;
  /** True when these exact bytes were already registered. No second job. */
  duplicate: boolean;
  jobId: number | null;
}

/**
 * Registers one PDF's bytes.
 *
 * Dedupe is by CONTENT, not by filename or ingress: the same bytes arriving in
 * the folder and by upload is ONE document and ONE job, so no second round of
 * LLM calls. Verified with deliberately different filenames.
 */
export async function registerBytes(
  bytes: Buffer,
  filename: string,
  ingress: 'poll' | 'upload',
): Promise<RegisterResult> {
  if (!bytes.subarray(0, 5).toString('latin1').startsWith(PDF_MAGIC)) {
    // Content-Type is client-supplied and lies, so the magic bytes decide.
    throw new JobError('NOT_A_PDF', `NOT_A_PDF: ${basename(filename)} does not begin with ${PDF_MAGIC}`);
  }
  if (bytes.byteLength > env.MAX_UPLOAD_BYTES) {
    throw new JobError(
      'FILE_TOO_LARGE',
      `FILE_TOO_LARGE: ${bytes.byteLength} bytes exceeds MAX_UPLOAD_BYTES=${env.MAX_UPLOAD_BYTES}`,
    );
  }

  const hash = sha256(bytes);

  // Archived BEFORE the transaction. Safe because the key is the content hash,
  // so a retry overwrites identical bytes; an orphaned archive file after a
  // failed transaction is harmless and sweepable.
  //
  // The client filename never reaches the path — the key is always
  // `<sha256>.pdf` — so `../../etc/passwd` as a filename is inert by
  // construction, not by sanitising.
  const storageKey = await storage.put(hash, bytes);

  return pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await insertAndEnqueue(client, { hash, filename, ingress, storageKey });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

async function insertAndEnqueue(
  client: PoolClient,
  args: { hash: string; filename: string; ingress: 'poll' | 'upload'; storageKey: string },
): Promise<RegisterResult> {
  // `DO NOTHING` is required, not optional: a poll tick and an upload can land
  // the same bytes simultaneously, and without it the loser raises a unique
  // violation — a 500 for what is really a successful no-op.
  //
  // `ingress` is deliberately NOT overwritten on a cross-ingress duplicate: the
  // FIRST arrival is the one that was actually processed, which is what makes the
  // column answer "why did this document appear?".
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO documents (file_sha256, original_filename, ingress, storage_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (file_sha256) DO NOTHING
     RETURNING id`,
    [args.hash, basename(args.filename), args.ingress, args.storageKey],
  );

  // Number(), because the driver returns BIGINT as a STRING. Without it the id
  // flowed out as "26" and compared unequal to 26 everywhere downstream — which
  // silently broke the claim loop's `job.documentId === documentId` check and
  // failed response validation against `type: integer`.
  const inserted = rows[0];
  if (inserted !== undefined) {
    const documentId = Number(inserted.id);
    const { jobId } = await enqueue('ingest', documentId, null, client);
    return { documentId, duplicate: false, jobId };
  }

  const { rows: existing } = await client.query<{ id: string }>(
    'SELECT id FROM documents WHERE file_sha256 = $1',
    [args.hash],
  );
  return { documentId: Number((existing[0] as { id: string }).id), duplicate: true, jobId: null };
}

/** Whether these bytes are already known, so a scan can skip them cheaply. */
export async function isKnown(hash: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM documents WHERE file_sha256 = $1', [hash]);
  return rows.length > 0;
}
