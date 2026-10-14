import type { DocType } from '../profiles/loader.ts';
import { labelValue } from '../extract/strategies/locate.ts';

/**
 * Infers WHO ISSUED a document, from content alone and with no per-customer
 * configuration. This is the difference between "look for what we registered"
 * and "work out who sent this" — and it is what gives an UNREGISTERED customer
 * an accurate name for a human to register them by.
 *
 * The method differs by document type, because the issuer's ROLE inverts:
 *
 *   Purchase Order -> issued by the BUYER, and stated plainly twice:
 *       "Purchase Order – BrightOps Analytics Ltd."     (title)
 *       "Company Name: BrightOps Analytics Ltd."        (under the Buyer heading)
 *
 *   Order Form     -> issued by the VENDOR, which is NOT stated plainly.
 *       Acme's name appears exactly once in its whole document, and
 *       CloudShield's is buried in legal preamble prose.
 *
 * The order-form trick: both parties share ONE signature line, and the BUYER is
 * stated plainly elsewhere. So the issuer is the signature line MINUS the buyer:
 *
 *   "Acme Appsoft Inc"  -  "Appsoft Inc."  =  "Acme"
 *   "CloudShield Security, Inc. TechNova Solutions, Inc."
 *                       -  "TechNova Solutions, Inc."
 *                       =  "CloudShield Security, Inc."
 *
 * No geometry, no regex per customer.
 */
export type InferenceMethod =
  | 'po_title'
  | 'po_buyer_label'
  | 'of_signature_minus_buyer'
  | 'of_preamble'
  | 'company_suffix_scan';

export interface InferredIssuer {
  name: string | null;
  method: InferenceMethod | null;
  /** Every method that produced a name, for diagnostics and disagreement checks. */
  candidates: { method: InferenceMethod; name: string }[];
}

/** Casefold, drop punctuation and collapse whitespace. Keeps company suffixes. */
export function normaliseOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BUYER_LABELS = [
  'Customer Billing Company Name',
  'Customer Billing Name',
  'Company Name',
  'Buyer Name',
  'To',
];

/** Lines that look like "<Party A> <Party B>" in a signature block. */
function signaturePartyLine(rawText: string): string | null {
  const lines = rawText.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // the party line sits directly above the signature rules/labels
    const next = (lines[i + 1] ?? '') + (lines[i + 2] ?? '');
    if (!/^(?:_{3,}|signature)/i.test(next.trim())) continue;
    if (line.length < 4 || line.length > 120) continue;
    if (/[:]/.test(line)) continue;
    return line;
  }
  return null;
}

/**
 * Normalised copy of a string plus a map from each normalised index back to the
 * original, so a match found on the normalised form can be cut out of the raw
 * text positionally. Same technique as llm/evidence.ts.
 */
function normaliseWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = (s[i] as string).toLowerCase();
    if (/[.,'"()]/.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (text.length > 0 && !text.endsWith(' ')) { text += ' '; map.push(i); }
      continue;
    }
    text += ch;
    map.push(i);
  }
  return { text: text.trim(), map };
}

/**
 * Removes the buyer from the shared signature line, POSITIONALLY.
 *
 * Token filtering does not work here: both CloudShield and TechNova end in
 * "Inc.", so a token-set filter keeps both and yields
 * "CloudShield Security, Inc. Inc.". Cutting the matched span out of the raw
 * string by offset avoids that.
 */
function subtractBuyer(signatureLine: string, buyerName: string): string | null {
  const { text: line, map } = normaliseWithMap(signatureLine);
  const buyer = normaliseOrgName(buyerName);
  if (buyer.length === 0) return null;

  const at = line.indexOf(buyer);
  if (at === -1) return null;

  const rawStart = map[at] as number;
  const rawEnd = (map[at + buyer.length - 1] as number) + 1;
  const rest = (signatureLine.slice(0, rawStart) + ' ' + signatureLine.slice(rawEnd))
    .replace(/\s+/g, ' ')
    // The buyer's own trailing "." sits outside the normalised span (punctuation
    // is dropped during normalisation), so it survives the cut as an orphan:
    // "CloudShield Security, Inc. ." Strip punctuation that is separated from
    // the text, while leaving an attached suffix like "Inc." intact.
    .replace(/\s+[.,;:]+\s*$/, '')
    .replace(/^\s*[.,;:]+\s+/, '')
    .trim();
  return rest.length > 1 ? rest : null;
}

export function inferIssuer(rawText: string, docType: DocType | null): InferredIssuer {
  const candidates: { method: InferenceMethod; name: string }[] = [];
  const add = (method: InferenceMethod, name: string | null | undefined) => {
    const t = name?.trim();
    if (t !== undefined && t.length > 1 && t.length < 120) candidates.push({ method, name: t });
  };

  if (docType === 'purchase_order') {
    // a PO titles itself after its issuer
    const first = rawText.split('\n').slice(0, 3);
    for (const line of first) {
      const m = /^\s*purchase order\s*[–—-]\s*(.+?)\s*$/i.exec(line);
      if (m) add('po_title', m[1]);
    }
    // ...and names it again under the Buyer heading
    add('po_buyer_label', labelValue(rawText, ['Company Name', 'Buyer Name'])?.text);
  }

  if (docType === 'order_form') {
    const buyer = labelValue(rawText, BUYER_LABELS)?.text;
    const sig = signaturePartyLine(rawText);
    if (buyer !== undefined && sig !== null) {
      add('of_signature_minus_buyer', subtractBuyer(sig, buyer));
    }
    // CloudShield states it in the preamble: "entered into by and between X, a company…"
    const pre = /\bby and between\s+(.+?)(?:,\s*an?\b|,\s*a company\b|\s+and the customer\b)/i.exec(rawText);
    if (pre) add('of_preamble', (pre[1] as string).replace(/\s+/g, ' '));
  }

  if (candidates.length === 0) {
    // last resort, type-agnostic: the first line naming a company suffix
    const suffix = /\b(?:Inc|LLC|Ltd|Limited|GmbH|B\.V\.|S\.A\.|Corp|Corporation|Co)\b\.?/;
    for (const line of rawText.split('\n').slice(0, 12).map((l) => l.trim())) {
      if (suffix.test(line) && line.length < 80 && !line.includes(':')) {
        add('company_suffix_scan', line);
        break;
      }
    }
  }

  return { name: candidates[0]?.name ?? null, method: candidates[0]?.method ?? null, candidates };
}

/** Matches an inferred name to a registered customer by normalised name. */
export function matchCustomerByName(
  inferred: string,
  customers: { id: number; slug: string; name: string }[],
): { id: number; slug: string } | null {
  const target = normaliseOrgName(inferred);
  const hit = customers.find((c) => {
    const n = normaliseOrgName(c.name);
    return n === target || target.startsWith(n) || n.startsWith(target);
  });
  return hit ? { id: hit.id, slug: hit.slug } : null;
}
