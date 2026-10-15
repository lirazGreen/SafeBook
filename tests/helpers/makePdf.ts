/**
 * Writes a minimal, valid PDF from positioned text.
 *
 * Needed because every existing test either uses one of the four sample PDFs or
 * reuses their geometry — so nothing exercised a document from a customer the
 * system has never seen, through the REAL parse → classify → infer → extract
 * path. Synthesising a `ParsedPdf` object instead would skip `pdfjs` entirely,
 * which is precisely the layer that turns coordinates into rows.
 *
 * Deliberately hand-rolled rather than a dependency: the whole feature is text
 * at coordinates, the generated file is ~1KB, and a PDF library would be a
 * production dependency carried for tests. Correct `xref` offsets matter —
 * `pdfjs` can often reconstruct a broken table, and a test fixture that only
 * works by luck is worse than none.
 */
export interface TextLine {
  /** Points from the left edge. Columns are built by varying this. */
  x: number;
  /** Points from the BOTTOM edge, PDF convention — higher is further up. */
  y: number;
  text: string;
  size?: number;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * Characters outside WinAnsiEncoding, mapped to the byte that DOES represent
 * them there.
 *
 * Found the hard way: a U+25CF written literally came back out of pdfjs as a
 * capital I-diaeresis, so the labelled-bullet parse saw no bullets and returned
 * no special terms. The test failure looked like a pipeline bug and was an
 * encoding bug in this file. WinAnsi has `bullet` at 0x95, which is what the
 * real documents' bullets decode to anyway.
 */
const WINANSI: Record<string, string> = {
  '\u25cf': '\\225',   // BLACK CIRCLE        -> bullet
  '\u2022': '\\225',   // BULLET              -> bullet
  '\u2714': 'x',       // HEAVY CHECK MARK has no WinAnsi form; signatureMarker accepts x
  '\u2013': '\\226',   // EN DASH
  '\u2019': '\\222',   // RIGHT SINGLE QUOTE
};

/** `(`, `)` and backslash terminate or escape a PDF literal string. */
function escape(s: string): string {
  let out = s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  for (const [ch, byte] of Object.entries(WINANSI)) out = out.split(ch).join(byte);
  return out;
}

function contentStream(lines: TextLine[]): string {
  // `Tm` sets the text matrix absolutely, so each line is placed independently
  // rather than relative to the last — which is what makes a two-column block or
  // a table expressible.
  return lines
    .map((l) => `BT /F1 ${l.size ?? 10} Tf 1 0 0 1 ${l.x} ${l.y} Tm (${escape(l.text)}) Tj ET`)
    .join('\n');
}

/**
 * @param pages one array of lines per page.
 * @returns the PDF bytes, parseable by `parsePdfBytes`.
 */
export function makePdf(pages: TextLine[][]): Buffer {
  const count = pages.length;
  // object numbering: 1 catalog, 2 pages, 3 font, then per page a page object
  // and a content stream
  const FONT = 3;
  const pageObj = (i: number) => 4 + i * 2;
  const contentObj = (i: number) => 5 + i * 2;

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${count} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`;
  objects[FONT] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((lines, i) => {
    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`;
    const body = contentStream(lines);
    objects[contentObj(i)] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  });

  // Assemble, recording each object's byte offset for the xref table.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let n = 1; n < objects.length; n++) {
    // exactly 20 bytes per entry, or the table is invalid
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** Lays out successive lines down the page from `startY`, at `leading` spacing. */
export function column(startY: number, lines: string[], x = 60, leading = 14): TextLine[] {
  return lines.map((text, i) => ({ x, y: startY - i * leading, text }));
}

/** One table row: cells at the given x positions, all on one baseline. */
export function row(y: number, cells: [number, string][]): TextLine[] {
  return cells.map(([x, text]) => ({ x, y, text }));
}
