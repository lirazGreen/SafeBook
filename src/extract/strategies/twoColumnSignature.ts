import type { TextRun } from '../../pdf/types.ts';

/**
 * Reads a TWO-COLUMN signature block, which both sample order forms use.
 *
 * Needs GEOMETRY rather than text: each line collapses both columns into one
 * string, so "Name:" appears twice with nothing in the text to tell them apart.
 * Only the x-coordinate separates them.
 *
 *   Acme         x=77 'Name: John Smith'   x=311 'Name: Bob Lee'
 *   CloudShield  x=96 'Name: ____'         x=312 'Name: ____'
 *
 * An earlier plan had a SECOND strategy (`placeholder_lines`) for CloudShield.
 * The blocks turned out to be structurally identical — the only difference is
 * whether the chosen column holds a value or blank underscores — so this is one
 * capability with two outcomes, not two strategies.
 */
export interface TwoColumnSignature {
  /** null when the block was found but we cannot tell — which escalates. */
  signaturePresent: boolean | null;
  signerName: string | null;
  signerTitle: string | null;
  signatureDate: string | null;
  /** x of the column taken, for diagnostics. */
  columnX: number | null;
}

const EMPTY: TwoColumnSignature = {
  signaturePresent: null, signerName: null, signerTitle: null,
  signatureDate: null, columnX: null,
};

/** A value that is only underscores, dots or whitespace is an UNFILLED placeholder. */
const isPlaceholder = (v: string) => v.trim().length === 0 || /^[_.\s-]+$/.test(v.trim());

const LABELS = { signerName: /^name\s*:/i, signerTitle: /^title\s*:/i, signatureDate: /^date\s*:/i };

/**
 * Finds the signature block and returns the requested column.
 *
 * The block is located by a line whose runs contain "Signature" in two or more
 * x-positions, or two or more runs of underscores — both samples have one.
 */
export function readTwoColumnSignature(
  runs: TextRun[],
  buyerColumn: 'left' | 'right' = 'right',
): TwoColumnSignature {
  if (runs.length === 0) return EMPTY;

  const byY = new Map<number, TextRun[]>();
  for (const r of runs) {
    const k = Math.round(r.y);
    if (!byY.has(k)) byY.set(k, []);
    (byY.get(k) as TextRun[]).push(r);
  }
  const levels = [...byY.entries()]
    .map(([y, rs]) => ({ y, runs: rs.sort((a, b) => a.x - b.x) }))
    .sort((a, b) => b.y - a.y);

  // the anchor: a level with the SAME marker in two or more columns
  const anchor = levels.find(
    (l) =>
      l.runs.filter((r) => /^signature\b/i.test(r.text.trim())).length >= 2 ||
      l.runs.filter((r) => /^_{3,}$/.test(r.text.trim())).length >= 2,
  );
  if (anchor === undefined) return EMPTY;

  // column x-positions come from the anchor itself, so they are read from the
  // document rather than assumed
  const columnXs = anchor.runs.map((r) => r.x).sort((a, b) => a - b);
  if (columnXs.length < 2) return EMPTY;
  const targetX = buyerColumn === 'left' ? (columnXs[0] as number) : (columnXs[columnXs.length - 1] as number);
  const tolerance = 24;

  const out: TwoColumnSignature = { ...EMPTY, columnX: targetX };
  // labelled lines sit BELOW the anchor in both samples
  for (const level of levels.filter((l) => l.y < anchor.y)) {
    const run = level.runs.find((r) => Math.abs(r.x - targetX) <= tolerance);
    if (run === undefined) continue;
    for (const [field, re] of Object.entries(LABELS) as [keyof typeof LABELS, RegExp][]) {
      if (!re.test(run.text.trim())) continue;
      const value = run.text.replace(re, '').trim();
      if (!isPlaceholder(value)) out[field] = value;
    }
  }

  // Signed if the column carries any filled value at all. Both samples agree:
  // Acme has "Name: Bob Lee"; CloudShield has only underscores.
  const anyFilled = out.signerName !== null || out.signerTitle !== null || out.signatureDate !== null;
  out.signaturePresent = anyFilled;
  return out;
}
