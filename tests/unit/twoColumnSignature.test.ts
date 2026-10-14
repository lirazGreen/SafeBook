import { describe, expect, it } from 'vitest';
import { readTwoColumnSignature } from '../../src/extract/strategies/twoColumnSignature.ts';
import { parsePdf } from '../../src/pdf/parse.ts';

const runsOf = async (file: string) =>
  (await parsePdf(`sample docs/${file}`)).pages.flatMap((p) => p.runs);

/**
 * ONE capability, not two. An earlier plan had `two_column_signature` for Acme
 * and a separate `placeholder_lines` for CloudShield. The blocks are
 * structurally identical — same two columns, vendor left, buyer right — and the
 * only difference is whether the chosen column holds a value or underscores.
 */
describe('two-column signature blocks', () => {
  it('reads the BUYER (right) column on Acme', async () => {
    const r = readTwoColumnSignature(await runsOf('ACME Order From.pdf'), 'right');
    expect(r).toMatchObject({
      signaturePresent: true, signerName: 'Bob Lee', signerTitle: 'CEO', signatureDate: '01-02-2025',
    });
  });

  it('reads the VENDOR (left) column on the same document', async () => {
    const r = readTwoColumnSignature(await runsOf('ACME Order From.pdf'), 'left');
    expect(r).toMatchObject({
      signaturePresent: true, signerName: 'John Smith', signerTitle: 'CFO', signatureDate: '12-13-2024',
    });
  });

  it('only the x-coordinate separates them — the TEXT is identical', async () => {
    const { rawText } = await parsePdf('sample docs/ACME Order From.pdf');
    // "Name:" appears twice with nothing in the text to distinguish the columns
    expect((rawText.match(/^Name:/gm) ?? []).length).toBe(2);
    const left = readTwoColumnSignature(await runsOf('ACME Order From.pdf'), 'left');
    const right = readTwoColumnSignature(await runsOf('ACME Order From.pdf'), 'right');
    expect(left.columnX).toBeLessThan(right.columnX!);
  });

  it('returns FALSE for CloudShield, whose block is all unfilled placeholders', async () => {
    // This is the case the separate `placeholder_lines` strategy was planned for
    const r = readTwoColumnSignature(await runsOf('CloudShield Order Form.pdf'), 'right');
    expect(r.signaturePresent).toBe(false);
    expect(r.signerName).toBeNull();
    expect(r.columnX).not.toBeNull(); // the block WAS found
  });

  it('distinguishes "not signed" from "no block found"', async () => {
    // CloudShield: block found, nothing filled      -> false
    // BrightOps:   no two-column block at all       -> null, which escalates
    const cs = readTwoColumnSignature(await runsOf('CloudShield Order Form.pdf'), 'right');
    const po = readTwoColumnSignature(await runsOf('Purchase Order – BrightOps Analytics Ltd.pdf'), 'right');
    expect(cs.signaturePresent).toBe(false);
    expect(po.signaturePresent).toBeNull();
  });

  it('discovers the column positions from the document, not from constants', async () => {
    // Acme's columns are at x=77/311, CloudShield's at x=96/312
    const acme = readTwoColumnSignature(await runsOf('ACME Order From.pdf'), 'left');
    const cloud = readTwoColumnSignature(await runsOf('CloudShield Order Form.pdf'), 'left');
    expect(Math.round(acme.columnX!)).toBe(77);
    expect(Math.round(cloud.columnX!)).toBe(96);
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(readTwoColumnSignature([])).toMatchObject({ signaturePresent: null, columnX: null });
  });
});
