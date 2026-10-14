/**
 * Rule 5 in the system prompt earns its place here. Acme's payment section
 * states TWO things:
 *   "Payment of the Total Subscription Fee shall be made in advance of such
 *    period. Payment shall be made within thirty (30) days from invoice."
 * "in advance" is billing timing; the net term is the thirty days from invoice.
 * Asking for "the payment terms" would make either answer defensible, so the
 * instruction names the measurement explicitly.
 */
export const PAYMENT_TERMS_INSTRUCTION = `Field: payment_terms_days

Return the number of DAYS AFTER INVOICING within which payment becomes due, as
an integer.

Contracts normally write the number in words with the digits in brackets:
  "shall be made within thirty (30) days from invoice"        -> 30
  "within forty-five (45) days of Customer's receipt of an invoice" -> 45
  "Net 30"                                                     -> 30

Do NOT return:
- a billing frequency ("Annual", "paid annually")
- when payment starts relative to the service period ("in advance of such period")
- a subscription term length

If the excerpt describes terms that are not a number of days after invoicing
(for example "50% on signature"), return null.`;
