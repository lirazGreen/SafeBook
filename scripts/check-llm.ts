import { env } from '../src/config/env.ts';
import { listFixtures } from '../src/llm/fixtures.ts';

/**
 * Reports whether Claude is reachable, and what will happen when a
 * deterministic rule fails — without ever printing the key.
 *
 * Exists because the alternative is `echo $ANTHROPIC_API_KEY`, which puts a live
 * credential in your shell history and your terminal scrollback. Length and a
 * short prefix are enough to tell "set correctly" from "set to an empty string"
 * or "pasted with a trailing newline", which are the mistakes that actually
 * happen.
 */
const key = env.ANTHROPIC_API_KEY;
const fixtures = await listFixtures();

console.log(`LLM_MODE   ${env.LLM_MODE}`);
console.log(`model      ${env.LLM_MODEL}`);
console.log(
  `api key    ${
    key === undefined
      ? 'not set'
      : `set — ${key.length} chars, starts "${key.slice(0, 10)}…"${
          key.trim().length !== key.length ? '  ⚠️  HAS SURROUNDING WHITESPACE' : ''
        }`
  }`,
);
console.log(`fixtures   ${fixtures.length} recorded in tests/fixtures/llm/`);
console.log('');

switch (env.LLM_MODE) {
  case 'off':
    console.log('A failed deterministic rule is flagged FIELD_NOT_FOUND and the document');
    console.log('still persists. No calls, no key needed — the documented degradation.');
    console.log('');
    // Two different goals, and conflating them is easy: the earlier wording
    // suggested only `live`, which reads as "you must change this first" even
    // when the user is about to run accuracy:record — where the npm script sets
    // the mode inline and .env is irrelevant.
    console.log('This affects the RUNNING SERVICE only. To have it answer prose fields,');
    console.log('set LLM_MODE=live in .env and restart the worker.');
    console.log('');
    console.log('A ONE-OFF recording needs no change here — the npm script sets the mode');
    console.log('itself, and an explicit value beats .env:');
    console.log('    npm run accuracy:record');
    break;
  case 'fixture':
    console.log('Escalations REPLAY a recorded response. A miss is a hard error, never a');
    console.log('live call — which is what keeps npm test and npm run accuracy offline.');
    break;
  case 'live':
    console.log(`Escalations CALL the API and are BILLED (~3-6 cents each).`);
    console.log('Nothing is written to tests/fixtures/llm/ — use LLM_MODE=record for that.');
    break;
  case 'record':
    console.log('Escalations CALL the API, are BILLED, and each response is SAVED to');
    console.log('tests/fixtures/llm/ so tests can replay it offline afterwards.');
    break;
}

if ((env.LLM_MODE === 'live' || env.LLM_MODE === 'record') && key === undefined) {
  // env.ts already refuses to start in this state; this is the friendlier report.
  console.log('');
  console.log('⚠️  This mode needs ANTHROPIC_API_KEY and it is not set.');
  process.exitCode = 1;
}
