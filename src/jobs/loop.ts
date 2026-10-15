import { extractDocument } from '../ingest/extract.ts';
import { scanInbox } from '../poller/scan.ts';
import { pool } from '../db/pool.ts';
import { enqueue, finish, fail, getJob, release, reclaimStale, claim, type Job } from './repo.ts';

/**
 * Claim one job, run it, record the outcome. The worker's whole job.
 *
 * NEVER logs document text — these are customer contracts. Every line carries
 * ids, the stage, a duration and an error code, and nothing else.
 */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

async function runJob(job: Job): Promise<void> {
  switch (job.kind) {
    case 'scan_inbox': {
      const summary = await scanInbox();
      // The summary is the job's RESULT, which is what makes `POST /scan?wait=`
      // able to answer with something useful instead of just "done".
      await finish(job.id, summary as unknown as Record<string, unknown>);
      log({ stage: 'scan_inbox', jobId: job.id, ...summary });
      return;
    }
    case 'ingest':
    case 'reextract': {
      if (job.documentId === null) throw new Error(`job ${job.id} (${job.kind}) has no document_id`);
      // `finish` happens INSIDE the extraction transaction, via jobId.
      const out = await extractDocument(job.documentId, {
        trigger: job.kind === 'ingest' ? 'ingest' : 'profile_change',
        jobId: job.id,
      });
      log({ stage: job.kind, jobId: job.id, documentId: job.documentId, ...out });
      return;
    }
    case 'reresolve_customer': {
      // Re-matches the `unmatched` backlog after a new customer is registered,
      // fanning out ONE job per document so each retries independently and
      // progress is observable.
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM documents WHERE customer_resolution = 'unmatched' AND raw_text IS NOT NULL`,
      );
      let queued = 0;
      for (const row of rows) {
        const { alreadyQueued } = await enqueue('reextract', row.id);
        if (!alreadyQueued) queued++;
      }
      await finish(job.id, { candidates: rows.length, enqueued: queued });
      log({ stage: 'reresolve_customer', jobId: job.id, candidates: rows.length, enqueued: queued });
      return;
    }
  }
}

export interface WorkerLoopOptions {
  /** How long to sleep when the queue is empty. */
  idleMs?: number;
  /** How often to return abandoned `running` jobs to the queue. */
  reclaimEveryMs?: number;
  /**
   * Overrides the job handler. A test seam, and the only one — the shutdown
   * CONTRACT (stop claiming, let the in-flight job finish, release its lock,
   * then drain) cannot be verified against the real handlers because every real
   * job settles in about 40ms, far faster than a signal can be delivered. The
   * first attempt to test it by racing a SIGTERM had all four jobs already done
   * before the signal arrived.
   */
  run?: (job: Job) => Promise<void>;
}

/**
 * The claim loop. Serial by design — one document at a time per worker.
 *
 * `pdfjs-dist` parsing is CPU-bound and single-threaded, so concurrency inside
 * one process buys nothing. Scaling out is `SKIP LOCKED` doing its job across
 * more worker replicas, which needs no code change.
 */
export function startWorkerLoop(options: WorkerLoopOptions = {}) {
  const idleMs = options.idleMs ?? 300;
  const reclaimEveryMs = options.reclaimEveryMs ?? 30_000;
  const handle = options.run ?? runJob;

  let stopping = false;
  let current: Job | null = null;
  let lastReclaim = 0;
  let settled: () => void = () => {};
  const drained = new Promise<void>((resolve) => { settled = resolve; });

  async function tick(): Promise<void> {
    if (stopping) { settled(); return; }

    if (Date.now() - lastReclaim > reclaimEveryMs) {
      lastReclaim = Date.now();
      try {
        const n = await reclaimStale();
        if (n > 0) log({ stage: 'reclaim', released: n });
      } catch (err) {
        log({ stage: 'reclaim', error: err instanceof Error ? err.message : String(err) });
      }
    }

    let job: Job | null = null;
    try {
      job = await claim();
    } catch (err) {
      // The database is unreachable. Back off rather than spinning.
      log({ stage: 'claim', error: err instanceof Error ? err.message : String(err) });
      setTimeout(() => void tick(), 2_000);
      return;
    }

    if (job === null) {
      setTimeout(() => void tick(), idleMs);
      return;
    }

    current = job;
    const started = Date.now();
    try {
      await handle(job);
      await assertSettled(job);
    } catch (err) {
      const outcome = await fail(job, err).catch(() => null);
      log({
        stage: job.kind, jobId: job.id, documentId: job.documentId,
        attempts: job.attempts, durationMs: Date.now() - started,
        // the code and class, never the document content
        errorCode: outcome?.code ?? 'UNKNOWN',
        errorClass: outcome?.errorClass ?? 'transient',
        willRetry: outcome?.willRetry ?? false,
        retryInMs: outcome?.retryInMs ?? null,
      });
      if (outcome !== null && !outcome.willRetry) await markDocumentFailed(job, outcome.code);
    } finally {
      current = null;
    }

    // Chained, never overlapping: the next claim happens only after this job is
    // settled, so a slow job delays the queue rather than racing it.
    setTimeout(() => void tick(), 0);
  }

  void tick();

  return {
    /**
     * Stops claiming and lets the in-flight job finish — but only for so long.
     *
     * The GRACE PERIOD is the point. A handler that settles normally needs no
     * release at all, so waiting indefinitely made the release unreachable;
     * meanwhile `docker compose down` sends SIGTERM and SIGKILLs after ~10s, so
     * an indefinite wait does not actually buy the job more time — it just loses
     * the chance to hand the lock back, and the job then waits out the
     * five-minute stale sweep before anyone retries it.
     *
     * So: wait up to `graceMs`, and if the job is still running, release its lock
     * and exit. The job returns to the queue immediately and another worker (or
     * this one on restart) picks it up. Its `attempts` was already spent at claim
     * time, so this cannot become an infinite retry.
     */
    async stop(graceMs = 8_000): Promise<void> {
      stopping = true;
      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), graceMs);
        // do not hold the event loop open just to wait out the grace period
        t.unref?.();
      });
      const outcome = await Promise.race([drained.then(() => 'drained' as const), timeout]);
      if (outcome === 'drained' || current === null) return;

      const stuck = current;
      try {
        await release(stuck.id);
        log({ stage: 'shutdown', jobId: stuck.id, released: true, reason: 'grace period expired' });
      } catch (err) {
        // NOT swallowed. A failure here is the symptom of a shutdown-ORDERING bug
        // — draining the pool before releasing would make this throw — and a bare
        // catch would hide the one error that reveals it. The job is still
        // recoverable either way, by the stale sweep, just five minutes later.
        log({
          stage: 'shutdown', jobId: stuck.id, released: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** For tests: the job currently in flight, if any. */
    get inFlight(): Job | null { return current; },
  };
}

/**
 * A handler MUST settle its job.
 *
 * `ingest` and `reextract` do it inside the extraction transaction (so a crash
 * cannot separate the data from the completion); `scan_inbox` and
 * `reresolve_customer` call finish() directly. A handler that returns with the
 * row still `running` has left it locked until the five-minute stale sweep — a
 * silent stall. Caught loudly here instead, and settled so the queue keeps
 * moving.
 */
async function assertSettled(job: Job): Promise<void> {
  const row = await getJob(job.id);
  if (row?.['status'] !== 'running') return;
  log({ stage: job.kind, jobId: job.id, warning: 'handler returned without settling its job' });
  await finish(job.id, { settledByLoop: true });
}

/**
 * A terminally-failed job marks its document failed too, so the queue and the
 * document agree. `jobs.error` keeps the message; the document keeps the code.
 */
async function markDocumentFailed(job: Job, code: string): Promise<void> {
  if (job.documentId === null) return;
  await pool
    .query(
      `UPDATE documents
          SET status = 'failed',
              review_reasons = array(SELECT DISTINCT unnest(review_reasons || $2::text[])),
              updated_at = now()
        WHERE id = $1`,
      [job.documentId, [code]],
    )
    .catch(() => {});
}
