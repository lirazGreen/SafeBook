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
/**
 * `fixture` is a TESTING mode and must never run the service.
 *
 * A fixture key hashes the input text, so a genuinely new document can only ever
 * MISS — and a miss is classed permanent, which fails the WHOLE document rather
 * than just its prose field. `off` degrades gracefully; `fixture` destroys.
 *
 * Refused at boot rather than left to surface one document at a time, because the
 * failure mode is both total and silent-looking: every PDF simply goes to
 * `failed`.
 */
if (env.LLM_MODE === 'fixture') {
  throw new Error(
    'LLM_MODE="fixture" cannot run the worker: a fixture key hashes the input text, ' +
      'so every new document misses and FAILS ENTIRELY. ' +
      'Use LLM_MODE=live (with ANTHROPIC_API_KEY) to extract prose fields, ' +
      'or LLM_MODE=off to flag them for review instead.',
  );
}

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
