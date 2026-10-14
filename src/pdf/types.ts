/** One positioned text run as pdfjs emits it: words are already assembled. */
export interface TextRun {
  /** transform[4] — left edge. */
  x: number;
  /** transform[5] — the BASELINE, not the glyph box. Stable across descenders. */
  y: number;
  /** advance width */
  w: number;
  /** glyph height — the physical line height, used to bound the row band */
  h: number;
  text: string;
}

/** A contiguous slice of one page. Tables span page breaks, so regions are a list. */
export interface PageRegion {
  page: number;
  runs: TextRun[];
}
