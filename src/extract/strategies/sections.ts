/**
 * Named section spans over `raw_text`, plus masks that PRESERVE CHARACTER
 * OFFSETS.
 *
 * Both capabilities here are about the same problem: a PDF has no section
 * structure, only lines, so "this block is not part of the contract" has to be
 * reconstructed.
 *
 *   ignore_sections  a block no document-level field may read.
 *                    CloudShield's order form carries its own "Purchase Order
 *                    Information" block holding `PO Amount: USD 0.00` — a decoy
 *                    that a generic `Total Amount` synonym would happily match.
 *   in_section       the complement: a field read ONLY from inside a named
 *                    block. Strictly better than exempting a field from the
 *                    mask, because it also stops `PO Number:` matching
 *                    somewhere else in an eight-page document.
 *
 * MASKS REPLACE CHARACTERS WITH SPACES RATHER THAN DELETING THEM, and keep every
 * newline. The masked copy is therefore the same length with the same line
 * breaks, so every offset a locator returns still indexes into the ORIGINAL
 * raw_text — which is what keeps the evidence span verifiable. Splicing the text
 * instead would shift every subsequent offset and quietly corrupt the trace.
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * A bound so a mis-detected boundary cannot swallow the rest of the document.
 * Not configurable: it exists to limit the blast radius of being wrong, and a
 * profile raising it would be removing the guard rather than tuning it.
 */
const MAX_SECTION_LINES = 8;

function lines(raw: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let at = 0;
  for (const line of raw.split('\n')) {
    out.push({ text: line, start: at });
    at += line.length + 1;
  }
  return out;
}

const headingMatches = (line: string, heading: string) =>
  line.trim().replace(/:$/, '').toLowerCase() === heading.trim().toLowerCase();

/**
 * Where a named block ends.
 *
 * The block is the heading plus the run of KEY/VALUE lines under it — a line
 * carrying `:` or `?`. That is a structural property of what these blocks are
 * (`PO Number:`, `PO Amount: USD 0.00`, and the question
 * `Is a Purchase Order (PO) required …? No`), not a guess about capitalisation.
 *
 * Deliberately NOT a Title-Case shape test: the design already learned that one
 * the hard way, when a short, capitalised, comma-free, digit-free line —
 * `Canada` — truncated NovaFleet's billing address because it is indistinguishable
 * from a heading by shape.
 *
 * It is also deliberately FORWARD-looking and bounded rather than "walk back to
 * the nearest heading". Both directions are imperfect, because the structure
 * isn't in the file; this one's failure mode is better. Over-masking a few lines
 * turns a field into a flagged NULL, while a backwards walk that misses a
 * boundary would ignore everything to the end of the document.
 */
export function findSectionSpan(
  raw: string,
  heading: string,
  knownHeadings: string[] = [],
): Span | null {
  const ls = lines(raw);
  const startIdx = ls.findIndex((l) => headingMatches(l.text, heading));
  if (startIdx === -1) return null;

  const first = ls[startIdx] as { text: string; start: number };
  let end = first.start + first.text.length;

  for (let i = startIdx + 1; i < ls.length && i - startIdx <= MAX_SECTION_LINES; i++) {
    const line = ls[i] as { text: string; start: number };
    const t = line.text.trim();
    if (t.length === 0) break;
    if (knownHeadings.some((h) => headingMatches(line.text, h))) break;
    if (!t.includes(':') && !t.includes('?')) break;
    end = line.start + line.text.length;
  }
  return { start: first.start, end };
}

/** Blanks the given spans, keeping length and newlines so offsets still hold. */
function blank(raw: string, spans: Span[], invert = false): string {
  const inside = (i: number) => spans.some((s) => i >= s.start && i < s.end);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === '\n') { out += ch; continue; }
    out += inside(i) === invert ? ch : ' ';
  }
  return out;
}

/** The text a document-level lookup sees: every ignored block blanked out. */
export function maskSections(raw: string, headings: string[], knownHeadings: string[] = []): string {
  const spans = headings
    .map((h) => findSectionSpan(raw, h, knownHeadings))
    .filter((s): s is Span => s !== null);
  return spans.length === 0 ? raw : blank(raw, spans);
}

/**
 * The text an `in_section` lookup sees: everything OUTSIDE the named block
 * blanked out. A missing heading yields all-blank rather than the whole
 * document, so the field comes back null and is flagged — never silently
 * answered from elsewhere.
 */
export function keepOnlySection(raw: string, heading: string, knownHeadings: string[] = []): string {
  const span = findSectionSpan(raw, heading, knownHeadings);
  return blank(raw, span === null ? [] : [span], true);
}
