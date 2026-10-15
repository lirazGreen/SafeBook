import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  labelValue, labelledBullets, multilineAfterLabel, patternValue, signatureMarker,
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

describe('occurrence — one label reused for two different things', () => {
  // CloudShield writes BOTH of these, with the same label:
  //   Customer Billing Name: TechNova Solutions, Inc.   <- the organisation
  //   Customer Billing Name: Sarah Thompson             <- the billing contact
  const cloudshield = readFileSync('tests/fixtures/text/cloudshield.txt', 'utf8');

  it('defaults to the first', () => {
    expect(labelValue(cloudshield, ['Customer Billing Name'])?.text)
      .toBe('TechNova Solutions, Inc.');
  });

  it('takes the declared occurrence', () => {
    expect(labelValue(cloudshield, ['Customer Billing Name'], { occurrence: 2 })?.text)
      .toBe('Sarah Thompson');
  });

  it('counts PER LABEL, so a synonym list does not shift the index', () => {
    // buyer.name lists its exact wording first; that label matching zero times
    // must not make the next label's first match look like its second.
    expect(labelValue(cloudshield, ['Customer Billing Company Name', 'Customer Billing Name'])?.text)
      .toBe('TechNova Solutions, Inc.');
  });

  it('returns null when the occurrence does not exist', () => {
    expect(labelValue(cloudshield, ['Customer Billing Name'], { occurrence: 9 })).toBeNull();
  });
});

describe('patternValue — the one-off shapes no label covers', () => {
  const cloudshield = readFileSync('tests/fixtures/text/cloudshield.txt', 'utf8');

  it('captures a bare unlabelled line', () => {
    // "Azure Private Offer" sits near the top with nothing labelling it.
    const found = patternValue(cloudshield, '^((?:Azure|AWS|GCP)[A-Za-z ]*(?:Private Offer|Marketplace))$')!;
    expect(found.text).toBe('Azure Private Offer');
    expect(cloudshield.slice(found.start, found.end)).toBe('Azure Private Offer');
  });

  it('collapses whitespace in a value that straddles a line break, keeping offsets on the original', () => {
    // The vendor address is wrapped mid-value: "San Jose," / newline / "CA 95134".
    const found = patternValue(
      cloudshield, 'principal place of business at ([^,]+,\\s*[^,]+,\\s*[A-Z]{2}\\s*\\d{5})')!;
    expect(found.text).toBe('500 Innovation Drive, San Jose, CA 95134');
    expect(cloudshield.slice(found.start, found.end)).toContain('\n');
  });

  it('is null rather than throwing when nothing matches', () => {
    expect(patternValue(cloudshield, 'Remittance ABA: (\\d+)')).toBeNull();
  });
});
