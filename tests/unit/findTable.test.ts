import { describe, expect, it } from 'vitest';
import { findTableRegions } from '../../src/pdf/findTable.ts';
import { parsePdf } from '../../src/pdf/parse.ts';
import { reconstructTable } from '../../src/pdf/tables.ts';
import { mapItems } from '../../src/extract/items.ts';
import { loadProfiles } from '../../src/profiles/loader.ts';

const profiles = await loadProfiles();
const def = (slug: string | null, dt: 'order_form' | 'purchase_order') =>
  profiles.find((p) => p.customerSlug === slug && p.docType === dt)!.definition;

const CASES = [
  ['Purchase Order – BrightOps Analytics Ltd.pdf', null, 'purchase_order', ['Total PO Amount', 'Special Terms'], 162_000, 4, [1, 2]],
  ['Purchase Order – NovaFleet Technologies Inc.pdf', null, 'purchase_order', ['Total PO Amount', 'Special Terms'], 451_000, 4, [1, 2]],
  ['CloudShield Order Form.pdf', 'cloudshield', 'order_form', ['Total Subscription Fee', 'Payment Terms'], 23_640_000, 6, [2]],
  ['ACME Order From.pdf', null, 'order_form', ['Total fee', 'Special Terms'], 152_500, 5, [2]],
] as const;

describe('locating the item table with no hand-written coordinates', () => {
  it.each(CASES)('%s', async (file, slug, docType, terminators, total, rowCount, pagesUsed) => {
    const d = def(slug, docType);
    const { pages } = await parsePdf(`sample docs/${file}`);
    const regions = findTableRegions(pages, {
      columnSynonyms: d.items!.column_synonyms!,
      terminators: [...terminators],
    });
    expect(regions.map((r) => r.page)).toEqual([...pagesUsed]);

    const mapped = mapItems(reconstructTable(regions), {
      columnSynonyms: d.items?.column_synonyms,
      optionalColumns: d.items?.optional_columns,
      carryDownFields: d.items?.carry_down,
      dateFormat: d.items?.date_format,
      documentCurrency: 'USD',
    });
    expect(mapped.items).toHaveLength(rowCount);
    expect(mapped.unmappedHeaders).toEqual([]);
    expect(mapped.items.reduce((t, i) => t + Number(i.totalAmount ?? 0), 0)).toBe(total);
  });

  it('stitches a table across a page break, header on the first page only', async () => {
    const d = def(null, 'purchase_order');
    const { pages } = await parsePdf('sample docs/Purchase Order – BrightOps Analytics Ltd.pdf');
    const regions = findTableRegions(pages, {
      columnSynonyms: d.items!.column_synonyms!,
      terminators: ['Total PO Amount', 'Special Terms'],
    });
    expect(regions).toHaveLength(2);
    const table = reconstructTable(regions);
    expect(table.header?.[0]).toBe('Product Name');
    expect(table.rows.map((r) => r.page)).toEqual([1, 2, 2, 2]);
  });

  it('captures the WHOLE wrapped header block, not just its densest line', async () => {
    // CloudShield's densest header line is y=697, but "Monthly /" is at 709 and
    // "**"/"Units***" at 685. Anchoring on 697 alone cut the former off and
    // mis-read the latter as data rows.
    const d = def('cloudshield', 'order_form');
    const { pages } = await parsePdf('sample docs/CloudShield Order Form.pdf');
    const regions = findTableRegions(pages, {
      columnSynonyms: d.items!.column_synonyms!,
      terminators: ['Total Subscription Fee', 'Payment Terms'],
    });
    expect(reconstructTable(regions).header).toEqual([
      'Subscription Year', 'Subscriptions', 'Start Date', 'End Date',
      'Order Term (Months)', 'Monthly / Unit Price **',
      'Quantity of Billable Units***', 'Total Price',
    ]);
  });

  it('returns no regions when the document has no table', async () => {
    const regions = findTableRegions(
      [{ page: 1, runs: [{ x: 70, y: 300, w: 50, h: 10, text: 'Dear Sir or Madam,' }] }],
      { columnSynonyms: { product_name: ['Product Name'] }, terminators: ['Total'] },
    );
    expect(regions).toEqual([]);
  });
});
