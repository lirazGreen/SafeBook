import { z } from 'zod';
import { loadDotEnv } from './dotenv.ts';

// Before the schema reads process.env. A variable already in the environment
// wins, so an explicit `LLM_MODE=record npm run accuracy` and docker-compose's
// own `environment:` block both still take precedence over the file.
loadDotEnv();

const Env = z.object({
  /**
   * OPTIONAL here, required by whoever opens a pool.
   *
   * The accuracy harness and the test suite are deliberately runnable with no
   * database — profiles and customers come from YAML — but they DO need the LLM
   * settings below, and those live in the same env object. Demanding a
   * DATABASE_URL just to read LLM_MODE would have made `npm run accuracy`
   * require Docker, which is the one property that makes its printed number
   * reproducible from a fresh clone.
   *
   * It still fails at BOOT for the api and worker, because both open the pool
   * at startup — see db/pool.ts, which names the fix.
   */
  DATABASE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000),

  INBOX_DIR: z.string().default('./inbox'),
  ARCHIVE_DIR: z.string().default('./archive'),
  FAILED_DIR: z.string().default('./failed'),
  PROCESSED_DIR: z.string().default('./processed'),
  /**
   * Move a file out of the inbox once it has been registered.
   *
   * ON by default, and not merely tidiness: without it the inbox grows without
   * bound and every poll tick re-reads and re-hashes every file in it. The
   * assigner explicitly allowed moving completed files to an archive folder.
   *
   * Worth being able to turn OFF, because the inbox may be a shared cloud drive
   * the customer also uses, where silently relocating their files is unwelcome.
   * With it off, the stat cache is what stops the re-hashing instead.
   */
  MOVE_PROCESSED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // The assigner confirmed there are no file-arrival alerts, so the worker polls.
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  // A file is only eligible once size+mtime have held steady this long, so a
  // half-copied (or half-synced) PDF is never parsed.
  STABLE_AFTER_MS: z.coerce.number().int().min(0).default(2000),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * off      no escalator is wired. A field whose deterministic rule fails is
   *          flagged FIELD_NOT_FOUND and the document still persists. This is
   *          how the SERVICE behaves with no API key: lower recall on prose
   *          fields, no failures.
   * fixture  replay committed responses; a MISS IS AN ERROR. For tests and the
   *          accuracy harness, where a silent fallthrough would either turn an
   *          offline run into a billed one or hide prompt drift.
   * record   call the API and write each exchange to tests/fixtures/llm/.
   * live     call the API, write nothing. The real service path.
   *
   * 'fixture' and 'off' were briefly the same mode, which was wrong: a reviewer
   * dropping a PDF into inbox/ would have hit a hard fixture miss instead of the
   * documented graceful degradation.
   */
  LLM_MODE: z.enum(['off', 'fixture', 'record', 'live']).default('off'),
  LLM_MODEL: z.string().default('claude-opus-5'),
});

function load() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env.`);
  }
  const env = parsed.data;
  if ((env.LLM_MODE === 'record' || env.LLM_MODE === 'live') && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      `LLM_MODE="${env.LLM_MODE}" requires ANTHROPIC_API_KEY. ` +
        `Use LLM_MODE=off to run deterministic-only with no key.`,
    );
  }
  return env;
}

export const env = load();
export type Env = z.infer<typeof Env>;
