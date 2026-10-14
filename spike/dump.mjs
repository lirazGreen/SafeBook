import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
const [file, pageNo] = [process.argv[2], Number(process.argv[3] ?? 1)];
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true }).promise;
const page = await doc.getPage(pageNo);
const items = (await page.getTextContent()).items
  .filter((i) => i.str.trim().length > 0)
  .map((i) => ({ x: +i.transform[4].toFixed(1), y: +i.transform[5].toFixed(1), w: +i.width.toFixed(1), h: i.height, s: i.str }))
  .sort((a, b) => b.y - a.y || a.x - b.x);
for (const i of items) console.log(`y=${String(i.y).padStart(6)} x=${String(i.x).padStart(6)} w=${String(i.w).padStart(5)} ${JSON.stringify(i.s)}`);
