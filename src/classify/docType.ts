import type { DocType } from '../profiles/loader.ts';

/**
 * Classifies a document from its CONTENT — never its filename or folder. The
 * assigner confirmed this is the right approach, and the filenames prove why:
 * "ACME Order From.pdf" misspells "Form", and two samples are named after the
 * vendor while two are named after the buyer.
 *
 * Weighted signals rather than keyword matching, because of one specific trap:
 * CloudShield's ORDER FORM contains a section headed "Purchase Order
 * Information" with "PO Number:" and "PO Amount: USD 0.00". A substring match on
 * "purchase order" misclassifies it. Position weighting settles it — its actual
 * title is "ORDER FORM" on line 1.
 */
export interface Signal {
  name: string;
  weight: number;
  test: (ctx: ClassifyContext) => boolean;
}

export interface ClassifyContext {
  rawText: string;
  /** Lowercased, for case-insensitive tests. */
  lower: string;
  /** The first few lines, where a document states what it is. */
  titleRegion: string;
  lines: string[];
}

const hasLine = (ctx: ClassifyContext, re: RegExp) => ctx.lines.some((l) => re.test(l.trim()));

export const ORDER_FORM_SIGNALS: Signal[] = [
  { name: 'title', weight: 3, test: (c) => /\border form\b/i.test(c.titleRegion) },
  { name: 'quote_number', weight: 3, test: (c) => /\bquote number\s*:/i.test(c.lower) },
  { name: 'quote_expiration', weight: 2, test: (c) => /\bquote expiration date\s*:/i.test(c.lower) },
  { name: 'proposed_by', weight: 2, test: (c) => /\bproposed by\s*:/i.test(c.lower) },
  { name: 'addressed_to', weight: 2, test: (c) => hasLine(c, /^to\s*:/i) },
  { name: 'customer_information', weight: 1, test: (c) => hasLine(c, /^customer information$/i) },
  { name: 'not_an_invoice', weight: 1, test: (c) => /this is not an invoice/i.test(c.lower) },
];

export const PURCHASE_ORDER_SIGNALS: Signal[] = [
  {
    name: 'title',
    weight: 3,
    // the TITLE region only — CloudShield's mid-document "Purchase Order
    // Information" heading must not score here
    test: (c) => /\bpurchase order\b/i.test(c.titleRegion),
  },
  { name: 'po_number', weight: 3, test: (c) => /\bpurchase order number\s*:/i.test(c.lower) },
  {
    name: 'vendor_and_buyer_headings',
    weight: 3,
    // A PO names both roles under explicit headings; an order form never does.
    test: (c) => hasLine(c, /^vendor$/i) && hasLine(c, /^buyer$/i),
  },
  { name: 'po_date', weight: 2, test: (c) => hasLine(c, /^po date\s*:/i) },
  { name: 'total_po_amount', weight: 2, test: (c) => /\btotal po amount\s*:/i.test(c.lower) },
  { name: 'buyer_signature', weight: 2, test: (c) => /\bbuyer signature\s*:/i.test(c.lower) },
  { name: 'line_items', weight: 1, test: (c) => hasLine(c, /^line items$/i) },
];

export interface Classification {
  docType: DocType | null;
  /** 0..1, the winner's share of the two scores. */
  confidence: number;
  scores: { order_form: number; purchase_order: number };
  matched: { order_form: string[]; purchase_order: string[] };
  /** True when the margin is too small to decide — escalate to Claude. */
  needsEscalation: boolean;
}

/** Below either of these the scores are too close to trust. */
const MIN_MARGIN = 3;
const MIN_WINNING_SCORE = 4;

export function classify(rawText: string, titleLines = 3): Classification {
  const lines = rawText.split('\n');
  const ctx: ClassifyContext = {
    rawText,
    lower: rawText.toLowerCase(),
    titleRegion: lines.slice(0, titleLines).join('\n'),
    lines,
  };

  const score = (signals: Signal[]) => {
    const matched = signals.filter((s) => s.test(ctx));
    return { total: matched.reduce((t, s) => t + s.weight, 0), names: matched.map((s) => s.name) };
  };
  const of = score(ORDER_FORM_SIGNALS);
  const po = score(PURCHASE_ORDER_SIGNALS);

  const scores = { order_form: of.total, purchase_order: po.total };
  const matched = { order_form: of.names, purchase_order: po.names };
  const winner: DocType = po.total > of.total ? 'purchase_order' : 'order_form';
  const high = Math.max(of.total, po.total);
  const margin = Math.abs(of.total - po.total);
  const needsEscalation = margin < MIN_MARGIN || high < MIN_WINNING_SCORE;

  return {
    docType: needsEscalation ? null : winner,
    confidence: high === 0 ? 0 : Number((high / (of.total + po.total)).toFixed(3)),
    scores,
    matched,
    needsEscalation,
  };
}
