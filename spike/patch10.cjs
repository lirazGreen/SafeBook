const fs = require('fs');
const p = 'src/db/pool.ts';
let t = fs.readFileSync(p, 'utf8');
const start = t.indexOf('// ---------------------------------------------------------------------------');
const end = t.indexOf('export const pool');
if (start === -1 || end === -1) { console.error('anchors missing'); process.exit(1); }
t = t.slice(0, start) + t.slice(end);
t = t.replace(
  "import pg from 'pg';\nimport { env } from '../config/env.ts';",
  "import pg from 'pg';\nimport { env } from '../config/env.ts';\n// Registers the DATE and NUMERIC parsers. Must be imported before any query:\n// see db/types.ts for why the driver's defaults lose information.\nimport './types.ts';");
fs.writeFileSync(p, t);
console.log('pool.ts slimmed');
