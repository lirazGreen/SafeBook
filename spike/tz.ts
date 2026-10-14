import pg from 'pg';
console.log('TZ =', process.env['TZ'] ?? '(unset)', '| offset =', new Date().getTimezoneOffset());
pg.types.setTypeParser(1082, (v: string) => v);
const p = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const { rows } = await p.query("SELECT start_date, '2025-03-01'::date AS lit FROM documents LIMIT 1");
console.log('typeof start_date =', typeof rows[0].start_date, '|', JSON.stringify(rows[0].start_date));
console.log('typeof literal    =', typeof rows[0].lit, '|', JSON.stringify(rows[0].lit));
await p.end();
