import { hostname } from 'node:os';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.ts';
import { backoffMs, classifyError, MAX_ATTEMPTS, type ErrorClass, type ErrorCode } from './errors.ts';

/**
 * The job queue. Postgres IS the queue — no Redis.
 *
 * `FOR UPDATE SKIP LOCKED` is the idiomatic Postgres pattern: each worker locks
 * exactly the row it claims and skips rows another worker already holds, so
 * concurrency needs no external coordination and a crashed worker's row is
 * recovered by the stale-lock sweep rather than lost.
 */
export type JobKind = 'scan_inbox' | 'ingest' | 'reextract' | 'reresolve_customer';

export interface Job {
  id: number;
  kind: JobKind;
  documentId: number | null;
  payload: Record<string, unknown> | null;
  attempts: number;
}

/** `${host}:${pid}`, recorded on the claim purely so a stuck job is traceable. */
export const WORKER_ID = `${hostname()}:${process.pid}`;

/**
 * A `running` job whose lock is older than this returns to `queued`.
 *
 * Generous on purpose: it has to exceed the slowest legitimate job, and a
 * CloudShield extraction with several LLM calls is seconds, not milliseconds.
 * Reclaiming too eagerly would hand a document to a second worker while the
 * first is still working on it.
 */
export const STALE_LOCK_MS = 5 * 60 * 1000;

/**
 * Enqueues work, or does nothing if the same work is already pending.
 *
 * The no-op is enforced by partial unique indexes rather than by a SELECT first:
 * `(document_id, kind) WHERE status IN ('queued','running')` and
 * `(kind) WHERE document_id IS NULL AND …`. So a poll tick and an upload racing
 * on the same bytes cannot both enqueue, and hammering `POST /scan` coalesces
 * into one sweep instead of a hundred redundant ones — without a lock.
 */
export async function enqueue(
  kind: JobKind,
  documentId: number | null = null,
  payload: Record<string, unknown> | null = null,
  client: PoolClient | null = null,
): Promise<{ jobId: number | null; alreadyQueued: boolean }> {
  const q = client ?? pool;
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO jobs (kind, document_id, payload) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [kind, documentId, payload],
  );
  const row = rows[0];
  // BIGSERIAL comes back as a string from the driver; Number() here so a job id
  // is one type everywhere, the way claim() already returns it.
  return row === undefined
    ? { jobId: null, alreadyQueued: true }
    : { jobId: Number(row.id), alreadyQueued: false };
}

/**
 * Claims the oldest runnable job, or null when there is nothing to do.
 *
 * `attempts` is incremented HERE, at claim time, not on failure. That is what
 * stops a worker crash-looping on one document from retrying forever: a process
 * killed mid-job has already paid for the attempt, so the stale-lock sweep
 * returns the job to the queue with its budget already spent.
 */
export async function claim(): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs
                   WHERE status = 'queued' AND run_after <= now()
                   ORDER BY created_at
                   FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, document_id, payload, attempts`,
    [WORKER_ID],
  );
  const r = rows[0];
  return r === undefined
    ? null
    : {
        id: Number(r['id']),
        kind: r['kind'] as JobKind,
        documentId: r['document_id'] === null ? null : Number(r['document_id']),
        payload: r['payload'] as Record<string, unknown> | null,
        attempts: Number(r['attempts']),
      };
}

/**
 * Marks a job done.
 *
 * Takes an optional client so it can run INSIDE the transaction that wrote the
 * extraction. That is the whole point: a crash can then never leave a job marked
 * done with no data, or data with a job still `running`.
 */
export async function finish(
  jobId: number,
  result: Record<string, unknown> | null = null,
  client: PoolClient | null = null,
): Promise<void> {
  await (client ?? pool).query(
    `UPDATE jobs SET status = 'done', result = $2, error = NULL, error_code = NULL,
                     error_class = NULL, finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [jobId, result],
  );
}

export interface FailureOutcome {
  code: ErrorCode;
  errorClass: ErrorClass;
  /** False when the job is terminal: permanent, or out of attempts. */
  willRetry: boolean;
  retryInMs: number | null;
}

/**
 * Records a failure, and decides whether it comes back.
 *
 * A PERMANENT failure sets `status='failed'` immediately rather than burning
 * through MAX_ATTEMPTS — retrying a corrupt PDF three times produces three
 * identical failures and, where LLM calls are involved, three identical bills.
 */
export async function fail(job: Job, err: unknown): Promise<FailureOutcome> {
  const { code, errorClass, message } = classifyError(err);
  const willRetry = errorClass === 'transient' && job.attempts < MAX_ATTEMPTS;
  const retryInMs = willRetry ? backoffMs(job.attempts - 1) : null;

  await pool.query(
    `UPDATE jobs SET status = $2, error = $3, error_code = $4, error_class = $5,
                     run_after = now() + make_interval(secs => $6::float8),
                     finished_at = CASE WHEN $2 = 'failed' THEN now() END,
                     locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [
      job.id, willRetry ? 'queued' : 'failed',
      // The MESSAGE is stored, never the document text it may quote: these are
      // customer contracts and logs must not carry content.
      message.slice(0, 2000), code, errorClass, (retryInMs ?? 0) / 1000,
    ],
  );
  return { code, errorClass, willRetry, retryInMs };
}

/**
 * Returns abandoned jobs to the queue.
 *
 * Needed because a SIGKILL, an OOM or a lost container leaves a row `running`
 * with nobody working on it. Graceful shutdown releases its own job explicitly;
 * this covers every case where there was no chance to.
 */
export async function reclaimStale(staleMs: number = STALE_LOCK_MS): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1::float8)`,
    [staleMs / 1000],
  );
  return rowCount ?? 0;
}

/** Puts a specific job back, used by graceful shutdown. */
export async function release(jobId: number): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
}

/**
 * The pending job that caused an enqueue to coalesce.
 *
 * So a caller that lost the race can still WAIT on the sweep that is already
 * running, instead of being told `already_queued` with no handle. Without this,
 * `POST /scan?wait=` silently degraded to fire-and-forget exactly when the timer
 * had just queued a tick — which is most of the time.
 */
export async function pendingJobId(kind: JobKind, documentId: number | null = null): Promise<number | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE kind = $1 AND status IN ('queued','running')
        AND ($2::bigint IS NULL AND document_id IS NULL OR document_id = $2::bigint)
      ORDER BY id LIMIT 1`,
    [kind, documentId],
  );
  return rows[0] === undefined ? null : Number(rows[0].id);
}

export async function getJob(id: number): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    // locked_at/locked_by included on purpose: `locked_by` exists for debugging
    // a stuck job, and omitting it from the only read path made it unreachable.
    `SELECT id, kind, document_id, status, attempts, error_class, error_code, error,
            result, run_after, locked_at, locked_by, created_at, finished_at
       FROM jobs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Waits for a job to leave the queue, for `POST /scan?wait=`.
 *
 * Polled rather than LISTEN/NOTIFY: the wait is an operator and test
 * convenience, and polling one row by primary key costs nothing next to a
 * second notification channel to get wrong.
 */
export async function waitForJob(id: number, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(id);
    if (job === null) return null;
    if (job['status'] === 'done' || job['status'] === 'failed') return job;
    if (Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, 150));
  }
}
