import { parsePdf } from '../src/pdf/parse.ts';
import { findTableRegions } from '../src/pdf/findTable.ts';
import { reconstructTable } from '../src/pdf/tables.ts';
import { mapItems } from '../src/extract/items.ts';
import { loadProfiles } from '../src/profiles/loader.ts';

const profiles = await loadProfiles();
const def = (slug: string | null, dt: string) =>
  profiles.find((p) => p.customerSlug === slug && p.docType === dt)!.definition;

const CASES: [string, ReturnType<typeof def>, string[], number][] = [
  ['Purchase Order – BrightOps Analytics Ltd.pdf', def(null, 'purchase_order'), ['Total PO Amount', 'Special Terms'], 162_000],
  ['Purchase Order – NovaFleet Technologies Inc.pdf', def(null, 'purchase_order'), ['Total PO Amount', 'Special Terms'], 451_000],
  ['CloudShield Order Form.pdf', def('cloudshield', 'order_form'), ['Total Subscription Fee', 'Payment Terms'], 23_640_000],
  ['ACME Order From.pdf', def(null, 'order_form'), ['Total fee', 'Special Terms'], 152_500],
];

for (const [file, d, terminators, expected] of CASES) {
  const { pages } = await parsePdf(`sample docs/${file}`);
  const regions = findTableRegions(pages, {
    columnSynonyms: d.items!.column_synonyms!,
    terminators,
  });
  const table = reconstructTable(regions);
  const mapped = mapItems(table, {
    columnSynonyms: d.items?.column_synonyms,
    optionalColumns: d.items?.optional_columns,
    carryDownFields: d.items?.carry_down,
    dateFormat: d.items?.date_format,
    documentCurrency: 'USD',
  });
  const sum = mapped.items.reduce((t, i) => t + Number(i.totalAmount ?? 0), 0);
  const ok = sum === expected;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${file.replace(/\.pdf$/, '').slice(0, 42).padEnd(44)} ` +
    `regions=${regions.map((r) => r.page).join('+')} rows=${mapped.items.length} SUM=${sum.toLocaleString()} (want ${expected.toLocaleString()})`,
  );
  if (mapped.unmappedHeaders.length) console.log('        unmapped:', mapped.unmappedHeaders);
}
