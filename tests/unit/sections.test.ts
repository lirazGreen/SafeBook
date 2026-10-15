import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findSectionSpan, keepOnlySection, maskSections,
} from '../../src/extract/strategies/sections.ts';
import { labelValue } from '../../src/extract/strategies/locate.ts';
import { DEFAULT_SECTION_HEADINGS } from '../../src/extract/strategies/locate.ts';

const cloudshield = readFileSync('tests/fixtures/text/cloudshield.txt', 'utf8');
const H = DEFAULT_SECTION_HEADINGS;

/**
 * The decoy block, verbatim from the real document:
 *
 *   Purchase Order Information
 *   Is a Purchase Order (PO) required for the purchase or payment …? No
 *   PO Number:
 *   PO Amount: USD 0.00
 *   CloudShield Security, Inc. TechNova Solutions, Inc.    <- the signature block
 */
describe('findSectionSpan', () => {
  it('covers the heading and its key/value lines, and stops before the next block', () => {
    const span = findSectionSpan(cloudshield, 'Purchase Order Information', H)!;
    const text = cloudshield.slice(span.start, span.end);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('PO Amount: USD 0.00');
    // The signature block must NOT be swallowed. It is read geometrically today,
    // so over-masking would be silent — which is exactly why it is asserted.
    expect(text).not.toContain('TechNova Solutions, Inc.');
  });

  it('is null for a heading the document does not have', () => {
    expect(findSectionSpan(cloudshield, 'Vendor Remittance Details', H)).toBeNull();
  });
});

describe('maskSections — ignore_sections', () => {
  const masked = maskSections(cloudshield, ['Purchase Order Information'], H);

  it('PRESERVES OFFSETS, which is what keeps every evidence span verifiable', () => {
    // Splicing the block out instead would shift every later offset and quietly
    // corrupt the trace, so this is the load-bearing property of the whole file.
    expect(masked).toHaveLength(cloudshield.length);
    expect(masked.split('\n')).toHaveLength(cloudshield.split('\n').length);
  });

  it('hides the decoy `PO Amount: USD 0.00` from a document-level lookup', () => {
    // The real risk is the BASE profile's generic synonyms: an unregistered
    // order form with a similar block would otherwise store a zero total.
    expect(labelValue(cloudshield, ['PO Amount'])?.text).toBe('USD 0.00');
    expect(labelValue(masked, ['PO Amount'])).toBeNull();
  });

  it('leaves the rest of the document alone, offsets included', () => {
    const fee = labelValue(masked, ['Total Subscription Fee'])!;
    expect(fee.text).toBe('USD 23,640,000.00');
    // the offsets index the ORIGINAL text, not the masked copy
    expect(cloudshield.slice(fee.start, fee.end)).toBe('USD 23,640,000.00');
  });
});

describe('keepOnlySection — in_section', () => {
  const scoped = keepOnlySection(cloudshield, 'Purchase Order Information', H);

  it('reads the fields that are ABOUT the ignored block', () => {
    // Masking without this would delete the very data the mask protects.
    expect(labelValue(scoped, ['PO Amount'])?.text).toBe('USD 0.00');
    expect(labelValue(scoped, ['Is a Purchase Order (PO) required'])?.text)
      .toMatch(/No$/);
  });

  it('answers nothing from outside that block', () => {
    expect(labelValue(scoped, ['Total Subscription Fee'])).toBeNull();
    expect(labelValue(scoped, ['Quote Number'])).toBeNull();
  });

  it('yields all-blank for a missing heading, so the field is flagged not answered elsewhere', () => {
    const none = keepOnlySection(cloudshield, 'Remittance Information', H);
    expect(none.trim()).toBe('');
    expect(labelValue(none, ['PO Amount'])).toBeNull();
  });
});
