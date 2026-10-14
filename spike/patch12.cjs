const fs = require('fs');
const p = 'docs/DESIGN.md';
let t = fs.readFileSync(p, 'utf8');
const anchor = '## Implementation phases';
const add = `## The accuracy harness (phase 3)

\`npm run accuracy\` scores the real pipeline against hand-read ground truth and prints a number.

\`\`\`
Purchase Order – BrightOps Analytics Ltd.pdf
  48/48 (100.0%)  llm calls: 0  review: (none)

Purchase Order – NovaFleet Technologies Inc.pdf
  48/48 (100.0%)  llm calls: 0  review: (none)

================================================================
  96 / 96 scored values  =  100.0%
  KPI is >=95%: PASS  (allows 4 wrong, 0 wrong)
================================================================
\`\`\`

**It runs with no database and no API key.** Profiles and customers load from YAML, and the
import graph never touches \`db/pool.ts\` — verified by stopping Postgres and running it anyway.
That is what makes the printed number mean something: whoever reviews this repo can reproduce it
from a fresh clone with \`npm install && npm run accuracy\`.

**Why it exists at phase 3 rather than at the end.** It is a *tool*, not a deliverable. The
original plan had it at phase 9, which would have meant building seven phases blind — every
change a judgement call rather than a measurement. Moved to phase 3, it guards every subsequent
phase: when Acme's \`long_month\` parser lands in phase 5, this says immediately whether it broke
the POs.

**Scored values** are the document fields, both parties' fields, the type-specific details,
every item column, and each special term — 48 per purchase order. Two deliberate choices:

- **A correctly-extracted \`null\` counts as a PASS.** A PO's vendor never signs, so
  \`vendor.signaturePresent: null\` is the right answer; scoring it as a miss would make the
  ceiling unreachable.
- **Money compares numerically**, so \`"72000"\` and \`"72000.00"\` are equal — the DB returns
  NUMERIC with its scale, and the harness should test the value rather than the formatting.

\`tests/accuracy/kpi.test.ts\` additionally asserts the per-field expectations and
\`reviewReasons == []\`, so the KPI breaks the build rather than only printing badly. It also
asserts \`llmCalls === 0\` for every purchase order, which keeps the "the rules already parse"
claim honest rather than incidental.

`;
if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
fs.writeFileSync(p, t.replace(anchor, add + anchor));
console.log('documented');
