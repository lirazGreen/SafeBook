const fs = require('fs');
const p = 'docs/DESIGN.md';
let t = fs.readFileSync(p, 'utf8');
const anchor = 'Covered by `tests/unit/inferIssuer.test.ts`, including that a PO\'s two sources agree, that the\nshared `Inc.` suffix is not duplicated, and that an unregistered issuer is still named.';
const add = anchor + `

### If all three rules fail, Claude is asked

\`issuer_name\` is escalatable, so a layout that defeats the PO title, the buyer label AND the
signature subtraction still gets an answer rather than going straight to \`unmatched\`.

Escalating here is safe for a structural reason: **the answer is matched against a CLOSED SET
of registered customers.** An invented or unrecognised name cannot route anywhere — it degrades
to \`unmatched\` and the base profile, exactly where a failed rule would have left it. So
hallucination costs nothing.

One failure mode the closed set does **not** catch, and the only genuinely dangerous one:
**naming the counterparty.** On a PO the issuer is the buyer; if Claude returned the vendor and
that vendor happened to be a registered customer, the document would route to the *wrong*
customer's extraction rules. Three guards:

1. **The prompt names the role**, because it inverts by document type — \`issued BY THE BUYER\`
   for a PO, \`issued BY THE SELLER\` for an order form — and explicitly warns off the other
   party, which on an order form is the more prominently named and therefore more tempting one.
2. **The quote must exist in \`raw_text\`**, so a name cannot be fabricated.
3. **\`issuerIsNotCounterparty()\`** rejects an answer matching the party already extracted.

A test asserts escalation does **not** fire for any of the four samples, since the
deterministic rules already succeed — so the LLM is genuinely a fallback here, not the path.`;
if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
fs.writeFileSync(p, t.replace(anchor, add));
console.log('documented');
