/**
 * Escalation for "who issued this document", used only when all three
 * deterministic methods fail (PO title, PO buyer label, signature-line
 * subtraction / preamble).
 *
 * The role must be stated explicitly, because the issuer's role INVERTS by
 * document type and getting it backwards is the one dangerous failure here: the
 * inferred name selects which customer's profile runs, so naming the
 * counterparty would route the document to the wrong extraction rules.
 *
 * Three guards make escalation safe:
 *  1. the role is named in the instruction, not left implicit
 *  2. the quote must exist in raw_text, so a name cannot be invented
 *  3. the answer is cross-checked against the counterparty we already extracted,
 *     and rejected if they are the same organisation
 * Plus a fourth by construction: the name is matched against a CLOSED SET of
 * registered customers, so an unrecognised answer degrades to `unmatched` and
 * the base profile — never to a wrong profile.
 */
export const ISSUER_INSTRUCTION_PURCHASE_ORDER = `Field: issuer_name

A purchase order is issued BY THE BUYER — the organisation that is purchasing and
will pay. Return the BUYER's organisation name.

Do NOT return the vendor, supplier or seller: that is the counterparty, and
naming it would be wrong even though it appears just as prominently.

Look for the buying organisation under headings such as "Buyer", "Bill To", or in
the document's own title. Return the organisation, never a person's name.`;

export const ISSUER_INSTRUCTION_ORDER_FORM = `Field: issuer_name

An order form is issued BY THE SELLER — the organisation offering the goods or
services and expecting payment. Return the SELLER's (vendor's) organisation name.

Do NOT return the customer or buyer: on an order form the customer is usually
named far more prominently (under "To:", "Customer Information", "Bill to"),
which makes it the tempting wrong answer.

The seller is often stated only in a contract preamble ("entered into by and
between X ...") or in its signature block, and may appear just once in the whole
document. Return the organisation, never a person's name.`;

export function issuerInstruction(docType: 'order_form' | 'purchase_order' | null): string {
  return docType === 'purchase_order'
    ? ISSUER_INSTRUCTION_PURCHASE_ORDER
    : ISSUER_INSTRUCTION_ORDER_FORM;
}
