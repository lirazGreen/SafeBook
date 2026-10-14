import { describe, expect, it } from 'vitest';
import { mapItems } from '../../src/extract/items.ts';
import { parsePdf } from '../../src/pdf/parse.ts';
import { reconstructTable } from '../../src/pdf/tables.ts';
import { loadProfiles } from '../../src/profiles/loader.ts';

const profiles = await loadProfiles();
const defFor = (slug: string | null, docType: string) =>
  profiles.find((p) => p.customerSlug === slug && p.docType === docType)!.definition;

async function extract(file: string, regions: number[][], def: ReturnType<typeof defFor>) {
  const { pages } = await parsePdf(`sample docs/${file}`);
  const table = reconstructTable(
    regions.map(([p, top, bot]) => ({
      page: p!,
      runs: (pages.find((x) => x.page === p)?.runs ?? []).filter((r) => r.y <= top! && r.y >= bot!),
    })),
  );
  return mapItems(table, {
    columnSynonyms: def.items?.column_synonyms,
    optionalColumns: def.items?.optional_columns,
    carryDownFields: def.items?.carry_down,
    dateFormat: def.items?.date_format,
    documentCurrency: 'USD',
  });
}

describe('item mapping via profile column synonyms', () => {
  it('maps both POs from the BASE profile — neither needs a customer override', async () => {
    const base = defFor(null, 'purchase_order');
    for (const [file, total] of [
      ['Purchase Order – BrightOps Analytics Ltd.pdf', 162_000],
      ['Purchase Order – NovaFleet Technologies Inc.pdf', 451_000],
    ] as const) {
      const regions = file.includes('BrightOps') ? [[1, 180, 110], [2, 710, 630]] : [[1, 175, 85], [2, 710, 655]];
      const r = await extract(file, regions, base);
      expect(r.unmappedHeaders, file).toEqual([]);
      expect(Object.keys(r.columnMap).sort()).toEqual([
        'item_end_date', 'item_start_date', 'product_name', 'quantity', 'total_amount', 'unit_price',
      ]);
      expect(r.items.reduce((t, i) => t + Number(i.totalAmount), 0), file).toBe(total);
      expect(r.items.every((i) => i.productName !== null && i.itemStartDate !== null)).toBe(true);
    }
  });

  it("takes the LONGEST synonym match, so overlapping lists do not mis-assign", async () => {
    const r = await extract('CloudShield Order Form.pdf', [[2, 715, 500]], defFor('cloudshield', 'order_form'));
    // "Monthly / Unit Price **" must be unit_price, not total_amount via "Amount";
    // "Total Price" must be total_amount, not unit_price via "Price"
    expect(r.columnMap['unit_price']).toBe(5);
    expect(r.columnMap['total_amount']).toBe(7);
    expect(r.items[0]!.unitPrice).toBe('3.25');
    expect(r.items[0]!.totalAmount).toBe('7020000.00');
  });

  it('captures optional columns into attributes and marks carried-down values', async () => {
    const r = await extract('CloudShield Order Form.pdf', [[2, 715, 500]], defFor('cloudshield', 'order_form'));
    expect(r.items[0]!.attributes).toEqual({ subscription_year: 'Year 1', order_term_months: '12.00' });
    // the Premium Support rows leave Subscription Year blank and inherit it
    expect(r.items[0]!.fieldSources).toEqual({});
    expect(r.items[1]!.attributes['subscription_year']).toBe('Year 1');
    expect(r.items[1]!.fieldSources).toEqual({ subscription_year: 'inherited' });
    expect(r.items.filter((i) => 'subscription_year' in i.fieldSources)).toHaveLength(3);
  });

  it('keeps money as exact decimal strings, never floats', async () => {
    const r = await extract('CloudShield Order Form.pdf', [[2, 715, 500]], defFor('cloudshield', 'order_form'));
    expect(r.items[1]!.unitPrice).toBe('22916.67');  // not 22916.669999999998
    expect(r.items.reduce((t, i) => t + Number(i.totalAmount), 0)).toBe(23_640_000);
  });

  it('reports unmapped headers rather than silently dropping a column', () => {
    const r = mapItems(
      { columns: [0, 1], header: ['Thing', 'Mystery Column'], rows: [{ y: 1, page: 1, cells: ['a', 'b'] }], orphans: [] },
      { columnSynonyms: { product_name: ['Thing'] } },
    );
    expect(r.unmappedHeaders).toEqual(['Mystery Column']);
  });
});

describe('dead profile keys are rejected, not silently ignored', () => {
  it('refuses header_rows and wrapped_cells', async () => {
    const { ProfileDefinition } = await import('../../src/profiles/schema.ts');
    // Both were declared early and never read: the reconstruction finds the
    // header block and joins wrapped cells from the geometry. A no-op knob reads
    // as working, so the schema rejects it.
    expect(ProfileDefinition.safeParse({ items: { header_rows: 2 } }).success).toBe(false);
    expect(ProfileDefinition.safeParse({ items: { wrapped_cells: true } }).success).toBe(false);
    // the geometry overrides that ARE applied remain accepted
    expect(ProfileDefinition.safeParse({ items: { column_gap_pt: 5 } }).success).toBe(true);
  });
});
