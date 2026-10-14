import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
const [file, pageNo, yTop, yBot] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5]];
// column x-starts are discovered from the DATA region, then the header is
// assembled column-first (headers are not row-aligned across columns)
const dataCols = process.argv[6].split(',').map(Number);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true }).promise;
const items = (await (await doc.getPage(pageNo)).getTextContent()).items
  .filter((i) => i.str.trim().length > 0)
  .map((i) => ({ x: +i.transform[4].toFixed(1), y: +i.transform[5].toFixed(1), s: i.str.trim() }))
  .filter((i) => i.y <= yTop && i.y >= yBot);
const colOf = (x) => { let b = 0; for (let i = 0; i < dataCols.length; i++) if (x >= dataCols[i] - 12) b = i; return b; };
const buckets = dataCols.map(() => []);
for (const it of items) buckets[colOf(it.x)].push(it);
console.log('header assembled column-first:');
buckets.forEach((b, i) => {
  const text = b.sort((a, c) => c.y - a.y || a.x - c.x).map((f) => f.s).join(' ');
  console.log(`  col ${i} (x>=${dataCols[i]}): ${JSON.stringify(text)}`);
});
