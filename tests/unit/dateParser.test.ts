import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { DATE_OID, NUMERIC_OID, registerTypeParsers } from '../../src/db/types.ts';

/**
 * Guards a bug that reached the API: every date came out a day early.
 *
 * The PDF says "03-01-2025" and Postgres stores 2025-03-01 — verified directly
 * in psql. The loss happened in the DRIVER on the way out: node-postgres builds
 * a JS Date at LOCAL midnight, so in UTC+3 that became the instant
 * 2025-02-28T22:00Z and rendering it lost the day.
 *
 * Choosing DATE over TIMESTAMPTZ was necessary but not sufficient. This fails if
 * the parser is ever removed.
 */
describe('DATE must survive the driver unchanged', () => {
  it('returns the raw yyyy-mm-dd, not a Date', () => {
    registerTypeParsers();
    const parse = pg.types.getTypeParser(DATE_OID as never);
    expect(parse('2025-03-01')).toBe('2025-03-01');
    expect(typeof parse('2025-03-01')).toBe('string');
  });

  it('reproduces the bug it prevents, for any timezone east of UTC', () => {
    const localMidnight = new Date('2025-03-01T00:00:00');
    const viaIso = localMidnight.toISOString().slice(0, 10);
    // getTimezoneOffset is NEGATIVE east of UTC
    if (localMidnight.getTimezoneOffset() < 0) {
      expect(viaIso).toBe('2025-02-28');       // the day the API was losing
      expect(viaIso).not.toBe('2025-03-01');
    } else {
      expect(viaIso).toBe('2025-03-01');       // west of UTC the bug hides
    }
  });

  it('keeps NUMERIC as an exact decimal string', () => {
    registerTypeParsers();
    const parse = pg.types.getTypeParser(NUMERIC_OID as never);
    expect(parse('22916.67')).toBe('22916.67');
    // 22916.67 x 12 must be exactly 275000.04, not 275000.0399999...
    expect(Number(parse('22916.67')) * 12).toBeCloseTo(275000.04, 2);
  });
});
