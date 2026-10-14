const fs = require('fs');
const p = 'docs/DESIGN.md';
let t = fs.readFileSync(p, 'utf8');

const start = t.indexOf('### Phases 4–7 — add customers in difficulty order');
const end = t.indexOf('### Phase 8 — operational layer');
if (start === -1 || end === -1) { console.error('anchors missing'); process.exit(1); }

const neu = `### Phase 4 — NovaFleet ✅ *already passing*

The profile-system canary. Exit criterion was "adding a second customer should be nearly free"
— it turned out to need **no customer profile file at all**: NovaFleet scores 48/48 from
\`purchase_order/_base.yaml\` alone. That is the Adaptability KPI demonstrated rather than
claimed.

### Phase 5 — wire the escalator

**Not an Acme phase.** Escalation is customer-agnostic: *any* field on *any* document reaches
Claude when its deterministic rule yields nothing or fails to parse. The seam was built in
phase 2 with \`escalate: null\`; this phase supplies the implementation behind it — the Claude
client in live/record/fixture modes, the recorded fixtures, and the evidence + value-in-quote
verification already written in \`llm/evidence.ts\`.

An earlier draft of this plan called phase 6 "Acme's prose", which framed needing an LLM as a
property of a customer. It is not. Once wired, a *future* BrightOps document whose wording
changes so \`Net 30\` no longer parses escalates automatically — no config change and no new
phase. Building it before Acme also means Acme lands complete in one pass instead of sitting
half-extracted for a phase.

**Exit:** Acme's payment terms resolves to \`Net 30\` by escalation from
*"shall be made within thirty (30) days from invoice"*, while **both POs still make zero
calls** — asserted, not observed.

### Phase 6 — Acme, complete

The first customer needing a profile override, in four ways:

| | Acme | the POs |
|---|---|---|
| document dates | \`January 1, 2025\` | \`03-01-2025\` |
| item dates | \`Jan 1,2025\` (no space after the comma) | \`03-01-2025\` |
| money | \`$152,500\` — **no ISO code anywhere in the document**, so \`default_currency\` is required | \`$162,000 USD\` |
| signature | **two-column block** | \`Buyer Signature: ✔ Signed\` |

The signature is the real work and the first strategy to need **geometry** rather than
\`raw_text\`. Both columns collapse onto single text lines, so \`Name:\` appears twice with
nothing to distinguish them:

\`\`\`
Acme Appsoft Inc
Signature:
Name: John Smith      <- x≈77,  Acme's (vendor) signer
Name: Bob Lee         <- x≈311, Appsoft's (buyer) signer
\`\`\`

Only the x-coordinates separate them; the profile declares \`buyer_column: right\`.

### Phase 7 — CloudShield

The hardest document: the 8-column wrapped table (already proven in phase 0),
\`ignore_sections\` for its own "Purchase Order Information" block, per-year Burst attribution
onto the right item rows, \`code_prefix\` money, and the \`placeholder_lines\` signature strategy
where blank \`Name: ____\` lines mean **false**.

**Exit: all four documents at ≥95%.**

`;
fs.writeFileSync(p, t.slice(0, start) + neu + t.slice(end));
console.log('phases reframed');
