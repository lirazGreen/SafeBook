import { describe, expect, it } from 'vitest';
import { formatMmDdYyyy, parseDate } from '../../src/extract/normalize/date.ts';
import { parseMoney, resolveDocumentCurrency } from '../../src/extract/normalize/money.ts';
import { parseNetTerms } from '../../src/extract/normalize/netTerms.ts';

describe('dates — every format in the four documents', () => {
  it.each([
    ['03-01-2025', 'dash_mdy', '2025-03-01'],        // both POs
    ['02-15-2025', 'dash_mdy', '2025-02-15'],
    ['January 1, 2025', 'long_month', '2025-01-01'], // Acme doc fields
    ['December 31, 2026', 'long_month', '2026-12-31'],
    ['June 22, 2023', 'long_month', '2023-06-22'],   // CloudShield prose
    ['Jan 1,2025', 'short_month_compact', '2025-01-01'], // Acme items, no space
    ['Dec 31,2025', 'short_month_compact', '2025-12-31'],
    ['3/1/2025', 'slash_mdy', '2025-03-01'],         // CloudShield
    ['2/28/2028', 'slash_mdy', '2028-02-28'],
  ])('%s as %s', (raw, fmt, iso) => {
    expect(parseDate(raw, fmt as never)?.iso).toBe(iso);
  });

  it('flags M/D vs D/M ambiguity instead of guessing, when no format is declared', () => {
    // 3/1/2025 could be 1 March or 3 January
    expect(parseDate('3/1/2025')).toEqual({ iso: '2025-03-01', ambiguous: true });
    // 2/28/2028 cannot be D/M — 28 is not a month — so it is unambiguous
    expect(parseDate('2/28/2028')).toEqual({ iso: '2028-02-28', ambiguous: false });
    // a declared format is trusted
    expect(parseDate('3/1/2025', 'slash_mdy')?.ambiguous).toBe(false);
  });

  it('rejects impossible and implausible dates rather than rolling them over', () => {
    expect(parseDate('02-30-2025', 'dash_mdy')).toBeNull();
    expect(parseDate('13-01-2025', 'dash_mdy')).toBeNull();
    expect(parseDate('01-01-1900', 'dash_mdy')).toBeNull(); // outside the window
    expect(parseDate('01-01-2099', 'dash_mdy')).toBeNull();
  });

  it('returns null for an unregistered shape — a code change, failing safe', () => {
    expect(parseDate('2025-03-01')).toBeNull();      // ISO input
    expect(parseDate('1 March 2025')).toBeNull();    // D Month Y
  });

  it('renders the brief format only at the boundary', () => {
    expect(formatMmDdYyyy('2025-03-01')).toBe('03-01-2025');
  });
});

describe('money — every format in the four documents', () => {
  it.each([
    ['$162,000 USD', '162000', 'USD'],          // BrightOps total: symbol AND code
    ['$451,000 USD', '451000', 'USD'],          // NovaFleet total
    ['USD 23,640,000.00', '23640000.00', 'USD'], // CloudShield total
    ['USD 7,020,000.00', '7020000.00', 'USD'],
    ['$72,000', '72000', null],                  // BrightOps item: bare $
    ['$50,000', '50000', null],                  // Acme item
    ['22916.67', '22916.67', null],              // CloudShield unit price, no symbol
    ['3.25', '3.25', null],
  ])('%s', (raw, amount, currency) => {
    const m = parseMoney(raw);
    expect(m?.amount).toBe(amount);
    expect(m?.currency).toBe(currency);
  });

  it('keeps NUMERIC precision as a string, never a float', () => {
    // 22916.67 as a JS float is 22916.669999999998
    expect(parseMoney('USD 22,916.67')?.amount).toBe('22916.67');
  });

  it('handles the European decimal comma an unknown customer might use', () => {
    expect(parseMoney('EUR 1.234,56')).toEqual({
      amount: '1234.56', currency: 'EUR', needsCurrencyResolution: false,
    });
    expect(parseMoney('€50.000,00')?.amount).toBe('50000.00');
  });

  it('marks a bare $ as needing document-level resolution', () => {
    expect(parseMoney('$72,000')?.needsCurrencyResolution).toBe(true);
    expect(parseMoney('€72.000')?.needsCurrencyResolution).toBe(false); // € is unambiguous
  });
});

describe('currency resolution — exactly one code, never a geographic guess', () => {
  it("resolves NovaFleet's bare-$ items from its own total, despite a Toronto buyer", () => {
    const text = 'Billing Address: 900 Enterprise Drive, Toronto, ON M5G 2C3, Canada ... $120,000 ... Total PO Amount: $451,000 USD';
    expect(resolveDocumentCurrency(text).currency).toBe('USD'); // not CAD
  });

  it('refuses to infer when two codes are present', () => {
    const r = resolveDocumentCurrency('Item A: USD 100. Item B: EUR 200.');
    expect(r.currency).toBeNull();
    expect(r.codesFound.sort()).toEqual(['EUR', 'USD']);
  });

  it("falls back to the profile default when the document states no code (Acme)", () => {
    expect(resolveDocumentCurrency('Total fee: $152,500', 'USD').currency).toBe('USD');
    expect(resolveDocumentCurrency('Total fee: $152,500').currency).toBeNull();
  });
});

describe('net terms — deterministic only, prose is left to escalate', () => {
  it.each([['Net 30', 30], ['Net 45', 45], ['Payment Terms: Net 30', 30], ['NET-15', 15]])(
    '%s', (raw, days) => expect(parseNetTerms(raw)).toBe(days),
  );

  it('does NOT parse prose — that failure is the escalation signal', () => {
    expect(parseNetTerms('Payment shall be made within thirty (30) days from invoice.')).toBeNull();
    expect(parseNetTerms("within forty-five (45) days of Customer's receipt")).toBeNull();
  });
});

describe('input_formats (plural): a candidate set, not a single declaration', () => {
  it('parses with any listed candidate', () => {
    // Acme's quote dates are long_month; its item dates are short_month_compact.
    // A profile often knows the SET without knowing which applies per field.
    const candidates = ['long_month', 'slash_mdy'] as const;
    expect(parseDate('May 12, 2025', undefined, [...candidates])?.iso).toBe('2025-05-12');
    expect(parseDate('1/20/2025', undefined, [...candidates])?.iso).toBe('2025-01-20');
  });

  it('removes the ambiguity flag, because no listed format reads it two ways', () => {
    expect(parseDate('3/1/2025')?.ambiguous).toBe(true);                       // undeclared
    expect(parseDate('3/1/2025', undefined, ['slash_mdy'])?.ambiguous).toBe(false);
  });

  it('returns null when none of the candidates match', () => {
    expect(parseDate('2025-03-01', undefined, ['long_month', 'dash_mdy'])).toBeNull();
  });
});
