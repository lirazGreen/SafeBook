import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env.ts';
import type { Escalator } from '../extract/engine.ts';
import { FixtureMissError, fixtureKey, readFixture, writeFixture } from './fixtures.ts';
import { isEscalatableField, SCHEMAS } from './schemas.ts';
import { SYSTEM_PROMPT } from './prompts/shared.ts';
import { PAYMENT_TERMS_INSTRUCTION } from './prompts/paymentTerms.ts';
import { SPECIAL_TERMS_INSTRUCTION, withSynonyms } from './prompts/specialTerms.ts';
import { issuerInstruction } from './prompts/issuer.ts';

/**
 * Builds the escalator the pipeline reaches when a deterministic rule fails.
 *
 * FIXTURES ARE A TESTING ARTIFACT, NOT A SERVICE PATH. A fixture key hashes the
 * INPUT TEXT, so a genuinely new document can only ever miss — the service runs
 * in `live`, and `fixture` exists so tests and the accuracy harness are offline
 * and reproducible.
 */
export interface BuildEscalatorOptions {
  /** Document text to slice sections from, and to resolve evidence against. */
  rawText: string;
  /** Per-customer wording hints from the profile (Acme never says "TAM"). */
  synonyms?: Record<string, string[]> | undefined;
  docType?: "order_form" | "purchase_order" | null | undefined;
  /** Counts calls actually made, for extraction_runs.llm_calls. */
  onCall?: (() => void) | undefined;
}

function instructionFor(field: string, opts: BuildEscalatorOptions): string {
  switch (field) {
    case 'payment_terms_days': return PAYMENT_TERMS_INSTRUCTION;
    case 'special_terms':
      return opts.synonyms === undefined
        ? SPECIAL_TERMS_INSTRUCTION
        : withSynonyms(SPECIAL_TERMS_INSTRUCTION, opts.synonyms);
    case 'issuer_name': return issuerInstruction(opts.docType ?? null);
    case 'billing_frequency':
      return 'Field: billing_frequency\n\nHow often the customer is invoiced over the term —' +
        ' for example "Annual", "Quarterly", "Monthly". It may be stated as a label or only' +
        ' in prose ("payment will be made annually"). Return the frequency as a single word.' +
        ' Do NOT return a payment period such as "Net 45", nor the subscription term length.';
    default:
      throw new Error(`no prompt for escalatable field "${field}"`);
  }
}

/**
 * Sections are sliced from raw_text rather than sending the whole document: it
 * keeps the prompt focused and the cost down (CloudShield is eight pages, its
 * Special Terms about 1,500 words).
 */
function sliceSections(rawText: string, sections: string[]): string {
  const lines = rawText.split('\n');
  const out: string[] = [];
  for (const section of sections) {
    const needle = section.toLowerCase();
    const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(needle));
    if (start === -1) continue;
    for (let i = start; i < Math.min(lines.length, start + 40); i++) {
      const line = lines[i] as string;
      if (i > start && /^[A-Z][A-Za-z ]{2,30}$/.test(line.trim()) && !line.includes(":")) break;
      out.push(line);
    }
    out.push('');
  }
  return out.join('\n').trim() || rawText.slice(0, 4000);
}

export function buildEscalator(opts: BuildEscalatorOptions): Escalator | null {
  if (env.LLM_MODE === 'off') return null;

  const client =
    env.LLM_MODE === 'fixture'
      ? null
      : new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });

  return async (field, sections) => {
    if (!isEscalatableField(field)) return null;
    const instruction = instructionFor(field, opts);
    const input = sliceSections(opts.rawText, sections);
    const key = fixtureKey(field, env.LLM_MODEL, instruction, input);

    const cached = await readFixture(key);
    if (cached !== null) {
      // Validated rather than trusted. The LIVE path is schema-checked inside the
      // SDK call, but a fixture is JSON off disk — a hand-edited or stale one used
      // to flow straight into the pipeline. A malformed fixture is a hard error for
      // the same reason a missing one is: silence here would be indistinguishable
      // from a model that answered.
      const parsed = SCHEMAS[field].safeParse(cached.response);
      if (!parsed.success) {
        throw new Error(
          `LLM fixture ${key} for field "${field}" does not match its schema:\n` +
            parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") +
            `\n  Re-record with: LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy`,
        );
      }
      return parsed.data;
    }
    if (env.LLM_MODE === 'fixture') throw new FixtureMissError(key, field, input);

    opts.onCall?.();
    const response = await (client as Anthropic).messages.parse({
      model: env.LLM_MODEL,
      max_tokens: 4096,
      // The system prompt is identical for every call and every customer, so it
      // sits behind a cache_control breakpoint; the volatile excerpt goes last.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${instruction}\n\n---\n\n${input}` }],
      output_config: {
        format: zodOutputFormat(SCHEMAS[field] as never),
        // Extraction from a page of text is not a reasoning-heavy task; the
        // special-terms classification is the one that benefits from more.
        effort: field === 'special_terms' ? 'high' : 'medium',
      },
      // NOTE: no `temperature`. It is REMOVED on this model family and returns
      // a 400. Determinism for tests comes from the fixture cache instead.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as never);

    // A refusal arrives as HTTP 200 with stop_reason 'refusal', so stop_reason
    // must be checked BEFORE reading content.
    if ((response as { stop_reason?: string }).stop_reason === 'refusal') return null;
    const parsed = (response as { parsed_output?: unknown }).parsed_output;
    if (parsed === null || parsed === undefined) return null;

    if (env.LLM_MODE === 'record') {
      await writeFixture(key, {
        request: { field, model: env.LLM_MODEL, instruction_sha: key, input },
        response: parsed,
      });
    }
    return parsed;
  };
}
