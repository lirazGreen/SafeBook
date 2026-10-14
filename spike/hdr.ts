import { parsePdf } from '../src/pdf/parse.ts';
import { findTableRegions } from '../src/pdf/findTable.ts';
import { reconstructTable } from '../src/pdf/tables.ts';
import { loadProfiles } from '../src/profiles/loader.ts';
const d = (await loadProfiles()).find((p) => p.customerSlug === 'cloudshield')!.definition;
const { pages } = await parsePdf('sample docs/CloudShield Order Form.pdf');
const regions = findTableRegions(pages, {
  columnSynonyms: d.items!.column_synonyms!,
  terminators: ['Total Subscription Fee', 'Payment Terms'],
});
console.log(JSON.stringify(reconstructTable(regions).header, null, 0));
