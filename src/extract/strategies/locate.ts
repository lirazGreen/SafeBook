/**
 * Deterministic locators over `raw_text`.
 *
 * Every one returns character OFFSETS as well as text, so a rule-sourced value
 * is traceable exactly like an LLM-sourced one — `GET /documents/:id/trace`
 * works uniformly, and "every stored value points back at document text" holds
 * without an exception for the deterministic path.
 */
export interface Located {
  text: string;
  start: number;
  end: number;
}

/** Lines with their offsets into the original text. */
function lines(raw: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let at = 0;
  for (const line of raw.split('\n')) {
    out.push({ text: line, start: at });
    at += line.length + 1;
  }
  return out;
}

/** Leading list markers the documents use: "● ", "• ", "1. ", "- ". */
const BULLET = /^\s*(?:[●•▪·]|\d+\.|-)\s*/;

/**
 * Section headings that end a block. A NAMED list rather than a Title-Case
 * heuristic, because the heuristic cannot tell a heading from the last line of an
 * address: "Canada" alone on a line is short, capitalised, comma-free and
 * digit-free, and it truncated NovaFleet's buyer address to two lines.
 *
 * Overridable per profile, so an unfamiliar document can declare its own.
 */
export const DEFAULT_SECTION_HEADINGS = [
  'Vendor', 'Buyer', 'Customer', 'Order Summary', 'Order Details', 'Line Items',
  'Subscriptions', 'Special Terms', 'Authorization', 'Terms and Conditions',
  'Customer Information', 'Payment Terms', 'Signature', 'Signatures',
];

function isSectionHeading(line: string, headings: string[]): boolean {
  const t = line.trim().replace(/:$/, '').toLowerCase();
  return headings.some((h) => h.toLowerCase() === t);
}

/** A "Label:" or "Label: value" line, bullet or not. */
function isLabelLine(line: string): boolean {
  const body = line.replace(BULLET, '').trim();
  return /^[A-Z][A-Za-z ()/-]{2,40}:/.test(body);
}

/**
 * `Label: value` on a single line. Tolerates a leading bullet, which both POs
 * use for their Order Summary fields (`● Contract Start Date: 03-01-2025`).
 *
 * Labels are tried IN ORDER, so a profile can put its customer's exact wording
 * first and let the base profile's synonyms follow.
 */
export function labelValue(raw: string, labels: string[]): Located | null {
  const ls = lines(raw);
  for (const label of labels) {
    const needle = label.toLowerCase();
    for (const line of ls) {
      const body = line.text.replace(BULLET, '');
      const offset = line.start + (line.text.length - body.length);
      const idx = body.toLowerCase().indexOf(needle);
      if (idx !== 0) continue;                   // the label must START the line
      const after = body.slice(needle.length).replace(/^\s*:\s*/, '');
      if (after.length === 0) continue;          // value is on following lines
      const start = offset + body.length - after.length;
      return { text: after.trim(), start, end: start + after.length };
    }
  }
  return null;
}

/**
 * `Label:` alone on its line, with the value on the lines beneath — how both POs
 * write addresses:
 *     Vendor Address:
 *     789 Market Street
 *     San Francisco, CA 94103, USA
 *
 * Stops at a blank line, at the next `Label:` line, or after `maxLines`.
 */
export interface MultilineOptions {
  maxLines?: number;
  /** Lines that end the block. Defaults to DEFAULT_SECTION_HEADINGS. */
  stopAt?: string[];
}

export function multilineAfterLabel(
  raw: string,
  labels: string[],
  options: MultilineOptions = {},
): Located | null {
  const maxLines = options.maxLines ?? 4;
  const headings = options.stopAt ?? DEFAULT_SECTION_HEADINGS;
  const ls = lines(raw);
  for (const label of labels) {
    const needle = label.toLowerCase();
    for (let i = 0; i < ls.length; i++) {
      const body = (ls[i] as { text: string }).text.replace(BULLET, '').trim();
      if (body.toLowerCase().replace(/\s*:$/, '') !== needle) continue;

      const parts: string[] = [];
      let start = -1;
      let end = -1;
      for (let j = i + 1; j < ls.length && parts.length < maxLines; j++) {
        const next = ls[j] as { text: string; start: number };
        const t = next.text.trim();
        if (t.length === 0) break;
        if (isSectionHeading(next.text, headings) || isLabelLine(next.text)) break;
        if (start === -1) start = next.start;
        end = next.start + next.text.length;
        parts.push(t);
      }
      if (parts.length === 0) continue;
      return { text: parts.join(', '), start, end };
    }
  }
  return null;
}

/**
 * Whether a signature block is executed. Returns null when no marker is found,
 * which escalates rather than defaulting to false — "we could not tell" and
 * "it is unsigned" are different answers.
 *
 * Covers only the marker convention both POs use (`Buyer Signature: ✔ Signed`).
 * Acme's two-column block and CloudShield's blank `Name: ____` placeholders need
 * their own strategies, added in phases 5 and 7.
 */
export function signatureMarker(raw: string, labels: string[]): { value: boolean; at: Located } | null {
  const found = labelValue(raw, labels);
  if (found === null) return null;
  const t = found.text.toLowerCase();
  if (/[✔✓x]|signed|yes|true/.test(t)) return { value: true, at: found };
  if (/^(?:_+|\s*|n\/?a|none|no)$/.test(t.trim())) return { value: false, at: found };
  return { value: true, at: found };
}

export interface LabelledTerm {
  termType: string;
  text: string;
  start: number;
  end: number;
  ordinal: number;
}

/**
 * Special terms written as labelled bullets, which is how both POs do it:
 *     ● Burst (Item Level): Buyer may exceed licensed analytics usage by up to 10% per
 *     contract year at no additional cost.
 *
 * A term's text continues onto following lines until the next bullet or the next
 * section heading. Returns [] on an order form, whose terms are numbered prose
 * with no labels — and that empty result is what triggers escalation.
 */
export function labelledBullets(
  raw: string,
  section: string,
  typeLabels: Record<string, string[]>,
): LabelledTerm[] {
  const ls = lines(raw);
  const startIdx = ls.findIndex((l) => l.text.trim().toLowerCase() === section.toLowerCase());
  if (startIdx === -1) return [];

  const terms: LabelledTerm[] = [];
  let current: LabelledTerm | null = null;
  let ordinal = 0;

  for (let i = startIdx + 1; i < ls.length; i++) {
    const line = ls[i] as { text: string; start: number };
    const trimmed = line.text.trim();
    // a bare section heading ends the block ("Authorization")
    if (!BULLET.test(line.text) && isSectionHeading(line.text, DEFAULT_SECTION_HEADINGS)) break;
    if (trimmed.length === 0) continue;

    if (BULLET.test(line.text)) {
      const body = line.text.replace(BULLET, '');
      const bodyStart = line.start + (line.text.length - body.length);
      const match = Object.entries(typeLabels)
        .flatMap(([type, labels]) => labels.map((l) => ({ type, l })))
        .find(({ l }) => body.toLowerCase().startsWith(l.toLowerCase()));
      if (match === undefined) { current = null; continue; }
      const after = body.slice(match.l.length).replace(/^\s*:\s*/, '');
      current = {
        termType: match.type,
        text: after.trim(),
        start: bodyStart + body.length - after.length,
        end: bodyStart + body.length,
        ordinal: ++ordinal,
      };
      terms.push(current);
    } else if (current !== null) {
      current.text = `${current.text} ${trimmed}`.trim();
      current.end = line.start + line.text.length;
    }
  }
  return terms;
}
