import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { env } from '../config/env.ts';

/**
 * Where original PDFs live. Local for this assignment; S3 is the production
 * backend — implement S3Adapter against this same interface and swap it in
 * `storage`, no caller changes.
 *
 * Keys are content-addressed (`<sha256>.pdf`), which makes writes idempotent:
 * re-archiving the same bytes overwrites with identical content, so a retry
 * after a failed transaction is harmless.
 */
export interface StorageAdapter {
  /** Returns the storage key. */
  put(sha256: string, bytes: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  /** Moves a file already on disk into storage, avoiding a read+write. */
  ingest(sourcePath: string, sha256: string): Promise<string>;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class LocalFsAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    // `key` is derived from a hash we computed, never from client input, but
    // resolve-and-check costs nothing and keeps that true if callers change.
    if (!full.startsWith(resolve(this.root))) throw new Error(`key escapes storage root: ${key}`);
    return full;
  }

  async put(hash: string, bytes: Buffer): Promise<string> {
    const key = `${hash}.pdf`;
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async ingest(sourcePath: string, hash: string): Promise<string> {
    const key = `${hash}.pdf`;
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    try {
      await rename(sourcePath, full);
    } catch (err) {
      // rename fails across devices (inbox on a different mount, e.g. a cloud
      // drive). Fall back to copy-then-unlink via a plain read/write.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await writeFile(full, await readFile(sourcePath));
    }
    return key;
  }
}

export const storage: StorageAdapter = new LocalFsAdapter(env.ARCHIVE_DIR);

/**
 * Moves a file out of the inbox, keeping its ORIGINAL name.
 *
 * The archive is content-addressed (`<sha256>.pdf`), which is right for
 * retrieval and useless for a human looking at a folder — so the inbox copy is
 * relocated under its own filename rather than deleted. Deleting would also be
 * the wrong default on a drive the customer shares.
 *
 * Never fatal. By the time this runs the document row is committed and the bytes
 * are archived, so a failure here costs a re-hash on the next tick, not data.
 */
export async function moveOutOfInbox(
  sourcePath: string,
  destDir: string,
): Promise<{ moved: boolean; to?: string; error?: string }> {
  const base = basename(sourcePath);
  try {
    await mkdir(destDir, { recursive: true });
    let target = join(destDir, base);
    // A different file with the same name must not be clobbered: two customers
    // can both send `Order Form.pdf`.
    for (let n = 1; n < 100; n++) {
      try {
        await stat(target);
      } catch {
        break;   // free
      }
      const dot = base.lastIndexOf('.');
      target = join(destDir, dot === -1 ? `${base}.${n}` : `${base.slice(0, dot)}.${n}${base.slice(dot)}`);
    }
    try {
      await rename(sourcePath, target);
    } catch (err) {
      // rename fails across devices — an inbox on a different mount, which a
      // cloud drive usually is.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await writeFile(target, await readFile(sourcePath));
      await unlink(sourcePath);
    }
    return { moved: true, to: target };
  } catch (err) {
    return { moved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const failedDir = () => env.FAILED_DIR;
export const processedDir = () => env.PROCESSED_DIR;
