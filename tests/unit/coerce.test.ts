import { describe, expect, it } from 'vitest';
import { coerce } from '../../src/extract/normalize/coerce.ts';

describe('coerce — applying a field\'s declared `type`', () => {
  it('pulls the number out of a sentence, which is why the type is declared at all', () => {
    // Verbatim from CloudShield: the label "Subscription Term (months)" is
    // followed by a PARENTHETICAL before the value, so the raw tail of the line
    // is not a number. Until `type` was applied this whole string was stored
    // into a NUMERIC(6,2) column.
    expect(coerce('(unless extended according to the terms of this Order Form): 36.00 months', 'number'))
      .toBe('36.00');
  });

  it('returns a decimal STRING, never a float', () => {
    // 22916.67 becomes 22916.669999999998 as a JS number, and the point of
    // NUMERIC is defeated if anything parses it on the way to the DB.
    expect(coerce('22916.67', 'number')).toBe('22916.67');
    expect(coerce('1,234', 'number')).toBe('1234');
    expect(typeof coerce('12', 'number')).toBe('string');
  });

  it('reads CloudShield\'s PO question as a boolean', () => {
    expect(coerce('for the purchase or payment of the subscriptions on this Order Form? No', 'boolean'))
      .toBe(false);
    expect(coerce('Yes', 'boolean')).toBe(true);
    expect(coerce('✔ Signed', 'boolean')).toBe(true);
  });

  it('returns null for an answer it cannot read, rather than defaulting', () => {
    // A default would be a claim about the contract. null escalates.
    expect(coerce('see Schedule 2', 'boolean')).toBeNull();
    expect(coerce('not stated', 'number')).toBeNull();
  });

  it('leaves text alone with no type, and leaves dates to parseDate', () => {
    expect(coerce('Michael Chen', undefined)).toBe('Michael Chen');
    // the M/D vs D/M ambiguity needs the profile's input_format, so coerce must
    // not resolve it here
    expect(coerce('3/1/2025', 'date')).toBe('3/1/2025');
  });
});
