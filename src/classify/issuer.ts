/**
 * Resolves which registered customer ISSUED a document, from the content alone.
 *
 * Resolution is a COUNT, not a weighted score: exactly one customer matching
 * wins, two or more is ambiguous and gets flagged. Letting a "heavier" pattern
 * win would be guessing, which is rejected here for the same reason it is for
 * currency and dates — a silent wrong answer is worse than a flagged one.
 */
export type MatchKind = 'text' | 'signature_block' | 'doc_id';

export interface CustomerPattern {
  customerId: number;
  slug: string;
  kind: MatchKind;
  pattern: string;
}

export type Resolution = 'matched' | 'ambiguous' | 'unmatched';

export interface IssuerResult {
  customerId: number | null;
  slug: string | null;
  resolution: Resolution;
  /** Every customer that matched — more than one is why `ambiguous` exists. */
  candidates: string[];
  /** The raw issuer string, recorded EVEN WHEN NOTHING MATCHED: it is what a
   *  human reads to decide who this should be, and what lets a new customer be
   *  registered from real data rather than guesswork. */
  detectedIssuerName: string | null;
}

/**
 * The signature block, where Acme's name appears and nowhere else.
 *
 * Verified: "Acme" occurs exactly ONCE in its entire document, in the signature
 * block, while CloudShield occurs 35 times. A whole-document search would be too
 * weak to rely on, which is why `kind` exists.
 */
const SIGNATURE_LEAD_IN = 5;

function signatureRegion(rawText: string): string {
  const lines = rawText.split('\n');
  const start = lines.findIndex((l) =>
    /^(authorization|signature|signatures|in witness whereof)/i.test(l.trim()),
  );
  if (start !== -1) {
    // Include a few lines ABOVE the heading: the party names sit above their
    // "Signature:" lines, not below. Acme's issuer name is on the line directly
    // preceding its first "Signature:", so starting at the heading excludes it.
    return lines.slice(Math.max(0, start - SIGNATURE_LEAD_IN)).join('\n');
  }
  // no heading at all: fall back to the last fifth, where signature blocks sit
  return lines.slice(Math.floor(lines.length * 0.8)).join('\n');
}

/** Document identifiers such as `PO-BO-10458` or `Q-78291`. */
function docIdRegion(rawText: string): string {
  return rawText
    .split('\n')
    .filter((l) => /\b(?:purchase order number|po number|quote number)\s*:/i.test(l))
    .join('\n');
}

export function resolveIssuer(rawText: string, patterns: CustomerPattern[]): IssuerResult {
  const regions: Record<MatchKind, string> = {
    text: rawText,
    signature_block: signatureRegion(rawText),
    doc_id: docIdRegion(rawText),
  };

  const matched = new Map<number, string>();
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, 'im');
    } catch {
      continue; // patterns are compiled at seed time; skip defensively
    }
    if (re.test(regions[p.kind])) matched.set(p.customerId, p.slug);
  }

  const detectedIssuerName = detectIssuerName(rawText);
  const entries = [...matched.entries()];

  if (entries.length === 1) {
    const [customerId, slug] = entries[0] as [number, string];
    return { customerId, slug, resolution: 'matched', candidates: [slug], detectedIssuerName };
  }
  if (entries.length > 1) {
    return {
      customerId: null,
      slug: null,
      resolution: 'ambiguous',
      candidates: entries.map(([, s]) => s),
      detectedIssuerName,
    };
  }
  return { customerId: null, slug: null, resolution: 'unmatched', candidates: [], detectedIssuerName };
}

/**
 * A best-effort guess at the issuing organisation's name, for a human to read
 * when nothing matched. Never used to resolve a customer — only to make
 * registering one possible without opening the PDF.
 */
function detectIssuerName(rawText: string): string | null {
  const lines = rawText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  // a PO titles itself after its issuer: "Purchase Order – BrightOps Analytics Ltd."
  for (const line of lines.slice(0, 3)) {
    const m = /^purchase order\s*[–—-]\s*(.+)$/i.exec(line);
    if (m) return (m[1] as string).trim();
  }
  // otherwise the first line naming a company suffix
  const suffix = /\b(?:Inc|Inc\.|LLC|Ltd|Ltd\.|Limited|GmbH|B\.V\.|S\.A\.|Corp|Corporation|Co\.)\b/;
  for (const line of lines.slice(0, 12)) {
    if (suffix.test(line) && line.length < 80) return line;
  }
  return null;
}
