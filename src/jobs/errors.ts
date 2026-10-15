/**
 * Why a job failed, and whether retrying could possibly help.
 *
 * A blanket retry count is the wrong instrument here, because the two classes
 * behave differently and one of them COSTS MONEY per attempt. Re-running a
 * password-protected PDF three times re-bills the same LLM calls for an
 * identical failure; re-running a dropped database connection is exactly right.
 *
 * So classification is explicit and the default is `transient` — the safe
 * direction, since a wrongly-retried transient failure costs one extra attempt
 * while a wrongly-abandoned one loses a document.
 */
export type ErrorClass = 'transient' | 'permanent';

/**
 * Shared with the HTTP layer: an API failure and a job failure speak ONE
 * vocabulary, so `GET /documents?reason=…` and `jobs.error_code` line up.
 */
export const ERROR_CODES = {
  // ingress
  NOT_A_PDF: 'permanent',
  FILE_TOO_LARGE: 'permanent',
  FILE_UNREADABLE: 'transient',
  // parse
  PDF_CORRUPT: 'permanent',
  PDF_ENCRYPTED: 'permanent',
  /** The image-only scan case (assumption A4). Its own code so it is countable. */
  NO_TEXT_LAYER: 'permanent',
  // profile
  NO_ACTIVE_PROFILE: 'permanent',
  // extract
  LLM_UNAVAILABLE: 'transient',
  LLM_INVALID_JSON: 'transient',
  LLM_FIXTURE_MISSING: 'permanent',
  // persist
  DB_CONSTRAINT: 'permanent',
  DB_UNAVAILABLE: 'transient',
  STORAGE_UNAVAILABLE: 'transient',
  UNKNOWN: 'transient',
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Thrown where the cause is already known, so classification needs no guessing. */
export class JobError extends Error {
  readonly code: ErrorCode;
  readonly errorClass: ErrorClass;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobError';
    this.code = code;
    this.errorClass = ERROR_CODES[code];
  }
}

/**
 * Recognises the codes the pipeline raises as bare messages, plus the driver and
 * SDK errors that arrive as somebody else's exception type.
 *
 * Matching on a message prefix is deliberate rather than lazy: the pipeline
 * throws `NO_ACTIVE_PROFILE for doc_type=order_form` and `NO_TEXT_LAYER: …`, and
 * those strings are the contract. A JobError skips this entirely.
 */
export function classifyError(err: unknown): { code: ErrorCode; errorClass: ErrorClass; message: string } {
  if (err instanceof JobError) {
    return { code: err.code, errorClass: err.errorClass, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);

  for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
    if (code !== 'UNKNOWN' && message.startsWith(code)) {
      return { code, errorClass: ERROR_CODES[code], message };
    }
  }

  // A fixture miss must NOT retry: the recording is absent, and three more
  // attempts will find it just as absent while looking like flakiness.
  if (err instanceof Error && err.name === 'FixtureMissError') {
    return { code: 'LLM_FIXTURE_MISSING', errorClass: 'permanent', message };
  }

  // node-postgres puts the SQLSTATE on `code`. Class 23 is integrity
  // constraint violation — our bug, never retry. Class 08 is connection
  // failure, and 57P01 is the server shutting down under us.
  const sqlState = (err as { code?: unknown }).code;
  if (typeof sqlState === 'string') {
    // Class 23 is an integrity constraint violation and class 22 a data
    // exception (`invalid input syntax for type numeric: "USD 0.00"`). BOTH are
    // our bug, so neither may retry — three identical attempts at a value that
    // will never cast just read as flakiness. Class 22 was missing until a real
    // insert produced one.
    if (sqlState.startsWith('23') || sqlState.startsWith('22')) {
      return { code: 'DB_CONSTRAINT', errorClass: 'permanent', message };
    }
    if (sqlState.startsWith('08') || sqlState === '57P01' || sqlState === '57P03') {
      return { code: 'DB_UNAVAILABLE', errorClass: 'transient', message };
    }
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(sqlState)) {
      return { code: 'DB_UNAVAILABLE', errorClass: 'transient', message };
    }
    if (sqlState === 'ENOENT') return { code: 'FILE_UNREADABLE', errorClass: 'transient', message };
    if (sqlState === 'ENOSPC') return { code: 'STORAGE_UNAVAILABLE', errorClass: 'transient', message };
  }

  // Anthropic SDK: 429 and 5xx are worth retrying, 4xx is a bug in our request.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429 || status >= 500) return { code: 'LLM_UNAVAILABLE', errorClass: 'transient', message };
    if (status >= 400) return { code: 'LLM_INVALID_JSON', errorClass: 'permanent', message };
  }

  return { code: 'UNKNOWN', errorClass: 'transient', message };
}

/**
 * Attempts allowed for a TRANSIENT failure. A permanent one sets
 * status='failed' directly rather than burning through this.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Delay before the next attempt: ~1s, 10s, 60s, with jitter.
 *
 * Jitter matters even with one worker: several documents failing on the same
 * database outage would otherwise all come back at the same instant and fail
 * together again.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = [1_000, 10_000, 60_000][Math.min(attempts, 2)] as number;
  return Math.round(base * (0.8 + random() * 0.4));
}
