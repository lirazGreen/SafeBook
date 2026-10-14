import { describe, expect, it } from 'vitest';
import { parsePdf } from '../../src/pdf/parse.ts';
import { carryDown, reconstructTable } from '../../src/pdf/tables.ts';
import type { PageRegion, TextRun } from '../../src/pdf/types.ts';

const SAMPLES = 'sample docs';
const slice = (pages: PageRegion[], page: number, yTop: number, yBot: number): PageRegion => ({
  page,
  runs: (pages.find((p) => p.page === page)?.runs ?? []).filter((r) => r.y <= yTop && r.y >= yBot),
});
const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

describe('real documents: every table reconciles against its stated total', () => {
  it.each([
    ['ACME Order From.pdf', 152_500, 5, [[2, 662, 525]]],
    ['CloudShield Order Form.pdf', 23_640_000, 6, [[2, 715, 500]]],
    ['Purchase Order – BrightOps Analytics Ltd.pdf', 162_000, 4, [[1, 180, 110], [2, 710, 630]]],
    ['Purchase Order – NovaFleet Technologies Inc.pdf', 451_000, 4, [[1, 175, 85], [2, 710, 655]]],
  ])('%s', async (file, stated, rowCount, regions) => {
    const { pages } = await parsePdf(`${SAMPLES}/${file}`);
    const result = reconstructTable(
      (regions as number[][]).map(([p, top, bot]) => slice(pages, p!, top!, bot!)),
    );
    expect(result.rows).toHaveLength(rowCount as number);
    expect(result.orphans).toHaveLength(0);
    const sum = result.rows.reduce((t, r) => t + money(r.cells[r.cells.length - 1] ?? ''), 0);
    expect(sum).toBe(stated);
  });

  it('joins a product name whose fragments BRACKET the data line (CloudShield)', async () => {
    const { pages } = await parsePdf(`${SAMPLES}/CloudShield Order Form.pdf`);
    const r = reconstructTable([slice(pages, 2, 715, 500)]);
    // y=667 "CloudShield" / y=661 <data> / y=655 "Enterprise"
    expect(r.rows[0]!.cells[1]).toBe('CloudShield Enterprise');
    expect(r.header).toEqual([
      'Subscription Year', 'Subscriptions', 'Start Date', 'End Date',
      'Order Term (Months)', 'Monthly / Unit Price **',
      'Quantity of Billable Units***', 'Total Price',
    ]);
  });

  it('carries a sparse column down (subscription_year), reporting what it inferred', async () => {
    const { pages } = await parsePdf(`${SAMPLES}/CloudShield Order Form.pdf`);
    const r = reconstructTable([slice(pages, 2, 715, 500)]);
    expect(r.rows.map((x) => x.cells[0])).toEqual(['Year 1', '', 'Year 2', '', 'Year 3', '']);
    const inherited = carryDown(r.rows, [0]);
    expect(r.rows.map((x) => x.cells[0]))
      .toEqual(['Year 1', 'Year 1', 'Year 2', 'Year 2', 'Year 3', 'Year 3']);
    // rows 1,3,5 inherited column 0; rows 0,2,4 read it off the page
    expect([...inherited.keys()].sort()).toEqual([1, 3, 5]);
  });

  it('stitches a table across a page break (BrightOps: 1 row + 3 rows)', async () => {
    const { pages } = await parsePdf(`${SAMPLES}/Purchase Order – BrightOps Analytics Ltd.pdf`);
    const r = reconstructTable([slice(pages, 1, 180, 110), slice(pages, 2, 710, 630)]);
    expect(r.rows.map((x) => x.page)).toEqual([1, 2, 2, 2]);
    // the header exists only on page 1 and still applies to the continuation
    expect(r.header?.[0]).toBe('Product Name');
    expect(r.rows[0]!.cells[0]).toBe('Analytics Platform – Enterprise');
  });
});

describe('unfamiliar layouts: a new customer in a format we have never seen', () => {
  const run = (x: number, y: number, text: string): TextRun =>
    ({ x, y, w: text.length * 5, h: 10, text });

  it('handles a THREE-column table, which a fixed ">= 4 columns" rule would miss entirely', () => {
    const runs = [
      run(70, 300, 'Item'), run(250, 300, 'Qty'), run(400, 300, 'Cost'),       // header
      run(70, 270, 'Widget'), run(250, 270, '4'), run(400, 270, '1.234,56'),
      run(70, 240, 'Gadget'), run(250, 240, '2'), run(400, 240, '99,00'),
    ];
    const r = reconstructTable([{ page: 1, runs }]);
    expect(r.columns).toHaveLength(3);
    expect(r.header).toEqual(['Item', 'Qty', 'Cost']);
    expect(r.rows.map((x) => x.cells)).toEqual([
      ['Widget', '4', '1.234,56'],
      ['Gadget', '2', '99,00'],
    ]);
  });

  it('handles a wrapped cell in an unfamiliar layout', () => {
    const runs = [
      run(70, 300, 'Description'), run(300, 300, 'Amount'),
      run(70, 260, 'Annual platform'), run(300, 260, 'EUR 50.000,00'),
      run(70, 248, 'licence fee'),   // continuation only
    ];
    const r = reconstructTable([{ page: 1, runs }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.cells[0]).toBe('Annual platform licence fee');
    expect(r.rows[0]!.cells[1]).toBe('EUR 50.000,00');
  });

  it('reports orphans rather than silently dropping runs it cannot place', () => {
    const runs = [
      run(70, 300, 'Item'), run(250, 300, 'Qty'), run(400, 300, 'Cost'),
      run(70, 270, 'Widget'), run(250, 270, '4'), run(400, 270, '10'),
      run(70, 100, 'FOOTNOTE far below the table'),
    ];
    const r = reconstructTable([{ page: 1, runs }]);
    expect(r.rows).toHaveLength(1);
    expect(r.orphans.map((o) => o.text)).toEqual(['FOOTNOTE far below the table']);
  });

  it('returns nothing rather than guessing when there is no table at all', () => {
    const runs = [run(70, 300, 'Dear Sir or Madam,'), run(70, 280, 'Please find enclosed.')];
    const r = reconstructTable([{ page: 1, runs }]);
    expect(r.rows).toHaveLength(0);
  });

  it('column gap is overridable for a dense layout', () => {
    const runs = [
      run(70, 300, 'A'), run(80, 300, 'B'),           // only 10pt apart
      run(70, 280, '1'), run(80, 280, '2'),
    ];
    expect(reconstructTable([{ page: 1, runs }]).columns).toHaveLength(1); // default 18pt merges them
    expect(reconstructTable([{ page: 1, runs }], { columnGapPt: 5 }).columns).toHaveLength(2);
  });
});
