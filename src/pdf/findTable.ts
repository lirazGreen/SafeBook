import { DEFAULT_SECTION_HEADINGS } from '../extract/strategies/locate.ts';
import type { PageRegion, TextRun } from './types.ts';

/**
 * Locates the item table without hand-written page coordinates.
 *
 * The header row is the anchor: it is the y-level whose runs match the most
 * distinct column synonyms from the profile. From there the table runs downward
 * until a terminator — the grand-total line or a section heading — and continues
 * onto the next page if it reaches the bottom, because both sample POs split
 * their table across a page break with the header on page 1 only.
 */
export interface FindTableOptions {
  columnSynonyms: Record<string, string[]>;
  /** Lines that end the table: "Total PO Amount:", "Total fee:", "Special Terms". */
  terminators: string[];
  /** Minimum distinct columns a line must match to count as the header. */
  minHeaderMatches?: number;
  /** Headings that bound the header block above. Defaults to the shared list. */
  sectionHeadings?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[*†‡]+/g, ' ').replace(/\s+/g, ' ').trim();

function headerScore(runs: TextRun[], synonyms: Record<string, string[]>): number {
  const matched = new Set<string>();
  for (const [field, list] of Object.entries(synonyms)) {
    for (const syn of list) {
      const s = norm(syn);
      if (s.length > 0 && runs.some((r) => norm(r.text).includes(s))) { matched.add(field); break; }
    }
  }
  return matched.size;
}

/** y-levels grouped, top first. */
function levels(runs: TextRun[]): { y: number; runs: TextRun[] }[] {
  const byY = new Map<number, TextRun[]>();
  for (const r of runs) {
    const key = Math.round(r.y * 10) / 10;
    if (!byY.has(key)) byY.set(key, []);
    (byY.get(key) as TextRun[]).push(r);
  }
  return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, rs]) => ({ y, runs: rs }));
}

export function findTableRegions(pages: PageRegion[], opts: FindTableOptions): PageRegion[] {
  const minMatches = opts.minHeaderMatches ?? 3;
  const terms = opts.terminators.map(norm).filter((t) => t.length > 0);
  const headings = new Set((opts.sectionHeadings ?? DEFAULT_SECTION_HEADINGS).map(norm));
  const isTerminator = (rs: TextRun[]) => {
    const line = norm(rs.map((r) => r.text).join(' '));
    return terms.some((t) => line.startsWith(t) || line === t);
  };

  // 1. find the header: the best-scoring level anywhere in the document
  let header: { page: number; y: number; score: number } | null = null;
  for (const page of pages) {
    for (const lvl of levels(page.runs)) {
      const score = headerScore(lvl.runs, opts.columnSynonyms);
      if (score >= minMatches && (header === null || score > header.score)) {
        header = { page: page.page, y: lvl.y, score };
      }
    }
  }
  if (header === null) return [];

  // 1b. Extend UPWARD over the rest of the header block.
  //
  // A wrapped header spans several y-levels and the best-scoring one is rarely
  // the topmost: CloudShield's densest line is "Subscriptions / Start Date /
  // End Date / Unit Price / Billable / Total Price" at y=697, while
  // "Monthly /" and "Quantity of" sit at 709 and "Subscription"/"Order Term" at
  // 703. Starting at 697 cut those off AND left the levels below it (691, 685)
  // to be misread as data rows.
  //
  // Walk up while the gap stays small (intra-header line spacing) and the level
  // carries no digits — which stops before the first data row and before a
  // product name sitting a full row-pitch above.
  const headerPage = pages.find((pg) => pg.page === header.page) as PageRegion;
  const headerLevels = levels(headerPage.runs);
  const headerIdx = headerLevels.findIndex((l) => l.y === (header as { y: number }).y);
  let headerTop = header.y;
  if (headerIdx > 0) {
    const gaps = headerLevels
      .slice(1)
      .map((l, i) => (headerLevels[i] as { y: number }).y - l.y)
      .filter((g) => g > 0)
      .sort((a, b) => a - b);
    const typical = gaps.length > 0 ? (gaps[Math.floor(gaps.length / 4)] as number) : 8;
    for (let i = headerIdx - 1; i >= 0; i--) {
      const lvl = headerLevels[i] as { y: number; runs: TextRun[] };
      const below = headerLevels[i + 1] as { y: number };
      if (lvl.y - below.y > typical * 1.8) break;
      if (lvl.runs.some((r) => /\d/.test(r.text))) break;
      // ...and stop at the SECTION HEADING above the table. BrightOps' "Line
      // Items" sits 25pt above its header with no digits, so neither the gap
      // nor the digit test excludes it, and it was being absorbed into the
      // header as "Line Items Product Name".
      if (headings.has(norm(lvl.runs.map((r) => r.text).join(' ')))) break;
      headerTop = lvl.y;
    }
  }

  // 2. walk down from the header, continuing onto later pages until a terminator
  const out: PageRegion[] = [];
  let started = false;
  for (const page of pages) {
    if (page.page < header.page) continue;
    const kept: TextRun[] = [];
    let stop = false;
    for (const lvl of levels(page.runs)) {
      if (page.page === header.page && lvl.y > headerTop) continue; // above the header block
      if (isTerminator(lvl.runs)) { stop = true; break; }
      kept.push(...lvl.runs);
      started = true;
    }
    if (kept.length > 0) out.push({ page: page.page, runs: kept });
    if (stop) break;
    if (!started) break;
  }
  return out;
}
