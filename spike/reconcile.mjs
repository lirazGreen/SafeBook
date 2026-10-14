import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';

// (file, stated total, [ {page, yTop, yBot}, ... ]) — tables can span pages
const DOCS = [
  ['ACME Order From.pdf', 152500, [[2, 645, 525]]],
  ['CloudShield Order Form.pdf', 23640000, [[2, 676, 500]]],
  ['Purchase Order – BrightOps Analytics Ltd.pdf', 162000, [[1, 140, 110], [2, 710, 630]]],
  ['Purchase Order – NovaFleet Technologies Inc.pdf', 451000, [[1, 125, 85], [2, 710, 655]]],
];

const num = (s) => { const m = s.replace(/[^0-9.]/g, ''); return m ? Number(m) : NaN; };

for (const [name, stated, regions] of DOCS) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`sample docs/${name}`)), useSystemFonts: true }).promise;
  let rows = 0, sum = 0;
  for (const [pageNo, yTop, yBot] of regions) {
    const items = (await (await doc.getPage(pageNo)).getTextContent()).items
      .filter((i) => i.str.trim().length > 0)
      .map((i) => ({ x: +i.transform[4].toFixed(1), y: +i.transform[5].toFixed(1), s: i.str.trim() }))
      .filter((i) => i.y <= yTop && i.y >= yBot);
    // columns from data items
    const cols = [];
    for (const it of [...items].sort((a, b) => a.x - b.x)) {
      const l = cols[cols.length - 1];
      if (l && it.x - l <= 18) continue; else cols.push(it.x);
    }
    const colOf = (x) => { let b = 0; for (let i = 0; i < cols.length; i++) if (x >= cols[i] - 2) b = i; return b; };
    const levels = [...new Set(items.map((i) => i.y))].sort((a, b) => b - a);
    const anchors = levels.filter((y) => new Set(items.filter((i) => i.y === y).map((i) => colOf(i.x))).size >= 4);
    const gaps = levels.slice(1).map((y, i) => levels[i] - y).sort((a, b) => a - b);
    const band = (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12) * 1.2;
    const grid = anchors.map(() => cols.map(() => []));
    for (const it of items) {
      let bi = -1, bd = Infinity;
      anchors.forEach((ay, i) => { const d = Math.abs(it.y - ay); if (d < bd) { bd = d; bi = i; } });
      if (bi >= 0 && bd <= band) grid[bi][colOf(it.x)].push(it);
    }
    for (const row of grid) {
      const last = row[row.length - 1].map((f) => f.s).join(' ');
      const v = num(last);
      if (!Number.isNaN(v)) { sum += v; rows++; }
    }
  }
  const ok = sum === stated;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.replace(/\.pdf$/, '').padEnd(46)} ${rows} rows  Σ=${sum.toLocaleString()}  stated=${stated.toLocaleString()}`);
}
