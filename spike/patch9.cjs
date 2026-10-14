const fs = require('fs');
const p = 'src/db/pool.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`import pg from 'pg';
import { env } from '../config/env.ts';`,
`import pg from 'pg';
import { env } from '../config/env.ts';

// ---------------------------------------------------------------------------
// Type parsers. Both of these exist to stop the driver "helpfully" converting a
// value into a JS type that loses information.
// ---------------------------------------------------------------------------

/**
 * DATE (OID 1082) -> keep the 'yyyy-mm-dd' STRING.
 *
 * By default node-postgres builds a JS Date at LOCAL midnight, so in any
 * timezone east of UTC the day shifts backwards on the way out: 2025-03-01
 * became 2025-02-28T22:00Z here, and every date in the API was a day early.
 *
 * The schema deliberately uses DATE rather than TIMESTAMPTZ because these are
 * calendar dates with no time or zone. Parsing them into an instant reintroduces
 * exactly the timezone problem that choice avoided.
 */
pg.types.setTypeParser(1082, (value: string) => value);

/**
 * NUMERIC (OID 1700) -> keep the decimal STRING.
 *
 * This is already the driver default, set explicitly so it cannot be changed by
 * accident: as a float, 22916.67 becomes 22916.669999999998 and CloudShield's
 * reconciliation stops being exact.
 */
pg.types.setTypeParser(1700, (value: string) => value);`);
t = t.replace(
`// Money arrives as NUMERIC. node-postgres hands NUMERIC back as a string by
// default, which is correct — parsing it into a JS float would reintroduce the
// rounding error NUMERIC exists to avoid. CloudShield's 22916.67 x 12 must stay
// exact. Callers convert deliberately, never implicitly.
export const pool`, `export const pool`);
fs.writeFileSync(p, t);

// the serialiser no longer needs to handle Date objects
const a = 'src/api/server.ts';
let s = fs.readFileSync(a, 'utf8');
s = s.replace(
`const outDate = (d: string | Date | null) =>
  d === null ? null : formatMmDdYyyy(typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));`,
`// DATE columns arrive as 'yyyy-mm-dd' strings (see the type parser in db/pool.ts),
// so there is no Date object to mishandle here.
const outDate = (d: string | null) => (d === null ? null : formatMmDdYyyy(d.slice(0, 10)));`);
s = s.replace(/outDate\(([a-z]+)\[('[a-z_]+')\]\)/g, "outDate($1[$2] as string | null)");
s = s.replace("outDate(doc['start_date'])", "outDate(doc['start_date'] as string | null)");
s = s.replace("outDate(doc['end_date'])", "outDate(doc['end_date'] as string | null)");
fs.writeFileSync(a, s);
console.log('patched');
