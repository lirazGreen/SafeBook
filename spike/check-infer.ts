import { readFileSync } from 'node:fs';
import { classify } from '../src/classify/docType.ts';
import { inferIssuer, matchCustomerByName } from '../src/classify/inferIssuer.ts';
import { loadCustomers } from '../src/profiles/loader.ts';

const registry = (await loadCustomers()).map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name }));

for (const slug of ['brightops', 'novafleet', 'acme', 'cloudshield']) {
  const raw = readFileSync(`tests/fixtures/text/${slug}.txt`, 'utf8');
  const docType = classify(raw).docType;
  const inf = inferIssuer(raw, docType);
  const hit = inf.name ? matchCustomerByName(inf.name, registry) : null;
  const ok = hit?.slug === slug;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${slug.padEnd(12)} ${String(docType).padEnd(15)} inferred=${JSON.stringify(inf.name)}`);
  console.log(`         method=${inf.method}  ->  customer=${hit?.slug ?? 'NO MATCH'}`);
  if (inf.candidates.length > 1) {
    console.log(`         all: ${inf.candidates.map((c) => `${c.method}=${JSON.stringify(c.name)}`).join('  ')}`);
  }
}
