const fs = require('fs');
const p = 'src/pdf/findTable.ts';
let t = fs.readFileSync(p, 'utf8');

t = t.replace(
  `import type { PageRegion, TextRun } from './types.ts';`,
  `import { DEFAULT_SECTION_HEADINGS } from '../extract/strategies/locate.ts';\nimport type { PageRegion, TextRun } from './types.ts';`);

t = t.replace(
  `  /** Minimum distinct columns a line must match to count as the header. */
  minHeaderMatches?: number;`,
  `  /** Minimum distinct columns a line must match to count as the header. */
  minHeaderMatches?: number;
  /** Headings that bound the header block above. Defaults to the shared list. */
  sectionHeadings?: string[];`);

t = t.replace(
  `      if (lvl.y - below.y > typical * 1.8) break;
      if (lvl.runs.some((r) => /\\d/.test(r.text))) break;`,
  `      if (lvl.y - below.y > typical * 1.8) break;
      if (lvl.runs.some((r) => /\\d/.test(r.text))) break;
      // ...and stop at the SECTION HEADING above the table. BrightOps' "Line
      // Items" sits 25pt above its header with no digits, so neither the gap
      // nor the digit test excludes it, and it was being absorbed into the
      // header as "Line Items Product Name".
      if (headings.has(norm(lvl.runs.map((r) => r.text).join(' ')))) break;`);

t = t.replace(
  `  const terms = opts.terminators.map(norm).filter((t) => t.length > 0);`,
  `  const terms = opts.terminators.map(norm).filter((t) => t.length > 0);
  const headings = new Set((opts.sectionHeadings ?? DEFAULT_SECTION_HEADINGS).map(norm));`);

fs.writeFileSync(p, t);
console.log('patched');
