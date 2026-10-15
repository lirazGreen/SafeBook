import type { PoolClient } from 'pg';
import type { CustomerPattern } from '../classify/issuer.ts';
import { env } from '../config/env.ts';
import { pool } from '../db/pool.ts';
import { persistExtraction } from '../db/repositories/persist.ts';
import { runExtraction } from '../extract/pipeline.ts';
import { JobError } from '../jobs/errors.ts';
import { buildEscalator } from '../llm/client.ts';
import { parsePdfBytes } from '../pdf/parse.ts';
import { loadCustomers, type DocType } from '../profiles/loader.ts';
import type { ProfileDefinition } from '../profiles/schema.ts';
import { storage } from '../storage/index.ts';

/**
 * The WORK half: re-parse the archived PDF, extract, persist.
 *
 * Runs only inside a claimed job, never in an HTTP handler or a scan. It
 * re-parses rather than replaying stored layout, so a reprocess picks up parser
 * improvements — which is why `documents.raw_text` is the only thing frozen
 * (evidence offsets index into it) and positioned runs are never persisted.
 */
export interface ExtractOptions {
  trigger: 'ingest' | 'manual_reassign' | 'profile_change' | 'bulk_reprocess';
  /** Completed in the SAME transaction as the extraction. See persist.ts. */
  jobId?: number | undefined;
  docTypeOverride?: DocType | undefined;
  customerIdOverride?: number | undefined;
}

export async function extractDocument(
  documentId: number,
  options: ExtractOptions,
): Promise<{ runId: number; status: string; llmCalls: number }> {
  const { rows } = await pool.query<{
    storage_key: string | null;
    doc_type: DocType | null;
    customer_id: string | null;
  }>('SELECT storage_key, doc_type, customer_id FROM documents WHERE id = $1', [documentId]);
  const doc = rows[0];
  if (doc === undefined) throw new JobError('UNKNOWN', `no document ${documentId}`);
  if (doc.storage_key === null) {
    throw new JobError('STORAGE_UNAVAILABLE', `document ${documentId} has no archived file`);
  }

  const parsed = await parse(documentId, doc.storage_key);
  if (parsed.rawText.trim().length === 0) {
    // The image-only scan case. Detected and countable, never mis-extracted as
    // an empty document — and PERMANENT, because a retry finds the same absence.
    throw new JobError('NO_TEXT_LAYER', `NO_TEXT_LAYER: document ${documentId} has no extractable text`);
  }

  const customersYaml = await loadCustomers();
  const { rows: customerRows } = await pool.query<{ id: number; slug: string; name: string }>(
    'SELECT id, slug, name FROM customers ORDER BY id',
  );
  const idBySlug = new Map(customerRows.map((c) => [c.slug, c.id]));
  const patterns: CustomerPattern[] = customersYaml.flatMap((c) =>
    c.match.map((m) => ({
      customerId: idBySlug.get(c.slug) ?? -1,
      slug: c.slug,
      kind: m.kind,
      pattern: m.pattern,
    })),
  );

  let usedProfileId: number | null = null;
  const resolveProfile = async (customerId: number | null, docType: DocType) => {
    const { rows: profileRows } = await pool.query<{ id: number; definition: ProfileDefinition }>(
      `SELECT id, definition FROM extraction_profiles
        WHERE COALESCE(customer_id,0) = COALESCE($1::bigint,0) AND doc_type = $2 AND is_active`,
      [customerId, docType],
    );
    const row = profileRows[0];
    if (row === undefined) return null;
    usedProfileId = row.id;
    return { profileId: row.id, definition: row.definition };
  };

  const result = await runExtraction({
    parsed,
    customers: customerRows,
    patterns,
    resolveProfile,
    // A FACTORY: the escalator needs the resolved profile as well as the
    // document text, because per-customer wording hints live in the profile.
    escalate: buildEscalator,
    ...(options.docTypeOverride !== undefined ? { docTypeOverride: options.docTypeOverride } : {}),
    ...(options.customerIdOverride !== undefined
      ? { customerIdOverride: options.customerIdOverride }
      : {}),
  });

  const persisted = await persistExtraction({
    documentId,
    result,
    rawText: parsed.rawText,
    pageCount: parsed.pageCount,
    profileId: usedProfileId,
    trigger: options.trigger,
    engine: { pdf: 'pdfjs-dist@4.10', llm: result.llmCalls > 0 ? env.LLM_MODEL : null },
    ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
  });

  return { ...persisted, llmCalls: result.llmCalls };
}

/**
 * Wraps pdfjs failures into classified JobErrors.
 *
 * `PDF_CORRUPT` and `PDF_ENCRYPTED` were declared in the error taxonomy from the
 * start and NOTHING EVER RAISED THEM: a truncated PDF came through as a bare
 * pdfjs exception, classified UNKNOWN and therefore transient, so it was retried
 * three times. Found by dropping a half-written file into the inbox, which is
 * also the case the stability gate exists to prevent — the gate stops a file
 * being read mid-copy, but a genuinely truncated file is still possible and must
 * fail once, permanently.
 */
async function parse(documentId: number, storageKey: string) {
  try {
    return await parsePdfBytes(await storage.get(storageKey));
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'PasswordException' || /password/i.test(message)) {
      throw new JobError('PDF_ENCRYPTED', `PDF_ENCRYPTED: document ${documentId} is password-protected`, { cause: err });
    }
    if (name.endsWith('PDFException') || /invalid pdf|xref|structure/i.test(message)) {
      throw new JobError('PDF_CORRUPT', `PDF_CORRUPT: document ${documentId} could not be parsed — ${message}`, { cause: err });
    }
    throw err;
  }
}

export type { PoolClient };
