import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageRegion, TextRun } from './types.ts';

export interface ParsedPdf {
  pageCount: number;
  /** Concatenated page text. Stored and then FROZEN: evidence offsets index into it. */
  rawText: string;
  /** Positioned runs per page. Held in memory only — never persisted. */
  pages: PageRegion[];
}

export async function parsePdf(path: string): Promise<ParsedPdf> {
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages: PageRegion[] = [];
  const texts: string[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
      if (item.str.trim().length === 0) continue;
      runs.push({
        x: item.transform[4] as number,
        y: item.transform[5] as number,
        w: item.width,
        h: item.height,
        text: item.str.trim(),
      });
    }
    pages.push({ page: n, runs });
    texts.push(text);
  }

  return { pageCount: doc.numPages, rawText: texts.join('\n'), pages };
}
