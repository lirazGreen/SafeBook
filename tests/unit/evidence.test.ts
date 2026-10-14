import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidenceResolver, valueAppearsIn } from '../../src/llm/evidence.ts';

const acme = readFileSync('tests/fixtures/text/acme.txt', 'utf8');
const cloudshield = readFileSync('tests/fixtures/text/cloudshield.txt', 'utf8');

describe('evidence resolution against the real sample documents', () => {
  it('matches a quote the model returns on one line, where the PDF wraps it', () => {
    // Acme lays this out as "Payment shall be\nmade within thirty (30) days..."
    const quote = 'Payment shall be made within thirty (30) days from invoice.';
    expect(acme.includes(quote)).toBe(false); // a naive indexOf would reject it

    const ev = evidenceResolver(acme).resolve(quote);
    expect(ev).not.toBeNull();
    // the STORED text is the document's real characters, newline included
    expect(ev!.text).toContain('\n');
    expect(acme.slice(ev!.start, ev!.end)).toBe(ev!.text);
  });

  it('matches across curly quotes when the model returns ASCII ones', () => {
    // Acme writes (the "Burst Threshold") with U+201C/U+201D
    const ev = evidenceResolver(acme).resolve('(the "Burst Threshold"), at no additional cost.');
    expect(ev).not.toBeNull();
    expect(ev!.text).toMatch(/[“”]/); // original kept its curly quotes
  });

  it('rejects a quote that is not in the document (hallucinated citation)', () => {
    const ev = evidenceResolver(acme).resolve('Payment shall be made within ninety (90) days.');
    expect(ev).toBeNull();
  });

  it('rejects an ambiguous quote rather than guessing which occurrence', () => {
    // "Premium Support" appears on four separate CloudShield line items
    expect(evidenceResolver(cloudshield).resolve('Premium Support')).toBeNull();
  });

  it('resolves CloudShield payment terms', () => {
    const ev = evidenceResolver(cloudshield).resolve(
      "Payment will be made within forty-five (45) days of Customer's receipt of an invoice.",
    );
    expect(ev).not.toBeNull();
    expect(cloudshield.slice(ev!.start, ev!.end)).toBe(ev!.text);
  });
});

describe('value must appear in its own quote', () => {
  it.each([
    [30, 'Payment shall be made within thirty (30) days from invoice.'],
    [45, "within forty-five (45) days of Customer's receipt of an invoice"],
    [5, 'the right to utilize up to 5% more Billable Units'],
    [38.89, '(a) during Year 1, up to 38.89%'],
    [10, 'exceed licensed analytics usage by up to 10% per contract year'],
    [15, 'Up to 15% additional monitored workloads allowed annually'],
    [280000, 'the Burst Threshold exceed 280,000 Billable Units'],
  ])('accepts %s', (value, quote) => {
    expect(valueAppearsIn(quote, value as number)).toBe(true);
  });

  it('rejects Net 30 claimed from the forty-five-day clause', () => {
    expect(valueAppearsIn("within forty-five (45) days of Customer's receipt", 30)).toBe(false);
  });
});
