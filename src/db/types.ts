import pg from 'pg';

/**
 * Driver type parsers. Both stop node-postgres converting a value into a JS type
 * that loses information. Deliberately in their own module with no env
 * dependency, so they can be registered and asserted without a live DB.
 */

/**
 * DATE (OID 1082) -> keep the 'yyyy-mm-dd' STRING.
 *
 * This fixed a bug that reached the API: every date came out a day early.
 * The schema stores DATE rather than TIMESTAMPTZ precisely because these are
 * calendar dates with no time or zone — a contract starting "03-01-2025" starts
 * on that date everywhere. But the driver builds a JS Date at LOCAL midnight, so
 * in UTC+3 `2025-03-01` became the instant `2025-02-28T22:00Z`, and rendering it
 * through toISOString() lost the day.
 *
 * Choosing the right column type was not enough; the driver had to be stopped
 * from re-introducing the problem on the way out.
 */
export const DATE_OID = 1082;

/**
 * NUMERIC (OID 1700) -> keep the decimal STRING.
 *
 * Already the driver default, pinned explicitly so it cannot change by accident:
 * as a float, 22916.67 becomes 22916.669999999998 and CloudShield's
 * reconciliation stops being exact.
 */
export const NUMERIC_OID = 1700;

let registered = false;

export function registerTypeParsers(): void {
  if (registered) return;
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  pg.types.setTypeParser(NUMERIC_OID, (value: string) => value);
  registered = true;
}

registerTypeParsers();
