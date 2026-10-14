const fs = require('fs');
const p = 'docs/DESIGN.md';
let t = fs.readFileSync(p, 'utf8');
const anchor = '### Phase 5 — wire the escalator';
const add = `### What actually escalates, across all four documents

Enumerated rather than assumed, by running every field's deterministic rule over all four:

| Document | Escalates |
|---|---|
| BrightOps | **nothing** |
| NovaFleet | **nothing** |
| Acme | \`payment_terms_days\`, \`special_terms\` |
| CloudShield | \`payment_terms_days\`, \`billing_frequency\`, \`special_terms\` |

**5 escalations across 2 documents; 2 documents need zero calls.** So phase 5 records 5
fixtures — it is not "Acme's phase", and describing it that way was the same mistake as
declaring \`strategy: llm\` per customer.

CloudShield's \`billing_frequency\` is the instructive one: Acme writes
\`Billing Frequency: Annual\` as a plain label, while CloudShield states it only in prose
("Payment will be made annually"). Same field, same profile, one parses and one escalates —
decided by the document.

### Two bugs the enumeration found

**1. The order-form base profile was substantially incomplete.** Auditing it against the PO base
showed it declared no \`parties\` and no \`type_fields\` at all — so both order forms would have
extracted no buyer, no vendor, no addresses, no signatures and no quote numbers. Not escalated:
*silently absent*, because an undeclared field is never attempted. (The order-form base was
written before the PO base was rewritten to include those sections, and never back-ported. This
was the third gap found in it — the first two were item date synonyms and \`billing_frequency\`.)

The lesson: **an undeclared field fails silently, while a failed rule escalates.** Those are
very different outcomes, and only the second is safe. A profile audit comparing the two base
profiles section by section is now a cheap check worth repeating whenever either changes.

**2. An unimplemented strategy fell through to a plain label lookup — and invented data.**
An order form's buyer \`signer_name\` is declared with the bare label \`Name\`, pending the
two-column signature strategy. Falling through made it match the **item table header**:

\`\`\`
signer_name = "Start Date End Date Rate Quantity Total amount"
\`\`\`

A declared-but-unimplemented strategy now returns \`null\`, which escalates. Garbage is worse
than nothing: *"could not tell"* and *"here is a value"* are different answers, and only the
first one escalates. Two call sites bypassed the check entirely (\`signature_present\` and
\`signature_date\` called their locators directly) and now route through it.

`;
if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
fs.writeFileSync(p, t.replace(anchor, add + anchor));
console.log('documented');
