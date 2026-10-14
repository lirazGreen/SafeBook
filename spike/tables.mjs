import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';

const file = process.argv[2], pageNo = Number(process.argv[3] ?? 1);
const yTop = Number(process.argv[4] ?? Infinity), yBot = Number(process.argv[5] ?? -Infinity);

const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true }).promise;
const items = (await (await doc.getPage(pageNo)).getTextContent()).items
  .filter((i) => i.str.trim().length > 0)
  .map((i) => ({ x: +i.transform[4].toFixed(1), y: +i.transform[5].toFixed(1), w: +i.width.toFixed(1), s: i.str.trim() }))
  .filter((i) => i.y <= yTop && i.y >= yBot);

// ---- 1. columns: cluster x-starts, merge clusters closer than a gap threshold
const COL_GAP = 18;
const xs = [...items].sort((a, b) => a.x - b.x);
const cols = [];
for (const it of xs) {
  const last = cols[cols.length - 1];
  if (last && it.x - last.x <= COL_GAP) { last.x = Math.min(last.x, it.x); last.n++; }
  else cols.push({ x: it.x, n: 1 });
}
console.log(`columns detected (${cols.length}):`, cols.map((c) => `${c.x}(${c.n})`).join('  '));
const colOf = (x) => { let best = 0; for (let i = 0; i < cols.length; i++) if (x >= cols[i].x - 2) best = i; return best; };

// ---- 2. anchor rows: y-levels carrying several columns = real data lines
const byY = new Map();
for (const it of items) { if (!byY.has(it.y)) byY.set(it.y, []); byY.get(it.y).push(it); }
const levels = [...byY.keys()].sort((a, b) => b - a);
const anchors = levels.filter((y) => new Set(byY.get(y).map((i) => colOf(i.x))).size >= 4);
// Band half-width from the MEDIAN gap between consecutive y-levels, not from the
// anchor pitch. Row pitch is not uniform (a wrapped product name makes one row
// taller than the next), and with a single anchor there is no pitch at all.
const gaps = levels.slice(1).map((y, i) => levels[i] - y).sort((a, b) => a - b);
const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;
const band = medGap * 1.2;
console.log(`anchor rows (${anchors.length}) at y:`, anchors.join(', '), `| median line gap ${medGap.toFixed(1)} -> band +/-${band.toFixed(1)}`);

// ---- 3. assign every item to its nearest anchor, then to a column
const grid = anchors.map(() => cols.map(() => []));
const orphans = [];
for (const it of items) {
  let bi = -1, bd = Infinity;
  anchors.forEach((ay, i) => { const d = Math.abs(it.y - ay); if (d < bd) { bd = d; bi = i; } });
  if (bi < 0 || bd > band) { orphans.push(it); continue; }
  grid[bi][colOf(it.x)].push(it);
}
// multi-fragment cells join top-to-bottom, left-to-right
const cell = (frs) => frs.sort((a, b) => b.y - a.y || a.x - b.x).map((f) => f.s).join(' ');

console.log(`\nreconstructed ${anchors.length} rows x ${cols.length} cols:`);
grid.forEach((row, i) => {
  console.log(`  [${String(anchors[i]).padStart(5)}] ` + row.map((c) => (cell(c) || '·').padEnd(22)).join('| '));
});
if (orphans.length) console.log(`\norphans (outside any row band): ` + orphans.map((o) => `${o.y}:${JSON.stringify(o.s)}`).join(' '));
