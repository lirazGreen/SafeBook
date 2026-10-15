import { scoreAll, totals } from './runner.ts';

/**
 * Scores extraction against hand-read ground truth and prints a number.
 *
 * It exists at phase 3 rather than at the end because it is a TOOL, not a
 * deliverable — every later change is measured instead of guessed at.
 *
 * Three buckets, not two. A declared escalation with no recorded fixture is
 * **pending**, not a miss: `LLM_MODE=off` is the documented behaviour with no API
 * key, and counting it as a parser failure would blame the extractor for an
 * absent key. But it is not a pass either — the KPI is withheld entirely while
 * anything is pending, because a ">=95%" claim computed over only the fields that
 * did not need a model is a claim about a smaller problem than the brief set.
 */
async function main() {
  const scored = await scoreAll();

  for (const { expected, result, comparisons, fixtureMiss } of scored) {
    const pass = comparisons.filter((c) => c.verdict === 'pass').length;
    const pending = comparisons.filter((c) => c.verdict === 'pending');
    const fail = comparisons.filter((c) => c.verdict === 'fail');
    const pct = ((pass / comparisons.length) * 100).toFixed(1);

    console.log(`\n${expected.file}`);
    console.log(
      `  ${pass}/${comparisons.length} (${pct}%)` +
        `  escalated: ${result.escalations.length === 0 ? 'none' : result.escalations.join(',')}` +
        `  api calls: ${result.llmCalls}` +
        `  review: ${result.reviewReasons.join(',') || '(none)'}`,
    );
    for (const c of fail) {
      console.log(`  ✗ ${c.field}`);
      console.log(`      expected ${JSON.stringify(c.expected)}`);
      console.log(`      got      ${JSON.stringify(c.actual)}`);
    }
    for (const c of pending) console.log(`  … ${c.field}  (declared as escalating; awaiting a fixture)`);
    if (fixtureMiss !== undefined) {
      console.log(
        `  ! no fixture for "${fixtureMiss.field}" (key ${fixtureMiss.key}) —` +
          ' re-scored deterministically',
      );
    }
  }

  const t = totals(scored);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${t.passed} / ${t.total} scored values  =  ${t.pct.toFixed(1)}%`);
  if (t.failed > 0) console.log(`  ${t.failed} WRONG`);
  if (t.pending > 0) {
    console.log(`  ${t.pending} pending — fields that must escalate, with no fixture recorded yet`);
    console.log('');
    console.log('  KPI is >=95%: NOT YET MEASURABLE.');
    console.log('  Record the fixtures once, with a key, then this number is final:');
    console.log('      LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy');
    console.log('  Reporting a PASS over only the deterministic fields would be a claim');
    console.log('  about a smaller problem than the brief set.');
  } else {
    const allowed = Math.floor(t.total * 0.05);
    console.log(
      `  KPI is >=95%: ${t.pct >= 95 ? 'PASS' : 'FAIL'}` +
        `  (allows ${allowed} wrong, ${t.total - t.passed} wrong)`,
    );
  }
  console.log('='.repeat(70));

  // Only a real failure breaks the exit code. Pending is a state of the repo
  // (no key yet), not a defect in the extractor.
  if (t.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
