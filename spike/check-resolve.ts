import { readFileSync } from 'node:fs';
import { loadCustomers } from '../src/profiles/loader.ts';
import { resolveIssuer, type CustomerPattern } from '../src/classify/issuer.ts';
import { classify } from '../src/classify/docType.ts';

const customers = await loadCustomers();
const patterns: CustomerPattern[] = customers.flatMap((c, i) =>
  c.match.map((m) => ({ customerId: i + 1, slug: c.slug, kind: m.kind, pattern: m.pattern })),
);

for (const slug of ['acme', 'cloudshield', 'brightops', 'novafleet']) {
  const raw = readFileSync(`tests/fixtures/text/${slug}.txt`, 'utf8');
  const cls = classify(raw);
  const iss = resolveIssuer(raw, patterns);
  const ok = iss.slug === slug;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${slug.padEnd(12)} type=${String(cls.docType).padEnd(15)} conf=${cls.confidence}  issuer=${String(iss.slug).padEnd(12)} ${iss.resolution}`,
  );
  console.log(`         scores of=${cls.scores.order_form} po=${cls.scores.purchase_order}  [${cls.matched[cls.docType!].join(' ')}]`);
}
