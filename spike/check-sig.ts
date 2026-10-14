import { parsePdf } from '../src/pdf/parse.ts';
import { readTwoColumnSignature } from '../src/extract/strategies/twoColumnSignature.ts';

for (const [name, file] of [
  ['ACME', 'ACME Order From.pdf'],
  ['CLOUDSHIELD', 'CloudShield Order Form.pdf'],
  ['BRIGHTOPS (no two-column block)', 'Purchase Order – BrightOps Analytics Ltd.pdf'],
] as const) {
  const { pages } = await parsePdf(`sample docs/${file}`);
  const all = pages.flatMap((p) => p.runs);
  for (const col of ['right', 'left'] as const) {
    const r = readTwoColumnSignature(all, col);
    console.log(
      `  ${name.padEnd(32)} ${col.padEnd(6)} present=${String(r.signaturePresent).padEnd(5)} ` +
      `name=${String(r.signerName).padEnd(12)} title=${String(r.signerTitle).padEnd(26)} date=${String(r.signatureDate).padEnd(12)} x=${r.columnX}`,
    );
  }
}
