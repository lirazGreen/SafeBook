const fs = require('fs');
const p = 'src/pdf/findTable.ts';
let t = fs.readFileSync(p, 'utf8');
const find = `  // 2. walk down from the header, continuing onto later pages until a terminator`;
const repl = `  // 1b. Extend UPWARD over the rest of the header block.
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
      if (lvl.runs.some((r) => /\\d/.test(r.text))) break;
      headerTop = lvl.y;
    }
  }

  // 2. walk down from the header, continuing onto later pages until a terminator`;
if (!t.includes(find)) { console.error('anchor missing'); process.exit(1); }
t = t.replace(find, repl);
t = t.replace(
  `      if (page.page === header.page && lvl.y > header.y) continue; // above the header`,
  `      if (page.page === header.page && lvl.y > headerTop) continue; // above the header block`);
fs.writeFileSync(p, t);
console.log('patched');
