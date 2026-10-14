import { readFileSync } from 'node:fs';
import { classify } from '../src/classify/docType.ts';
import { labelValue, labelledBullets } from '../src/extract/strategies/locate.ts';
import { parseNetTerms } from '../src/extract/normalize/netTerms.ts';
import { parseDate } from '../src/extract/normalize/date.ts';
import { parseMoney } from '../src/extract/normalize/money.ts';
import { loadProfiles } from '../src/profiles/loader.ts';

const profiles = await loadProfiles();
const SLUGS = ['brightops', 'novafleet', 'acme', 'cloudshield'] as const;
const OVERRIDE: Record<string, string | null> = { cloudshield: 'cloudshield' };

console.log('Which fields FAIL their deterministic rule, per document:\n');
const grid: Record<string, string[]> = {};

for (const slug of SLUGS) {
  const raw = readFileSync(`tests/fixtures/text/${slug}.txt`, 'utf8');
  const docType = classify(raw).docType!;
  const def = profiles.find(
    (p) => p.customerSlug === (OVERRIDE[slug] ?? null) && p.docType === docType,
  )!.definition;
  const labels = (f: string) => def.fields?.[f]?.labels ?? [];
  const fails: string[] = [];

  const add = (name: string, ok: boolean) => { if (!ok) fails.push(name); };

  const sd = labelValue(raw, labels('start_date'));
  add('start_date', sd !== null && parseDate(sd.text, def.fields?.['start_date']?.input_format) !== null);
  const ed = labelValue(raw, labels('end_date'));
  add('end_date', ed !== null && parseDate(ed.text, def.fields?.['end_date']?.input_format) !== null);
  const am = labelValue(raw, labels('amount'));
  add('amount', am !== null && parseMoney(am.text) !== null);
  const pt = labelValue(raw, labels('payment_terms'));
  add('payment_terms_days', pt !== null && parseNetTerms(pt.text) !== null);
  add('billing_frequency', labelValue(raw, labels('billing_frequency')) !== null);
  const terms = labelledBullets(raw, def.special_terms?.section ?? 'Special Terms', def.special_terms?.type_labels ?? {});
  add('special_terms', terms.length > 0);

  grid[slug] = fails;
  console.log(`  ${slug.padEnd(13)} ${docType.padEnd(16)} ${fails.length === 0 ? 'nothing escalates' : 'escalates: ' + fails.join(', ')}`);
}

const total = Object.values(grid).reduce((t, f) => t + f.length, 0);
console.log(`\n  ${total} escalations across 4 documents -> ${total} fixtures to record`);
console.log(`  documents needing ZERO calls: ${Object.entries(grid).filter(([, f]) => f.length === 0).map(([s]) => s).join(', ')}`);
