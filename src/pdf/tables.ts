import type { PageRegion, TextRun } from './types.ts';

/**
 * Reconstructs a table from positioned text runs.
 *
 * The approach was verified in phase 0 against all four sample documents — 19 of
 * 19 item rows recovered, every table reconciling against its stated total. See
 * `spike/README.md` and the "What phase 0 corrected" section of docs/DESIGN.md.
 *
 * Deliberately derives everything from the document itself rather than from
 * per-customer constants, so an unfamiliar layout has a chance of working. The
 * thresholds below are the only tuned numbers, they are all overridable, and the
 * defaults adapt to the table's own shape.
 */
export interface TableOptions {
  /** Runs closer together than this horizontally belong to the same column. */
  columnGapPt: number;
  /**
   * A data row must populate at least this FRACTION of the detected columns.
   * A fraction rather than a count, so a 3-column table works: a fixed ">= 4"
   * (which the spike used) would find no rows at all in one.
   */
  anchorColumnRatio: number;
  /** Floor for the above, so a 2-column table is still possible. */
  minAnchorColumns: number;
  /** Row band half-width = this x the median gap between consecutive y-levels. */
  bandFactor: number;
}

export const DEFAULT_TABLE_OPTIONS: TableOptions = {
  columnGapPt: 18,
  anchorColumnRatio: 0.5,
  minAnchorColumns: 2,
  bandFactor: 1.2,
};

export interface TableResult {
  /** Column left edges, discovered from DATA rows only. */
  columns: number[];
  /** Assembled header cells, or null if no header row was identified. */
  header: string[] | null;
  rows: TableRow[];
  /** Runs that fell outside every row band — a signal something is off. */
  orphans: TextRun[];
}

export interface TableRow {
  /** Baseline y of the anchor line, for diagnostics. */
  y: number;
  page: number;
  cells: string[];
}

const NUMERIC = /\d/;

/**
 * Columns are discovered from data runs only. Header fragments sit offset from
 * the columns they label — including NovaFleet's header invented a phantom 7th
 * column in the spike — so the header is assembled afterwards against these.
 */
function detectColumns(runs: TextRun[], gap: number): number[] {
  const cols: number[] = [];
  for (const run of [...runs].sort((a, b) => a.x - b.x)) {
    const last = cols[cols.length - 1];
    if (last === undefined || run.x - last > gap) cols.push(run.x);
  }
  return cols;
}

/**
 * `tolerance` differs by caller. Data runs define the columns, so they sit at or
 * just right of a column start and 2pt is right. HEADER fragments are offset
 * LEFT of the column they label — CloudShield's "Order Term" is at x=304 against
 * a data column at 315.8 — so header assembly passes the full column gap.
 */
function columnOf(x: number, cols: number[], tolerance = 2): number {
  let best = 0;
  for (let i = 0; i < cols.length; i++) if (x >= (cols[i] as number) - tolerance) best = i;
  return best;
}

/**
 * Band half-width: how far from its data line a wrapped cell fragment may sit.
 *
 * Takes the tightest of three bounds, because each alone has a failure mode seen
 * in testing:
 *  - 1.2 x the median gap between DATA y-levels (header levels excluded, or the
 *    header-to-data gap inflates it). On a wrapped table this is the intra-row
 *    line height — CloudShield: 6pt.
 *  - 0.6 x the smallest gap between adjacent data rows. Without this, a table
 *    with no wrapping has median gap == row pitch, and the band swallows the
 *    neighbouring row.
 *  - 2.5 x the median glyph height. The physical bound: a continuation line is a
 *    line or two below its cell, never twenty. Without this, a single data row
 *    plus one distant stray makes the median gap enormous.
 */
function bandHalfWidth(dataLevels: number[], anchors: number[], heights: number[], factor: number): number {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const gaps = dataLevels.slice(1).map((y, i) => (dataLevels[i] as number) - y);
  let band = gaps.length > 0 ? median(gaps) * factor : 12 * factor;
  if (anchors.length >= 2) {
    const pitches = anchors.slice(1).map((y, i) => (anchors[i] as number) - y);
    band = Math.min(band, Math.min(...pitches) * 0.6);
  }
  if (heights.length > 0) band = Math.min(band, median(heights) * 2.5);
  return band;
}

function joinCell(runs: TextRun[]): string {
  // top-to-bottom then left-to-right: a wrapped cell's fragments can sit both
  // ABOVE and BELOW its data line (CloudShield's "CloudShield" / "Enterprise")
  return runs
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((r) => r.text)
    .join(' ')
    .trim();
}

