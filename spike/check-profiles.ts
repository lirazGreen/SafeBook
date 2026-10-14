import { loadCustomers, loadProfiles } from '../src/profiles/loader.ts';

const cs = await loadCustomers();
console.log('customers:', cs.map((c) => `${c.slug}(${c.match.length})`).join(', '));
const ps = await loadProfiles();
for (const p of ps) {
  console.log(
    (p.customerSlug ?? '(base)').padEnd(13),
    p.docType.padEnd(16),
    p.contentHash.slice(0, 8),
    'fields:', Object.keys(p.definition.fields ?? {}).length,
  );
}
const cloud = ps.find((p) => p.customerSlug === 'cloudshield')!;
console.log('\n--- cloudshield merged ---');
console.log('amount.labels  :', JSON.stringify(cloud.definition.fields?.amount?.labels), '<- REPLACED, not appended');
console.log('payment_terms  :', JSON.stringify(cloud.definition.fields?.payment_terms), '<- inherited');
console.log('items.reconcile:', JSON.stringify(cloud.definition.items?.reconcile), '<- overridden');
console.log('ignore_sections:', JSON.stringify(cloud.definition.ignore_sections));
console.log('extends removed:', !('extends' in cloud.definition));
