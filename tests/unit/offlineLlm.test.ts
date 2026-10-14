import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enforceOfflineLlmMode, LiveLlmInTestsError } from '../setup/offlineLlm.ts';

/**
 * "Tests never call Claude" was already TRUE — unit tests mock the escalator and
 * the suite passes with the network unavailable — but it was a convention, not a
 * rule. These assertions make it a rule.
 *
 * Mocks and fixtures are deliberately kept for different jobs: a `vi.fn()` mock
 * proves the PLUMBING (a hallucinated quote is rejected, a refusal is handled),
 * while the accuracy number must come from a RECORDED response. A mock there
 * would score the pipeline against output I imagined Claude producing — the KPI
 * could read 100% while the real model failed.
 */
describe('offline LLM guard', () => {
  it('refuses the two modes that spend money', () => {
    for (const mode of ['live', 'record']) {
      expect(() => enforceOfflineLlmMode({ LLM_MODE: mode })).toThrow(LiveLlmInTestsError);
    }
  });

  it('names the mode and the command that IS allowed to record', () => {
    // A refusal that doesn't say what to do instead just gets worked around.
    try {
      enforceOfflineLlmMode({ LLM_MODE: 'record' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('LLM_MODE="record"');
      expect(msg).toContain('npm run accuracy');
    }
  });

  it('pins every other mode to fixture, including the `off` default', () => {
    // Not merely "allowed": PINNED. Under `off` the escalator is null, so a prose
    // field is flagged FIELD_NOT_FOUND instead of replaying its recorded
    // response — the accuracy number would quietly drop once the order forms are
    // scored, with nothing naming the cause.
    for (const mode of ['off', 'fixture', undefined]) {
      const vars: { LLM_MODE?: string | undefined } = { LLM_MODE: mode };
      enforceOfflineLlmMode(vars);
      expect(vars.LLM_MODE).toBe('fixture');
    }
  });

  it('is actually wired into this runner, not just importable', () => {
    // src/config/env.ts reads process.env, so this is the variable that decides
    // whether a live client is ever constructed. Fails if `setupFiles` is
    // dropped from vitest.config.ts.
    expect(process.env.LLM_MODE).toBe('fixture');
  });
});

/**
 * The mode guard cannot see a module that news up its own client, so this is the
 * complementary static check: exactly ONE file is allowed to construct one, and
 * it is the one the mode gates.
 */
describe('only one module can construct an Anthropic client', () => {
  async function tsFilesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await tsFilesUnder(path)));
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
    return out;
  }

  it('and no test file does', async () => {
    const files = [...(await tsFilesUnder('src')), ...(await tsFilesUnder('tests')), ...(await tsFilesUnder('accuracy'))];
    const constructors: string[] = [];
    for (const f of files) {
      if (/new Anthropic\(/.test(await readFile(f, 'utf8'))) constructors.push(f);
    }
    expect(constructors).toEqual(['src/llm/client.ts']);
  });
});
