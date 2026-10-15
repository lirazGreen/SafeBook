import { describe, expect, it } from 'vitest';
import {
  backoffMs, classifyError, ERROR_CODES, JobError, MAX_ATTEMPTS,
} from '../../src/jobs/errors.ts';

/**
 * Retry policy, as pure functions.
 *
 * A blanket retry count is the wrong instrument: the two failure classes behave
 * differently and one of them COSTS MONEY per attempt. Retrying a corrupt PDF
 * three times produces three identical failures and, where LLM calls are
 * involved, three identical bills.
 */
describe('classifying what went wrong', () => {
  it('trusts a JobError, which already knows', () => {
    const e = new JobError('PDF_ENCRYPTED', 'PDF_ENCRYPTED: password required');
    expect(classifyError(e)).toMatchObject({ code: 'PDF_ENCRYPTED', errorClass: 'permanent' });
  });

  it('recognises the codes the pipeline throws as bare message prefixes', () => {
    // These strings ARE the contract: the pipeline throws
    // `NO_ACTIVE_PROFILE for doc_type=order_form` and `NO_TEXT_LAYER: ...`.
    expect(classifyError(new Error('NO_ACTIVE_PROFILE for doc_type=order_form')))
      .toMatchObject({ code: 'NO_ACTIVE_PROFILE', errorClass: 'permanent' });
    expect(classifyError(new Error('NO_TEXT_LAYER: document 7 has no extractable text')))
      .toMatchObject({ code: 'NO_TEXT_LAYER', errorClass: 'permanent' });
  });

  it('never retries OUR bug — a bad value or a violated constraint', () => {
    // SQLSTATE class 22 is a data exception. This is the one the end-to-end run
    // actually produced: po_amount held the raw "USD 0.00" and the insert died
    // with `invalid input syntax for type numeric`. It had been classed UNKNOWN
    // and therefore transient, so it retried three times and looked like
    // flakiness instead of a bug.
    const dataException = Object.assign(new Error('invalid input syntax for type numeric: "USD 0.00"'), { code: '22P02' });
    expect(classifyError(dataException)).toMatchObject({ code: 'DB_CONSTRAINT', errorClass: 'permanent' });

    const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(classifyError(violation)).toMatchObject({ code: 'DB_CONSTRAINT', errorClass: 'permanent' });
  });

  it('DOES retry a lost database', () => {
    for (const code of ['08006', '57P01', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(classifyError(Object.assign(new Error('gone'), { code })))
        .toMatchObject({ code: 'DB_UNAVAILABLE', errorClass: 'transient' });
    }
  });

  it('retries an LLM 429 or 5xx, but not a 400', () => {
    expect(classifyError(Object.assign(new Error('rate limited'), { status: 429 })).errorClass).toBe('transient');
    expect(classifyError(Object.assign(new Error('bad gateway'), { status: 502 })).errorClass).toBe('transient');
    // a 4xx means our request is wrong; three more identical requests will be
    // just as wrong, and each one bills
    expect(classifyError(Object.assign(new Error('bad request'), { status: 400 })).errorClass).toBe('permanent');
  });

  it('never retries a missing fixture', () => {
    // The recording is ABSENT. Three more attempts find it just as absent while
    // looking like a flake.
    const miss = Object.assign(new Error('No LLM fixture for field "payment_terms_days"'), {});
    miss.name = 'FixtureMissError';
    expect(classifyError(miss)).toMatchObject({ code: 'LLM_FIXTURE_MISSING', errorClass: 'permanent' });
  });

  it('defaults an unrecognised failure to TRANSIENT, which is the safe direction', () => {
    // A wrongly-retried transient failure costs one extra attempt; a wrongly
    // abandoned one loses a document.
    expect(classifyError(new Error('something nobody anticipated')))
      .toMatchObject({ code: 'UNKNOWN', errorClass: 'transient' });
    expect(classifyError('a bare string')).toMatchObject({ errorClass: 'transient' });
  });

  it('every declared code has a class, and the vocabulary is shared with HTTP', () => {
    for (const [code, klass] of Object.entries(ERROR_CODES)) {
      expect(['transient', 'permanent'], code).toContain(klass);
    }
  });
});

describe('backoff', () => {
  it('grows ~1s, 10s, 60s', () => {
    expect(backoffMs(0, () => 0.5)).toBe(1_000);
    expect(backoffMs(1, () => 0.5)).toBe(10_000);
    expect(backoffMs(2, () => 0.5)).toBe(60_000);
  });

  it('is jittered, so documents failing on one outage do not all return together', () => {
    expect(backoffMs(1, () => 0)).toBeLessThan(backoffMs(1, () => 1));
    expect(backoffMs(1, () => 0)).toBe(8_000);
    expect(backoffMs(1, () => 0.999)).toBeCloseTo(12_000, -2);
  });

  it('is clamped past the last step rather than growing unbounded', () => {
    expect(backoffMs(9, () => 0.5)).toBe(60_000);
  });

  it('allows 3 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
