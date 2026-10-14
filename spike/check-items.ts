import { parsePdf } from '../src/pdf/parse.ts';
import { reconstructTable } from '../src/pdf/tables.ts';
import { mapItems } from '../src/extract/items.ts';
import { loadProfiles } from '../src/profiles/loader.ts';

const profiles = await loadProfiles();
const base = (dt: string) => profiles.find((p) => p.customerSlug === null && p.docType === dt)!.definition;
const cloud = profiles.find((p) => p.customerSlug === 'cloudshield')!.definition;

const CASES: [string, string, any, number[][]][] = [
  ['Purchase Order – BrightOps Analytics Ltd.pdf', 'po', base('purchase_order'), [[1, 180, 110], [2, 710, 630]]],
  ['Purchase Order – NovaFleet Technologies Inc.pdf', 'po', base('purchase_order'), [[1, 175, 85], [2, 710, 655]]],
  ['CloudShield Order Form.pdf', 'of', cloud, [[2, 715, 500]]],
];

for (const [file, , def, regions] of CASES) {
  const { pages } = await parsePdf(`sample docs/${file}`);
  const table = reconstructTable(
    regions.map(([p, top, bot]) => ({
      page: p!,
      runs: (pages.find((x) => x.page === p)?.runs ?? []).filter((r) => r.y <= top! && r.y >= bot!),
    })),
  );
  const mapped = mapItems(table, {
    columnSynonyms: def.items?.column_synonyms,
    optionalColumns: def.items?.optional_columns,
    carryDownFields: def.items?.carry_down,
    dateFormat: def.items?.date_format,
    documentCurrency: 'USD',
  });
  console.log(`\n### ${file}`);
  console.log('columnMap:', JSON.stringify(mapped.columnMap));
  if (mapped.unmappedHeaders.length) console.log('UNMAPPED:', mapped.unmappedHeaders);
  let sum = 0;
  for (const it of mapped.items) {
    sum += Number(it.totalAmount ?? 0);
    console.log(
      `  ${String(it.lineNo)}. ${String(it.productName).padEnd(32)} ${String(it.itemStartDate)} -> ${String(it.itemEndDate)}  qty=${String(it.quantity).padStart(7)}  unit=${String(it.unitPrice).padStart(10)}  total=${String(it.totalAmount).padStart(12)} ${it.currency}` +
      (Object.keys(it.attributes).length ? `  attrs=${JSON.stringify(it.attributes)}` : '') +
      (Object.keys(it.fieldSources).length ? `  sources=${JSON.stringify(it.fieldSources)}` : ''),
    );
  }
  console.log('  SUM =', sum.toLocaleString());
}
