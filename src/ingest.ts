import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CustomerPattern } from './classify/issuer.ts';
import { pool } from './db/pool.ts';
import { persistExtraction } from './db/repositories/persist.ts';
import { runExtraction } from './extract/pipeline.ts';
import { parsePdf } from './pdf/parse.ts';
import { loadCustomers, type DocType } from './profiles/loader.ts';
import type { ProfileDefinition } from './profiles/schema.ts';
import { buildEscalator } from './llm/client.ts';
import { env } from './config/env.ts';
import { sha256, storage } from './storage/index.ts';

const PDF_MAGIC = '%PDF-';

export interface IngestResult {
  documentId: number;
  status: 'created' | 'duplicate';
  extractionStatus?: string;
  runId?: number;
}

/**
 * Ingests one PDF: hash, archive, register, extract, persist.
 *
 * Phase 2 runs this synchronously from a CLI. Phase 8 moves it behind the job
 * queue, where the ingress path stops after registering and enqueuing.
 */
export async function ingestFile(
  path: string,
  ingress: 'poll' | 'upload' = 'poll',
): Promise<IngestResult> {
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 5).toString('latin1').startsWith(PDF_MAGIC)) {
    throw new Error(`NOT_A_PDF: ${basename(path)} does not begin with ${PDF_MAGIC}`);
  }
  const hash = sha256(bytes);

  const existing = await pool.query<{ id: number; status: string }>(
    'SELECT id, status FROM documents WHERE file_sha256 = $1',
    [hash],
  );
  if (existing.rows.length > 0 && existing.rows[0]!.status !== 'received') {
    // content-addressed dedupe: the same bytes under a different filename, from
    // either ingress, is ONE document and costs no second extraction
    return { documentId: existing.rows[0]!.id, status: 'duplicate' };
  }

  const storageKey = await storage.put(hash, bytes);
  const parsed = await parsePdf(path);
  if (parsed.rawText.trim().length === 0) {
    throw new Error(`NO_TEXT_LAYER: ${basename(path)} has no extractable text (image-only scan?)`);
  }

  const { rows: docRows } = await pool.query<{ id: number }>(
    `INSERT INTO documents (file_sha256, original_filename, ingress, page_count, raw_text, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (file_sha256) DO UPDATE SET
       raw_text = EXCLUDED.raw_text, page_count = EXCLUDED.page_count,
       storage_key = EXCLUDED.storage_key, updated_at = now()
     RETURNING id`,
    [hash, basename(path), ingress, parsed.pageCount, parsed.rawText, storageKey],
  );
  const documentId = (docRows[0] as { id: number }).id;

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
    const { rows } = await pool.query<{ id: number; definition: ProfileDefinition }>(
      `SELECT id, definition FROM extraction_profiles
       WHERE COALESCE(customer_id,0) = COALESCE($1::bigint,0) AND doc_type = $2 AND is_active`,
      [customerId, docType],
    );
    const row = rows[0];
    if (row === undefined) return null;
    usedProfileId = row.id;
    return { profileId: row.id, definition: row.definition };
  };

  const result = await runExtraction({
    parsed,
    customers: customerRows,
    patterns,
    resolveProfile,
    // Passed as a FACTORY, because the escalator needs the resolved profile as
    // well as this document's text — Acme's TAM synonyms live in its profile and
    // have to reach the prompt. Building it here instead meant they never did.
    // Returns null when LLM_MODE=off, so a failed rule is flagged rather than
    // escalated.
    escalate: buildEscalator,
  });

  const persisted = await persistExtraction({
    documentId,
    result,
    profileId: usedProfileId,
    trigger: 'ingest',
    // Records what actually ran: the model id when a call was made, null when
    // the document needed no escalation or none was available.
    engine: { pdf: 'pdfjs-dist@4.10', llm: result.llmCalls > 0 ? env.LLM_MODEL : null },
  });

  return { documentId, status: 'created', extractionStatus: persisted.status, runId: persisted.runId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage: tsx src/ingest.ts <path-to-pdf>');
    process.exit(1);
  }
  ingestFile(file)
    .then((r) => {
      console.log(JSON.stringify(r));
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
