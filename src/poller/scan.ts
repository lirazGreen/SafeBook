import { readdir, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { env } from '../config/env.ts';
import { isKnown, registerBytes } from '../ingest/register.ts';
import { sha256 } from '../storage/index.ts';

/**
 * One sweep of the inbox.
 *
 * POLLING, not a filesystem watcher. The assigner confirmed there are no
 * file-arrival alerts, which a watcher would also have satisfied — but the folder
 * was explicitly allowed to be a SHARED CLOUD DRIVE, and filesystem events are
 * unreliable on sync-backed and network mounts (often absent entirely on
 * SMB/NFS). Polling behaves identically on both, so it is the choice no answer
 * can invalidate.
 *
 * The sweep is idempotent because the sha256 check is the authority, not an
 * emptied directory. So running it on a timer rather than once at boot is the
 * whole difference, and a file that arrived while the worker was down is picked
 * up on the next tick rather than lost.
 */
export interface ScanSummary {
  found: number;
  enqueued: number;
  duplicate: number;
  /** Still being written or synced — skipped, and retried next tick. */
  unstable: number;
  rejected: number;
}

interface Seen {
  size: number;
  mtimeMs: number;
}

/**
 * `path -> (size, mtime)` from the previous tick.
 *
 * Also what keeps steady state cheap: a file whose size and mtime are unchanged
 * needs only a `stat()`, so the archive is not re-hashed every interval.
 */
const seen = new Map<string, Seen>();

/** Test seam. The cache is per-process state, so a test must be able to clear it. */
export function resetStabilityCache(): void {
  seen.clear();
}

/** Recursive on purpose: nesting in the inbox must never break ingestion. */
async function pdfsUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await pdfsUnder(path)));
    else if (entry.name.toLowerCase().endsWith('.pdf')) out.push(path);
  }
  return out;
}

/**
 * Whether a file has finished being written.
 *
 * This replaces what a watcher's `awaitWriteFinish` would have given us, and it
 * is not optional: a tick can otherwise catch a half-copied file — copying Acme's
 * 191 KB PDF is not instantaneous — or, on a cloud drive, one that has APPEARED
 * but not finished syncing. Parsing a truncated PDF would either throw or, worse,
 * succeed on a prefix.
 *
 * Eligible when size and mtime are unchanged since the previous tick, OR when
 * mtime is already older than STABLE_AFTER_MS (so a file sitting in the inbox
 * from before the worker started does not wait a whole extra tick).
 */
function isStable(path: string, s: Seen, now: number): boolean {
  if (now - s.mtimeMs >= env.STABLE_AFTER_MS) return true;
  const previous = seen.get(path);
  return previous !== undefined && previous.size === s.size && previous.mtimeMs === s.mtimeMs;
}

/**
 * @param dir overrides the configured inbox. A test seam: `env` is read at import
 *   time, so a test cannot point INBOX_DIR somewhere else after the fact, and an
 *   end-to-end test must not sweep the real folder it shares with the worker.
 */
export async function scanInbox(dir: string = env.INBOX_DIR): Promise<ScanSummary> {
  const summary: ScanSummary = { found: 0, enqueued: 0, duplicate: 0, unstable: 0, rejected: 0 };
  const files = await pdfsUnder(dir);
  const now = Date.now();
  const alive = new Set<string>();

  for (const path of files) {
    summary.found++;
    let info;
    try {
      info = await stat(path);
    } catch {
      // Vanished between readdir and stat — a move or a delete. Not an error.
      continue;
    }
    const current: Seen = { size: info.size, mtimeMs: info.mtimeMs };
    alive.add(path);

    if (!isStable(path, current, now)) {
      seen.set(path, current);
      summary.unstable++;
      continue;
    }
    seen.set(path, current);

    try {
      const bytes = await readFile(path);
      // Hash first and skip early: a re-dropped file costs one read, no
      // transaction and no second extraction.
      if (await isKnown(sha256(bytes))) {
        summary.duplicate++;
        continue;
      }
      const result = await registerBytes(bytes, relative(dir, path), 'poll');
      if (result.duplicate) summary.duplicate++;
      else summary.enqueued++;
    } catch (err) {
      // One bad file must not abort the sweep. A rejection is counted and
      // reported; the job queue is where retryable failures live, and a file
      // rejected HERE never got a job because it never became a document.
      summary.rejected++;
      console.error(JSON.stringify({
        stage: 'scan', file: relative(dir, path),
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Forget files that are gone, so the cache cannot grow without bound in a
  // long-running worker.
  for (const path of [...seen.keys()]) if (!alive.has(path)) seen.delete(path);

  return summary;
}
