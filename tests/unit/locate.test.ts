import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  labelValue, labelledBullets, multilineAfterLabel, signatureMarker,
} from '../../src/extract/strategies/locate.ts';

const brightops = readFileSync('tests/fixtures/text/brightops.txt', 'utf8');
const novafleet = readFileSync('tests/fixtures/text/novafleet.txt', 'utf8');
const acme = readFileSync('tests/fixtures/text/acme.txt', 'utf8');

/**
 * Every located value must slice back out of raw_text at its own offsets.
 * The stored VALUE joins lines with ", " for readability; the EVIDENCE keeps the
 * document's original characters, newlines included — the same split as dates,
 * where a DATE is stored but "03-01-2025" is the evidence.
 */
const tracesBack = (raw: string, l: { text: string; start: number; end: number } | null) =>
  l !== null && raw.slice(l.start, l.end).trim().replace(/\s*\n\s*/g, ', ') === l.text;

describe('labelValue on the real PO text', () => {
  it.each([
    [['Purchase Order Number'], 'PO-BO-10458'],
    [['PO Date'], '02-15-2025'],
    [['Vendor Name'], 'DataPulse Software Inc.'],
    [['Company Name'], 'BrightOps Analytics Ltd.'],
    [['Contract Start Date'], '03-01-2025'],   // bullet-prefixed
    [['Contract End Date'], '02-28-2027'],
    [['Billing Frequency'], 'Annual'],
    [['Payment Terms'], 'Net 30'],
    [['Total PO Amount'], '$162,000 USD'],
  ])('%s', (labels, expected) => {
    const found = labelValue(brightops, labels as string[]);
    expect(found?.text).toBe(expected);
    expect(tracesBack(brightops, found)).toBe(true);
  });

  it('tries labels in order, so a customer override wins over a base synonym', () => {
    expect(labelValue(brightops, ['Nonexistent', 'Payment Terms'])?.text).toBe('Net 30');
  });

  it('requires the label to START the line, so it cannot match mid-sentence', () => {
    expect(labelValue('see the Payment Terms: elsewhere', ['Payment Terms'])).toBeNull();
  });

  it('returns null when the value is on the following line, leaving it to multiline', () => {
    expect(labelValue(brightops, ['Billing Address'])).toBeNull();
  });
});

describe('multilineAfterLabel — addresses spanning lines', () => {
  it('reads BrightOps two-line addresses', () => {
    const vendor = multilineAfterLabel(brightops, ['Vendor Address']);
    expect(vendor?.text).toBe('789 Market Street, San Francisco, CA 94103, USA');
    expect(tracesBack(brightops, vendor)).toBe(true);

    const buyer = multilineAfterLabel(brightops, ['Billing Address']);
    expect(buyer?.text).toBe('42 King George Street, London, UK');
  });

  it('reads NovaFleet three-line address', () => {
    expect(multilineAfterLabel(novafleet, ['Billing Address'])?.text)
      .toBe('900 Enterprise Drive, Toronto, ON M5G 2C3, Canada');
  });

  it('stops at the next labelled line rather than swallowing the document', () => {
    const v = multilineAfterLabel(brightops, ['Vendor Address']);
    expect(v?.text).not.toContain('Buyer');
    expect(v?.text).not.toContain('Company Name');
  });
});

describe('signatureMarker', () => {
  it('reads the POs executed signature', () => {
    for (const raw of [brightops, novafleet]) {
      expect(signatureMarker(raw, ['Buyer Signature'])?.value).toBe(true);
    }
  });

  it('reads an unsigned placeholder as false', () => {
    expect(signatureMarker('Buyer Signature: ______', ['Buyer Signature'])?.value).toBe(false);
  });

  it('returns null when no marker exists, so it escalates rather than defaulting', () => {
    // Acme has no "Buyer Signature:" label at all — it uses a two-column block
    expect(signatureMarker(acme, ['Buyer Signature'])).toBeNull();
  });
});

describe('labelledBullets — special terms on a PO', () => {
  const TYPE_LABELS = {
    burst: ['Burst (Item Level)', 'Burst'],
    technical_account_manager: ['Technical Account Manager'],
  };

  it('extracts both BrightOps terms with their continuation lines', () => {
    const terms = labelledBullets(brightops, 'Special Terms', TYPE_LABELS);
    expect(terms.map((t) => t.termType)).toEqual(['burst', 'technical_account_manager']);
    expect(terms[0]!.text).toBe(
      'Buyer may exceed licensed analytics usage by up to 10% per contract year at no additional cost.',
    );
    expect(terms[1]!.text).toBe(
      'A dedicated Technical Account Manager will be assigned for the duration of the contract.',
    );
    expect(terms.map((t) => t.ordinal)).toEqual([1, 2]);
  });

  it('extracts both NovaFleet terms', () => {
    const terms = labelledBullets(novafleet, 'Special Terms', TYPE_LABELS);
    expect(terms.map((t) => t.termType)).toEqual(['burst', 'technical_account_manager']);
    expect(terms[0]!.text).toContain('Up to 15% additional monitored workloads');
  });

  it('stops at the next section heading', () => {
    const terms = labelledBullets(brightops, 'Special Terms', TYPE_LABELS);
    expect(terms.map((t) => t.text).join(' ')).not.toContain('Emily Carter');
  });

  it('returns [] on an order form — numbered prose with no labels — which escalates', () => {
    expect(labelledBullets(acme, 'Special Terms', TYPE_LABELS)).toEqual([]);
  });
});
