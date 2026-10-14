import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
const data = new Uint8Array(readFileSync(process.argv[2]));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const page = await doc.getPage(Number(process.argv[3] ?? 1));
const tc = await page.getTextContent();
console.log('pages:', doc.numPages, '| items on this page:', tc.items.length);
console.log('--- first 4 items, full shape ---');
for (const it of tc.items.slice(0, 4)) console.log(' ', JSON.stringify(it));
