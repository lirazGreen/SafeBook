import { parsePdf } from '../src/pdf/parse.ts';
import { runExtraction } from '../src/extract/pipeline.ts';
import { loadCustomers, loadProfiles } from '../src/profiles/loader.ts';
import type { CustomerPattern } from '../src/classify/issuer.ts';

const customersYaml = await loadCustomers();
const customers = customersYaml.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));
const patterns: CustomerPattern[] = customersYaml.flatMap((c, i) =>
  c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })));
const profiles = await loadProfiles();
const slugById = new Map(customers.map((c) => [c.id, c.slug]));

const resolveProfile = async (customerId: number | null, docType: string) => {
  const slug = customerId === null ? null : slugById.get(customerId) ?? null;
  const p = profiles.find((x) => x.customerSlug === slug && x.docType === docType);
  return p ? { profileId: 0, definition: p.definition } : null;
};

const file = process.argv[2] ?? 'Purchase Order – BrightOps Analytics Ltd.pdf';
const parsed = await parsePdf(`sample docs/${file}`);
const r = await runExtraction({ parsed, customers, patterns, resolveProfile: resolveProfile as never, escalate: null });

console.log(`### ${file}`);
console.log(`doc_type   : ${r.docType} (conf ${r.docTypeConfidence}, ${r.docTypeSource})`);
console.log(`customer   : id=${r.customerId} ${r.customerResolution}  issuer="${r.detectedIssuerName}"`);
console.log(`dates      : ${r.startDate} -> ${r.endDate}`);
console.log(`amount     : ${r.amount} ${r.currency}`);
console.log(`terms      : ${r.paymentTermsDays} days   frequency: ${r.billingFrequency}`);
for (const p of r.parties) {
  console.log(`${p.role.padEnd(10)} : ${p.name} | ${p.address} | sig=${p.signaturePresent} ${p.signerName ?? ''} ${p.signerTitle ?? ''} ${p.signatureDate ?? ''}`);
}
console.log(`type       : ${JSON.stringify(r.typeDetails)}`);
console.log(`items (${r.items.length}):`);
for (const i of r.items) console.log(`   ${i.lineNo}. ${String(i.productName).padEnd(32)} ${i.itemStartDate}->${i.itemEndDate} qty=${i.quantity} unit=${i.unitPrice} total=${i.totalAmount}`);
console.log(`           SUM = ${r.items.reduce((t, i) => t + Number(i.totalAmount ?? 0), 0).toLocaleString()}`);
console.log(`special    : ${r.specialTerms.map((s) => `${s.termType}${s.percent ? `(${s.percent}%)` : ''}`).join(', ')}`);
console.log(`review     : ${r.reviewReasons.length ? r.reviewReasons.join(', ') : '(none)'}`);
if (r.reviewNotes.length) r.reviewNotes.forEach((n) => console.log(`             ${n}`));
console.log(`llm calls  : ${r.llmCalls}`);
