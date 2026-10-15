import { readdir, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { env } from '../config/env.ts';
import { isKnown, registerBytes } from '../ingest/register.ts';
import { failedDir, moveOutOfInbox, processedDir, sha256 } from '../storage/index.ts';

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
  /** Relocated out of the inbox, so a later tick does not re-read them. */
  moved: number;
  /** Settled on an earlier tick and not re-read. See the `done` flag below. */
  skipped: number;
}

interface Seen {
  size: number;
  mtimeMs: number;
  /**
   * Already registered (or rejected) on an earlier tick.
   *
   * This is what makes the stat cache do what it was always documented to do.
   * Before it, every tick re-READ and re-HASHED every file still in the inbox
   * just to discover it was a duplicate — the cache only gated *stability*. With
   * MOVE_PROCESSED on, files leave the inbox and the question rarely arises; with
   * it off, or when a move fails, this is the only thing preventing the inbox
   * being re-hashed every couple of seconds forever.
   */
  done?: boolean;
}

/**
 * `path -> (size, mtime)` from the previous tick.
 *
 * Also what keeps steady state cheap — though only since the `done` flag: before
 * it, this cache gated STABILITY only, and a file still sitting in the inbox was
 * re-read and re-hashed on every single tick just to rediscover it was a
 * duplicate. The comment claimed otherwise for three phases.
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
 * Overrides for the configured directories and the move behaviour.
 *
 * A test seam, for the same reason `dir` is one: `env` is read at import time,
 * so a test cannot point these somewhere else after the fact — and a test must
 * not sweep, or relocate files in, the real folders it shares with a worker.
 */
export interface ScanOptions {
  processedDir?: string;
  failedDir?: string;
  move?: boolean;
}

export async function scanInbox(
  dir: string = env.INBOX_DIR,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const shouldMove = options.move ?? env.MOVE_PROCESSED;
  const summary: ScanSummary = {
    found: 0, enqueued: 0, duplicate: 0, unstable: 0, rejected: 0, moved: 0, skipped: 0,
  };
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

    const previous = seen.get(path);
    if (previous?.done === true && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      // Settled on an earlier tick and untouched since: no read, no hash, no
      // query. See Seen.done for why this had to exist.
      summary.skipped++;
      continue;
    }

    if (!isStable(path, current, now)) {
      seen.set(path, current);
      summary.unstable++;
      continue;
    }
    seen.set(path, current);

    let destination: string | null = null;
    try {
      const bytes = await readFile(path);
      // Hash first and skip early: a re-dropped file costs one read, no
      // transaction and no second extraction.
      if (await isKnown(sha256(bytes))) {
        summary.duplicate++;
      } else {
        const result = await registerBytes(bytes, relative(dir, path), 'poll');
        if (result.duplicate) summary.duplicate++;
        else summary.enqueued++;
      }
      destination = options.processedDir ?? processedDir();
    } catch (err) {
      // One bad file must not abort the sweep. A rejection is counted and
      // reported; the job queue is where retryable failures live, and a file
      // rejected HERE never got a job because it never became a document.
      summary.rejected++;
      console.error(JSON.stringify({
        stage: 'scan', file: relative(dir, path),
        error: err instanceof Error ? err.message : String(err),
      }));
      // A scan-stage rejection is PERMANENT — not a PDF, or over the size cap.
      // Leaving it in place would re-read and re-reject it on every tick
      // forever, so it goes to failed/ where a human can find it.
      destination = options.failedDir ?? failedDir();
    }

    // Settled either way. Remember that, so the branch at the top of the loop
    // can skip it even if the move below cannot happen.
    seen.set(path, { ...current, done: true });

    if (shouldMove) {
      const outcome = await moveOutOfInbox(path, destination);
      if (outcome.moved) {
        summary.moved++;
        seen.delete(path);          // it is gone from the inbox; stop tracking it
      } else {
        // Not fatal. The document row is committed and the bytes are archived,
        // so a failed move costs one cache entry, not data.
        console.error(JSON.stringify({
          stage: 'scan', file: relative(dir, path), moved: false, error: outcome.error,
        }));
      }
    }
  }

  // Forget files that are gone, so the cache cannot grow without bound in a
  // long-running worker.
  for (const path of [...seen.keys()]) if (!alive.has(path)) seen.delete(path);

  return summary;
}
