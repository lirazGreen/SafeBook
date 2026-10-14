import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),

  INBOX_DIR: z.string().default('./inbox'),
  ARCHIVE_DIR: z.string().default('./archive'),
  FAILED_DIR: z.string().default('./failed'),

  // The assigner confirmed there are no file-arrival alerts, so the worker polls.
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  // A file is only eligible once size+mtime have held steady this long, so a
  // half-copied (or half-synced) PDF is never parsed.
  STABLE_AFTER_MS: z.coerce.number().int().min(0).default(2000),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  ANTHROPIC_API_KEY: z.string().optional(),
  // fixture: replay committed responses (tests run offline and deterministically)
  // record:  call the API and write fixtures
  // live:    call the API, write nothing
  LLM_MODE: z.enum(['fixture', 'record', 'live']).default('fixture'),
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
  if (env.LLM_MODE !== 'fixture' && !env.ANTHROPIC_API_KEY) {
    throw new Error(`LLM_MODE="${env.LLM_MODE}" requires ANTHROPIC_API_KEY.`);
  }
  return env;
}

export const env = load();
export type Env = z.infer<typeof Env>;
