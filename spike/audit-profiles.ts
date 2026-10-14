import { loadProfiles } from '../src/profiles/loader.ts';
const ps = await loadProfiles();
const of = ps.find((p) => p.customerSlug === null && p.docType === 'order_form')!.definition;
const po = ps.find((p) => p.customerSlug === null && p.docType === 'purchase_order')!.definition;

const keys = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).sort();
const rows: [string, string[], string[]][] = [
  ['fields', keys(of.fields), keys(po.fields)],
  ['parties.buyer', keys(of.parties?.buyer), keys(po.parties?.buyer)],
  ['parties.vendor', keys(of.parties?.vendor), keys(po.parties?.vendor)],
  ['type_fields', keys(of.type_fields), keys(po.type_fields)],
  ['items.column_synonyms', keys(of.items?.column_synonyms), keys(po.items?.column_synonyms)],
  ['special_terms', keys(of.special_terms as never), keys(po.special_terms as never)],
];
for (const [section, a, b] of rows) {
  const missingInOf = b.filter((k) => !a.includes(k));
  const missingInPo = a.filter((k) => !b.includes(k));
  console.log(`\n${section}`);
  console.log(`  order_form     : ${a.join(', ') || '(none)'}`);
  console.log(`  purchase_order : ${b.join(', ') || '(none)'}`);
  if (missingInOf.length) console.log(`  >> MISSING from order_form: ${missingInOf.join(', ')}`);
  if (missingInPo.length) console.log(`  >> only in order_form     : ${missingInPo.join(', ')}`);
}