export function reconstructTable(
  regions: PageRegion[],
  options: Partial<TableOptions> = {},
): TableResult {
  const opt = { ...DEFAULT_TABLE_OPTIONS, ...options };
  const nonEmpty = regions.map((r) => ({ page: r.page, runs: r.runs.filter((x) => x.text.trim().length > 0) }));
  if (nonEmpty.every((r) => r.runs.length === 0)) {
    return { columns: [], header: null, rows: [], orphans: [] };
  }

  // --- pass 1: provisional columns, used only to find which levels are data rows
  const provisional = detectColumns(nonEmpty.flatMap((r) => r.runs), opt.columnGapPt);
  const anchorsPerRegion = nonEmpty.map((region) => findAnchors(region.runs, provisional, opt));

  // --- pass 2: re-detect columns from DATA rows ONLY.
  // Header fragments sit offset from the columns they label, so including them
  // invents phantom columns — it gave NovaFleet a 7th in the spike.
  const dataRuns = nonEmpty.flatMap((region, i) => {
    const { anchors, band } = anchorsPerRegion[i] as AnchorInfo;
    if (anchors.length === 0) return [];
    const floor = Math.max(...anchors) + band;
    return region.runs.filter((r) => r.y <= floor);
  });
  const columns = dataRuns.length > 0 ? detectColumns(dataRuns, opt.columnGapPt) : provisional;

  const rows: TableRow[] = [];
  const orphans: TextRun[] = [];
  let header: string[] | null = null;

  nonEmpty.forEach((region, i) => {
    const { anchors, band } = anchorsPerRegion[i] as AnchorInfo;
    if (anchors.length === 0) {
      orphans.push(...region.runs);
      return;
    }
    const headerFloor = Math.max(...anchors) + band;

    // Everything above the first data row is the header — assembled column-first,
    // because its fragments are not row-aligned across columns. Only the first
    // region can have one: a table continuing onto a new page repeats no header.
    if (header === null) {
      const headerRuns = region.runs.filter((r) => r.y > headerFloor);
      if (headerRuns.length > 0) {
        header = columns.map((_, c) =>
          joinCell(headerRuns.filter((r) => columnOf(r.x, columns, opt.columnGapPt) === c)),
        );
      }
    }

    const grid = anchors.map(() => columns.map((): TextRun[] => []));
    for (const run of region.runs) {
      if (run.y > headerFloor) continue; // consumed by the header
      let bi = -1;
      let bd = Infinity;
      anchors.forEach((ay, ai) => {
        const d = Math.abs(run.y - ay);
        if (d < bd) { bd = d; bi = ai; }
      });
      if (bi < 0 || bd > band) { orphans.push(run); continue; }
      (grid[bi] as TextRun[][])[columnOf(run.x, columns)]!.push(run);
    }

    anchors.forEach((y, ai) => {
      rows.push({ y, page: region.page, cells: (grid[ai] as TextRun[][]).map(joinCell) });
    });
  });

  return { columns, header, rows, orphans };
}

interface AnchorInfo {
  anchors: number[];
  band: number;
}

function findAnchors(runs: TextRun[], cols: number[], opt: TableOptions): AnchorInfo {
  if (runs.length === 0) return { anchors: [], band: 0 };
  const threshold = Math.max(opt.minAnchorColumns, Math.ceil(cols.length * opt.anchorColumnRatio));
  const levels = [...new Set(runs.map((r) => r.y))].sort((a, b) => b - a);

  const candidates = levels.filter(
    (y) => new Set(runs.filter((r) => r.y === y).map((r) => columnOf(r.x, cols))).size >= threshold,
  );
  // A candidate with no digits anywhere is a header line, not data. Self-detecting,
  // so a profile need not declare header_rows.
  const anchors = candidates.filter((y) => runs.some((r) => r.y === y && NUMERIC.test(r.text)));
  if (anchors.length === 0) return { anchors, band: 0 };

  // Levels at or below the topmost data row. Header levels are excluded here so
  // the header-to-data gap cannot inflate the band.
  const top = Math.max(...anchors);
  const dataLevels = levels.filter((y) => y <= top);
  const heights = runs.filter((r) => r.y <= top && r.h > 0).map((r) => r.h);

  return { anchors, band: bandHalfWidth(dataLevels, anchors, heights, opt.bandFactor) };
}

/**
 * Carries a sparse column's value down to rows that leave it blank.
 * CloudShield's `subscription_year` is blank on all three Premium Support rows
 * and must inherit "Year 1"/"2"/"3" from the Enterprise row above. Returns which
 * cells were inherited so they can be recorded in `field_sources`.
 */
export function carryDown(rows: TableRow[], columnIndexes: number[]): Map<number, number[]> {
  const inherited = new Map<number, number[]>();
  const lastSeen = new Map<number, string>();
  rows.forEach((row, ri) => {
    for (const ci of columnIndexes) {
      const value = row.cells[ci] ?? '';
      if (value.length > 0) { lastSeen.set(ci, value); continue; }
      const prev = lastSeen.get(ci);
      if (prev === undefined) continue;
      row.cells[ci] = prev;
      const marks = inherited.get(ri) ?? [];
      marks.push(ci);
      inherited.set(ri, marks);
    }
  });
  return inherited;
}
