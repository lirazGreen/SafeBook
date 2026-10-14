const fs = require('fs');
const p = 'docs/DESIGN.md';
let t = fs.readFileSync(p, 'utf8');
const anchor = '- **Never `new Date(string)`** — its parsing is timezone-dependent and inconsistent across\n  these shapes. Explicit regex → `{y,m,d}` → validated date.';
const add = anchor + `

### The driver undid the DATE choice — a bug that reached the API

Choosing \`DATE\` over \`TIMESTAMPTZ\` was necessary but **not sufficient**. Every date came out
of the API a day early:

\`\`\`
PDF:                  Contract Start Date: 03-01-2025
stored in Postgres:   2025-03-01            <- verified directly in psql
returned by the API:  02-28-2025            <- a day lost
\`\`\`

node-postgres parses a \`DATE\` column into a **JS \`Date\` at LOCAL midnight**. In UTC+3 that
makes \`2025-03-01\` the instant \`2025-02-28T22:00:00Z\`, and rendering it through
\`toISOString()\` drops the day. The database was right the whole time; only the read path was
wrong.

Fixed with explicit driver type parsers in \`src/db/types.ts\`:

| OID | Type | Parser | Why |
|---|---|---|---|
| 1082 | \`DATE\` | return the raw \`yyyy-mm-dd\` string | a calendar date has no instant to convert to |
| 1700 | \`NUMERIC\` | return the decimal string | already the default, pinned so it cannot change by accident — as a float \`22916.67\` becomes \`22916.669999999998\` |

Two things worth taking from this. **It is invisible west of UTC** — the same code passes in
UTC-5 and fails in UTC+3, so a test asserting the output date would pass on a reviewer's machine
and fail in production. The regression test therefore asserts the *mechanism*, reproducing the
shift explicitly and checking the parser is registered. And **it is the same class of mistake as
storing \`mm-dd-yyyy\` strings** — letting a representation decision leak into a layer that
should not be making one.

(Found only because the API output was checked field-by-field against the PDF rather than
assumed correct from the pipeline's own log, which showed the right values throughout.)`;
if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
fs.writeFileSync(p, t.replace(anchor, add));
console.log('documented');
