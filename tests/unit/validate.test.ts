import { describe, expect, it } from 'vitest';
import { dateEnvelope, validate } from '../../src/extract/validate.ts';
import type { ItemRecord } from '../../src/extract/items.ts';

const item = (o: Partial<ItemRecord>): ItemRecord => ({
  lineNo: 1, productName: 'x', quantity: '1', unitPrice: '100', totalAmount: '100',
  currency: 'USD', itemStartDate: null, itemEndDate: null, attributes: {}, fieldSources: {}, ...o,
});

describe('reconciliation', () => {
  it('passes when items sum to the stated total', () => {
    const r = validate({
      amount: '162000', currency: 'USD', startDate: null, endDate: null,
      items: [item({ totalAmount: '72000' }), item({ lineNo: 2, totalAmount: '78000' }),
              item({ lineNo: 3, totalAmount: '6000' }), item({ lineNo: 4, totalAmount: '6000' })],
    });
    expect(r.reasons).not.toContain('TOTAL_MISMATCH');
  });

  it('flags a mismatch but still reports everything else', () => {
    const r = validate({
      amount: '999', currency: 'USD', startDate: null, endDate: null,
      items: [item({ totalAmount: '100' })],
    });
    expect(r.reasons).toContain('TOTAL_MISMATCH');
    expect(r.notes.join(' ')).toMatch(/items sum to 100 but the document states 999/);
  });

  it('skips the sum entirely when currencies are mixed — it would be meaningless', () => {
    const r = validate({
      amount: '300', currency: 'USD', startDate: null, endDate: null,
      items: [item({ totalAmount: '100', currency: 'USD' }), item({ lineNo: 2, totalAmount: '200', currency: 'EUR' })],
    });
    expect(r.reasons).toContain('MIXED_CURRENCY');
    expect(r.reasons).not.toContain('TOTAL_MISMATCH');
  });
});

describe("per-item arithmetic uses the profile's own formula", () => {
  it('accepts the simple form for a PO', () => {
    const r = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'quantity * unit_price',
      items: [item({ quantity: '3', unitPrice: '18000', totalAmount: '54000' })],
    });
    expect(r.reasons).not.toContain('ITEM_ARITHMETIC');
  });

  it("accepts CloudShield's monthly pricing via order_term_months", () => {
    const r = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'quantity * unit_price * order_term_months',
      items: [item({ quantity: '180000', unitPrice: '3.25', totalAmount: '7020000.00',
                     attributes: { order_term_months: '12.00' } })],
    });
    expect(r.reasons).not.toContain('ITEM_ARITHMETIC');
  });

  it('absorbs the documented 2dp rounding via tolerance_pct', () => {
    // 22916.67 x 12 = 275000.04 against a stated 275000.00
    const strict = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'quantity * unit_price * order_term_months',
      items: [item({ quantity: '1', unitPrice: '22916.67', totalAmount: '275000.00',
                     attributes: { order_term_months: '12.00' } })],
    });
    expect(strict.reasons).toContain('ITEM_ARITHMETIC'); // without tolerance it fails
    const tolerant = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'quantity * unit_price * order_term_months', tolerancePct: 0.5,
      items: [item({ quantity: '1', unitPrice: '22916.67', totalAmount: '275000.00',
                     attributes: { order_term_months: '12.00' } })],
    });
    expect(tolerant.reasons).not.toContain('ITEM_ARITHMETIC');
  });

  it('skips rather than guessing when a factor is missing', () => {
    const r = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'quantity * unit_price * order_term_months',
      items: [item({ attributes: {} })], // no order_term_months
    });
    expect(r.reasons).not.toContain('ITEM_ARITHMETIC');
  });

  it('does not evaluate arbitrary expressions from config', () => {
    const r = validate({
      amount: null, currency: 'USD', startDate: null, endDate: null,
      reconcile: 'process.exit(1)',
      items: [item({})],
    });
    expect(r.reasons).not.toContain('ITEM_ARITHMETIC'); // unknown name -> skipped, not executed
  });
});

describe('value checks warn, never block', () => {
  it('allows a negative credit amount but flags it', () => {
    const r = validate({ amount: '-412583.67', currency: 'USD', startDate: null, endDate: null, items: [] });
    expect(r.reasons).toContain('NEGATIVE_AMOUNT');
  });
  it('allows quantity 0 with no flag, flags negative', () => {
    expect(validate({ amount: null, currency: null, startDate: null, endDate: null, items: [item({ quantity: '0' })] }).reasons)
      .not.toContain('NEGATIVE_QUANTITY');
    expect(validate({ amount: null, currency: null, startDate: null, endDate: null, items: [item({ quantity: '-5' })] }).reasons)
      .toContain('NEGATIVE_QUANTITY');
  });
});

describe('dates', () => {
  const items = [
    item({ itemStartDate: '2025-03-01', itemEndDate: '2026-02-28' }),
    item({ lineNo: 2, itemStartDate: '2026-03-01', itemEndDate: '2027-02-28' }),
  ];
  it('accepts an envelope matching the stated dates (exact on all four samples)', () => {
    const r = validate({ amount: null, currency: null, startDate: '2025-03-01', endDate: '2027-02-28', items });
    expect(r.reasons).not.toContain('DATE_ENVELOPE_MISMATCH');
  });
  it('flags a mismatch between the envelope and the stated dates', () => {
    const r = validate({ amount: null, currency: null, startDate: '2025-03-01', endDate: '2099-01-01', items });
    expect(r.reasons).toContain('DATE_ENVELOPE_MISMATCH');
  });
  it('flags a reversed range', () => {
    expect(validate({ amount: null, currency: null, startDate: '2026-01-01', endDate: '2025-01-01', items: [] }).reasons)
      .toContain('DATE_RANGE_REVERSED');
  });
  it('derives the envelope for use when the document states no dates', () => {
    expect(dateEnvelope(items)).toEqual({ start: '2025-03-01', end: '2027-02-28' });
  });
});
