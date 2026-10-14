/**
 * Makes "tests never call Claude" ENFORCED rather than merely true today.
 *
 * It was already true — unit tests mock the escalator with `vi.fn()`, and the
 * whole suite passes with the network unavailable. But nothing STOPPED it: an
 * exported `LLM_MODE=live` in the shell, or a typo in the documented recording
 * command (`LLM_MODE=record ... npm run accuracy` → `npm test`), would have made
 * `npm test` quietly start billing real calls.
 *
 * So the suite is pinned to `fixture`:
 *
 *   - `live` / `record` are REFUSED, loudly. Silently rewriting them would hide
 *     the misconfiguration; the point is to tell the operator their request
 *     cannot be honoured here.
 *   - anything else (including the `off` default) is pinned to `fixture`, which
 *     is the mode the design specifies for tests and the accuracy harness. Under
 *     `off` the escalator is `null`, so a prose field is flagged FIELD_NOT_FOUND
 *     instead of replaying its recorded response — the accuracy number would
 *     quietly drop once the order forms enter the scored set, with nothing
 *     naming the cause.
 *
 * `fixture` cannot reach the network even in principle: it constructs no
 * Anthropic client at all, and a cache miss raises FixtureMissError.
 */
export class LiveLlmInTestsError extends Error {
  constructor(mode: string) {
    super(
      `LLM_MODE="${mode}" is refused under the test runner: a test must never make a paid API call.\n` +
        `  The suite runs in "fixture" mode, replaying tests/fixtures/llm/.\n` +
        `  To re-record fixtures, run the accuracy harness instead:\n` +
        `    LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy`,
    );
    this.name = 'LiveLlmInTestsError';
  }
}

/** Exported so a test can assert the refusal, rather than trusting the comment. */
export function enforceOfflineLlmMode(vars: { LLM_MODE?: string | undefined }): void {
  const mode = vars.LLM_MODE;
  if (mode === 'live' || mode === 'record') throw new LiveLlmInTestsError(mode);
  vars.LLM_MODE = 'fixture';
}

enforceOfflineLlmMode(process.env);
