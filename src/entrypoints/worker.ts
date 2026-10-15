import { env } from '../config/env.ts';
import { pool } from '../db/pool.ts';
import { startWorkerLoop } from '../jobs/loop.ts';
import { WORKER_ID } from '../jobs/repo.ts';
import { startPollingTimer } from '../poller/loop.ts';

/**
 * The worker: the polling timer plus the job loop. All parsing, all LLM calls,
 * all extraction writes.
 *
 * Split from the api NOT to avoid database locks — Postgres MVCC means readers
 * never block writers and both processes hit the same instance anyway. The real
 * reasons: `pdfjs-dist` parsing is CPU-bound and single-threaded, so a large PDF
 * blocks Node's event loop; and a bulk reprocess can touch dozens of documents
 * with LLM calls, which cannot run inside an HTTP handler. A queue is required
 * either way, and given one, a separate worker is nearly free.
 */
console.log(JSON.stringify({
  at: new Date().toISOString(), stage: 'boot', worker: WORKER_ID,
  inbox: env.INBOX_DIR, pollIntervalMs: env.POLL_INTERVAL_MS, llmMode: env.LLM_MODE,
}));

const jobs = startWorkerLoop();
const poller = startPollingTimer();

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;      // a second Ctrl-C must not re-enter the drain
    shuttingDown = true;
    console.log(JSON.stringify({ at: new Date().toISOString(), stage: 'shutdown', signal }));
    poller.stop();
    // Order matters: stop claiming, let the in-flight job finish, release its
    // lock back to `queued`, THEN drain the pool. Draining first would make the
    // release fail and leave the row locked until the stale-lock sweep.
    // 8s grace: under Docker Compose's ~10s SIGTERM window, so the in-flight
    // job either finishes or has its lock handed back before we are SIGKILLed.
    void jobs
      .stop(8_000)
      .catch(() => {})
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
