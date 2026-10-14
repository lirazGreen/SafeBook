const fs = require('fs');
const p = 'src/extract/items.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`  options: {
    columnSynonyms?: Record<string, string[]>;
    optionalColumns?: Record<string, string[]>;
    carryDownFields?: string[];
    dateFormat?: DateFormat;
    documentCurrency?: string | null;
  } = {},`,
`  // undefined is accepted explicitly: callers pass profile values straight
  // through, and under exactOptionalPropertyTypes an absent profile key is
  // undefined rather than a missing property.
  options: {
    columnSynonyms?: Record<string, string[]> | undefined;
    optionalColumns?: Record<string, string[]> | undefined;
    carryDownFields?: string[] | undefined;
    dateFormat?: DateFormat | undefined;
    documentCurrency?: string | null | undefined;
  } = {},`);
fs.writeFileSync(p, t);
console.log('patched');
