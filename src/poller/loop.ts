import { env } from '../config/env.ts';
import { enqueue } from '../jobs/repo.ts';

/**
 * The polling timer: enqueues a `scan_inbox` job on an interval.
 *
 * It ENQUEUES rather than scanning inline, so there is exactly one place the
 * inbox is swept — the worker's job handler — reached identically by the timer
 * and by `POST /scan`. The stability-gate cache then lives in one process, which
 * it has to: two scanners would each see a half-written file for the first time
 * and neither would have a previous tick to compare against.
 *
 * CHAINED setTimeout, not setInterval: a slow enqueue delays the next tick
 * instead of racing it. (The sweep itself cannot overlap anyway — the partial
 * unique index caps pending `scan_inbox` jobs at one.)
 *
 * An in-process timer rather than cron, deliberately. The worker is already
 * long-lived because it holds the claim loop; cron would pay Node startup and a
 * fresh connection pool every tick, floor the interval at one minute, need a
 * lockfile to avoid overlap, and buy no resilience — if the worker is down,
 * cron-enqueued jobs go unprocessed anyway.
 */
export function startPollingTimer(intervalMs: number = env.POLL_INTERVAL_MS) {
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopping) return;
    try {
      const { jobId, alreadyQueued } = await enqueue('scan_inbox');
      if (!alreadyQueued) {
        console.log(JSON.stringify({ at: new Date().toISOString(), stage: 'poll', jobId }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        at: new Date().toISOString(), stage: 'poll',
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (!stopping) timer = setTimeout(() => void tick(), intervalMs);
    }
  }

  void tick();

  return {
    stop(): void {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
