import { describe, expect, it } from 'vitest';
import { parsePdf } from '../../src/pdf/parse.ts';
import { reconstructTable } from '../../src/pdf/tables.ts';

/**
 * The four sample documents are EXAMPLES, not the universe. These assert the
 * properties that must hold for a customer and a layout the system has never
 * seen: extract what is determinable, surface what is not, never invent.
 */
describe('a document from an unknown customer in an unknown format', () => {
  it('recovers the item table with NO customer-specific configuration at all', async () => {
    // Every option left at its default: no labels, no header_rows, no group_rows,
    // nothing declared. This is what a 5th customer gets on its first document.
    const { pages } = await parsePdf('sample docs/CloudShield Order Form.pdf');
    const region = {
      page: 2,
      runs: (pages.find((p) => p.page === 2)?.runs ?? []).filter((r) => r.y <= 715 && r.y >= 500),
    };
    const r = reconstructTable([region]); // <- zero configuration

    expect(r.rows).toHaveLength(6);
    expect(r.columns).toHaveLength(8);
    const sum = r.rows.reduce((t, row) => t + Number((row.cells[7] ?? '').replace(/[^0-9.]/g, '')), 0);
    expect(sum).toBe(23_640_000); // reconciles, so the parse is provably right
  });

  it('adapts its thresholds to the table rather than to a known customer', async () => {
    // CloudShield: 8 columns, wrapped cells, 6pt line gap.
    // BrightOps:   6 columns, no wrapping, 14.6pt line gap, split over two pages.
    // Both from identical defaults.
    const cs = await parsePdf('sample docs/CloudShield Order Form.pdf');
    const bo = await parsePdf('sample docs/Purchase Order – BrightOps Analytics Ltd.pdf');
    const pick = (p: Awaited<ReturnType<typeof parsePdf>>, page: number, top: number, bot: number) => ({
      page,
      runs: (p.pages.find((x) => x.page === page)?.runs ?? []).filter((r) => r.y <= top && r.y >= bot),
    });

    expect(reconstructTable([pick(cs, 2, 715, 500)]).columns).toHaveLength(8);
    expect(
      reconstructTable([pick(bo, 1, 180, 110), pick(bo, 2, 710, 630)]).columns,
    ).toHaveLength(6);
  });
});
