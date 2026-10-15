import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.ts';
import {
  claim, enqueue, fail, finish, getJob, reclaimStale, release, STALE_LOCK_MS,
} from '../../src/jobs/repo.ts';
import { startWorkerLoop } from '../../src/jobs/loop.ts';

/**
 * The parts of the queue that only SQL can prove: the SKIP LOCKED claim, the
 * partial unique indexes that make duplicate work a no-op, stale-lock reclaim,
 * and the release on graceful shutdown.
 *
 * Needs Postgres, and SKIPS ITSELF when there is none — `npm test` must stay
 * runnable from a fresh clone with no Docker, which is the same property the
 * accuracy harness has. A skip prints a reason rather than passing silently.
 */
/**
 * Probed at MODULE scope, with top-level await, not in beforeAll.
 *
 * `it` vs `it.skip` is chosen when the describe bodies RUN, which is collection
 * time — before any beforeAll. A flag set in beforeAll is therefore still false
 * when the choice is made, and every test silently skipped even with Postgres up.
 * That is exactly what happened here, and the skip looked indistinguishable from
 * 'no database'.
 */
let available = false;
let docId: number | null = null;

try {
  await pool.query('SELECT 1 FROM jobs LIMIT 1');
  available = true;
  // A throwaway document to hang jobs off. Deleting it CASCADEs to its jobs, so
  // the suite cleans up after itself without touching anything real.
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO documents (file_sha256, original_filename, ingress)
     VALUES ($1, 'queue-test.pdf', 'upload') RETURNING id`,
    [`test-${process.pid}-${Date.now()}`],
  );
  docId = Number((rows[0] as { id: number }).id);
} catch (err) {
  // `npm test` must stay runnable from a fresh clone with no Docker — the same
  // property the accuracy harness has. The reason is printed rather than passing
  // silently.
  console.log(
    '[skip] queue integration tests need Postgres and a migrated schema: ' +
      (err instanceof Error ? err.message : String(err)),
  );
}

const maybe = available ? it : it.skip;

afterAll(async () => {
  if (docId !== null) await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
  await pool.end().catch(() => {});
});
describe('claiming work', () => {
  maybe('claims a queued job and increments attempts AT CLAIM TIME', async () => {
    const { jobId } = await enqueue('reextract', docId);
    expect(jobId).not.toBeNull();

    const job = await claim();
    expect(job).not.toBeNull();
    // Incremented on CLAIM, not on failure. That is what stops a worker
    // crash-looping on one document from retrying forever: a process killed
    // mid-job has already paid for the attempt.
    expect(job!.attempts).toBeGreaterThanOrEqual(1);
    await finish(job!.id, { ok: true });

    const settled = await getJob(job!.id);
    expect(settled!['status']).toBe('done');
  });

  maybe('returns null rather than blocking when there is nothing to do', async () => {
    // drain anything this suite queued
    for (let i = 0; i < 20; i++) {
      const j = await claim();
      if (j === null) break;
      await finish(j.id);
    }
    expect(await claim()).toBeNull();
  });
});

describe('the partial unique indexes ARE the deduplication', () => {
  maybe('the same work cannot be queued twice for one document', async () => {
    // Enforced by `(document_id, kind) WHERE status IN ('queued','running')`,
    // not by a SELECT-then-INSERT — so a poll tick and an upload racing on the
    // same bytes cannot both enqueue, with no lock involved.
    const first = await enqueue('reextract', docId);
    const second = await enqueue('reextract', docId);
    expect(first.jobId).not.toBeNull();
    expect(second).toEqual({ jobId: null, alreadyQueued: true });

    // ...and once it is settled, the same work can be queued again
    const job = await claim();
    await finish(job!.id);
    const third = await enqueue('reextract', docId);
    expect(third.jobId).not.toBeNull();
    const again = await claim();
    await finish(again!.id);
  });

  maybe('repeat POST /scan calls COALESCE instead of piling up sweeps', async () => {
    // `(kind) WHERE document_id IS NULL AND status IN ('queued','running')`
    const a = await enqueue('scan_inbox');
    const b = await enqueue('scan_inbox');
    const c = await enqueue('scan_inbox');
    expect(a.jobId).not.toBeNull();
    expect([b.alreadyQueued, c.alreadyQueued]).toEqual([true, true]);
    const job = await claim();
    await finish(job!.id);
  });
});

describe('a failure decides for itself whether it comes back', () => {
  maybe('a TRANSIENT failure returns to the queue with backoff', async () => {
    await enqueue('reextract', docId);
    const job = await claim();
    const outcome = await fail(job!, Object.assign(new Error('gone'), { code: 'ECONNREFUSED' }));

    expect(outcome).toMatchObject({ code: 'DB_UNAVAILABLE', errorClass: 'transient', willRetry: true });
    const row = await getJob(job!.id);
    expect(row!['status']).toBe('queued');
    // run_after is in the future, so the retry does not spin
    expect(new Date(row!['run_after'] as string).getTime()).toBeGreaterThan(Date.now());

    await pool.query(`UPDATE jobs SET status='done', finished_at=now() WHERE id=$1`, [job!.id]);
  });

  maybe('a PERMANENT failure is terminal immediately, not after MAX_ATTEMPTS', async () => {
    await enqueue('reextract', docId);
    const job = await claim();
    const outcome = await fail(job!, new Error('NO_TEXT_LAYER: image-only scan'));

    expect(outcome).toMatchObject({ code: 'NO_TEXT_LAYER', errorClass: 'permanent', willRetry: false });
    const row = await getJob(job!.id);
    // attempts is 1 of 3 and it is already failed: retrying a scan twice more
    // would produce the same absence of text, and bill for it if LLM calls were
    // involved.
    expect(row!['status']).toBe('failed');
    expect(Number(row!['attempts'])).toBe(1);
    expect(row!['finished_at']).not.toBeNull();
  });
});

describe('recovering a job nobody is working on', () => {
  maybe('the stale-lock sweep returns an abandoned job to the queue', async () => {
    // A SIGKILL, an OOM or a lost container leaves a row `running` with nobody
    // on it. Graceful shutdown releases its own job; this covers every case
    // where there was no chance to.
    await enqueue('reextract', docId);
    const job = await claim();
    await pool.query(
      `UPDATE jobs SET locked_at = now() - make_interval(secs => $2::float8) WHERE id = $1`,
      [job!.id, STALE_LOCK_MS / 1000 + 60],
    );

    expect(await reclaimStale()).toBeGreaterThanOrEqual(1);

    // Asserted on the ROW, not by claiming it back. `claim()` is global and
    // orders by created_at, so on a shared development database an older
    // leftover job wins the next claim — which is how this first failed, against
    // a `running` row stranded by an earlier aborted run. That `claim()` returns
    // a queued job at all is already covered by the first test in this file.
    const row = await getJob(job!.id);
    expect(row!['status']).toBe('queued');
    expect(row!['locked_by']).toBeNull();
    expect(row!['locked_at']).toBeNull();
    // attempts was already spent AT CLAIM TIME, so a worker crash-looping on one
    // document cannot retry forever
    expect(Number(row!['attempts'])).toBe(1);

    await pool.query(`UPDATE jobs SET status='done', finished_at=now() WHERE id=$1`, [job!.id]);
  });

  maybe('a FRESH lock is left alone', async () => {
    // Reclaiming eagerly would hand a document to a second worker while the
    // first is still working on it.
    await enqueue('reextract', docId);
    const job = await claim();
    await reclaimStale();
    expect((await getJob(job!.id))!['status']).toBe('running');
    await finish(job!.id);
  });

  maybe('graceful shutdown RELEASES the in-flight job immediately', async () => {
    // Without this, `docker compose down` mid-extraction leaves a running row
    // that nothing touches until the five-minute stale-lock timeout.
    await enqueue('reextract', docId);
    const job = await claim();
    await release(job!.id);

    const row = await getJob(job!.id);
    expect(row!['status']).toBe('queued');
    expect(row!['locked_by']).toBeNull();
    // and it is claimable right now, not in five minutes
    const next = await claim();
    expect(next!.id).toBe(job!.id);
    await finish(next!.id);
  });
});

describe('the worker loop under shutdown', () => {
  maybe('waits for a job that settles in time, and needs no release', async () => {
    // Driven with a deliberately slow handler. The real ones settle in ~40ms, so
    // racing a SIGTERM against them had all four jobs already done before the
    // signal arrived — the contract looked verified and nothing was exercised.
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let completed = false;

    await enqueue('reextract', docId);
    const loop = startWorkerLoop({
      idleMs: 10,
      run: async (job) => {
        entered();
        await new Promise((r) => setTimeout(r, 200));
        completed = true;
        await finish(job.id, { ok: true });
      },
    });

    await started;
    const inFlight = loop.inFlight;
    expect(inFlight).not.toBeNull();

    const stopping = loop.stop(5_000);
    // it must WAIT rather than abandoning a job mid-write
    expect(completed).toBe(false);
    await stopping;
    expect(completed).toBe(true);

    expect((await getJob(inFlight!.id))!['status']).toBe('done');
  });

  maybe('RELEASES the lock when the grace period expires, instead of leaving it stale', async () => {
    // The case that actually matters: `docker compose down` SIGKILLs after ~10s,
    // so waiting indefinitely does not buy the job more time — it just loses the
    // chance to hand the lock back, and the job then waits out the five-minute
    // stale sweep before anyone retries it.
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });

    await enqueue('reextract', docId);
    const loop = startWorkerLoop({
      idleMs: 10,
      run: async () => { entered(); await new Promise((r) => setTimeout(r, 3_000)); },
    });

    await started;
    const inFlight = loop.inFlight!;
    await loop.stop(50);                 // grace period far shorter than the job

    const row = await getJob(inFlight.id);
    expect(row!['status']).toBe('queued');
    expect(row!['locked_by']).toBeNull();

    // ...and claimable right now, not in five minutes. attempts was already
    // spent at claim time, so this cannot become an infinite retry.
    const again = await claim();
    expect(again!.id).toBe(inFlight.id);
    expect(again!.attempts).toBe(2);
    await finish(again!.id);
  });

  maybe('a handler that returns WITHOUT settling its job is caught, not left stalled', async () => {
    // Otherwise the row sits `running` until the five-minute sweep — a silent
    // stall. ingest/reextract settle inside the extraction transaction and the
    // other two call finish(); this is the guard for a future handler that
    // forgets.
    await enqueue('reextract', docId);
    const loop = startWorkerLoop({ idleMs: 10, run: async () => {} });
    await new Promise((r) => setTimeout(r, 250));
    await loop.stop(500);

    const { rows } = await pool.query(
      `SELECT status, result FROM jobs WHERE document_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    expect(rows[0]!['status']).toBe('done');
    expect(rows[0]!['result']).toEqual({ settledByLoop: true });
  });

  maybe('stops claiming new work once shutdown begins', async () => {
    const loop = startWorkerLoop({ idleMs: 10, run: async (job) => finish(job.id) });
    await loop.stop(500);

    const { jobId } = await enqueue('reextract', docId);
    await new Promise((r) => setTimeout(r, 150));
    expect((await getJob(jobId!))!['status']).toBe('queued');

    const drain = await claim();
    await finish(drain!.id);
  });
});
