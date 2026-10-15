import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FIXTURE_DIR = 'tests/fixtures/llm';

/**
 * A recorded Claude exchange, replayed so tests and the accuracy harness run
 * offline and deterministically.
 *
 * The KEY is a hash of (field, model, instruction, input) — deliberately NOT just
 * the field name. Keying on the field alone would replay an OLD response against
 * a CHANGED prompt: tests would pass while live behaviour differed, and the
 * accuracy number would describe a prompt that no longer exists. Hashing the
 * instruction means a prompt edit misses the cache and must be re-recorded.
 */
export interface Fixture {
  request: { field: string; model: string; instruction_sha: string; input: string };
  response: unknown;
  /** Set on hand-written fixtures not yet replaced by a real recorded call. */
  provisional?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function fixtureKey(field: string, model: string, instruction: string, input: string): string {
  return sha([field, model, sha(instruction), input].join('\u0000')).slice(0, 24);
}

export async function readFixture(key: string): Promise<Fixture | null> {
  try {
    return JSON.parse(await readFile(join(FIXTURE_DIR, `${key}.json`), 'utf8')) as Fixture;
  } catch {
    return null;
  }
}

export async function writeFixture(key: string, fixture: Fixture): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, `${key}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

export async function listFixtures(): Promise<(Fixture & { key: string })[]> {
  try {
    const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.json'));
    return Promise.all(
      files.map(async (f) => ({
        ...(JSON.parse(await readFile(join(FIXTURE_DIR, f), 'utf8')) as Fixture),
        key: f.replace(/\.json$/, ''),
      })),
    );
  } catch {
    return [];
  }
}

/**
 * A miss in fixture mode must be LOUD. A silent fallthrough to a live call would
 * turn an offline run into a billed one; a silent fallthrough to a stale response
 * would hide prompt drift behind passing tests.
 */
export class FixtureMissError extends Error {
  /** Exposed so the accuracy harness can REPORT the gap, not just print it. */
  readonly field: string;
  readonly key: string;

  constructor(key: string, field: string, input: string) {
    super(
      `No LLM fixture for field "${field}" (key ${key}).\n` +
        `  Input begins: ${JSON.stringify(input.slice(0, 80))}\n` +
        `  Re-record with: LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy`,
    );
    this.name = 'FixtureMissError';
    this.field = field;
    this.key = key;
  }
}
