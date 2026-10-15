import { readFileSync } from 'node:fs';

/**
 * Loads `.env` into `process.env` without a dependency.
 *
 * It was needed because `.env` only ever reached the CONTAINERS: docker-compose
 * reads it via `env_file`, but nothing read it for a local run. Nothing imported
 * `dotenv` (it is not even a dependency) and `--env-file` needs Node 20.6+, while
 * the machine this was developed on has 18 — so `npm run migrate` locally failed
 * on the DATABASE_URL guard with a perfectly good URL sitting in `.env`.
 *
 * PRECEDENCE: a variable already present in the environment WINS. That is the
 * important half:
 *
 *   - `LLM_MODE=record npm run accuracy` is not silently overridden by `.env`
 *   - docker-compose's `environment:` block still beats the mounted file
 *   - `tests/setup/offlineLlm.ts` pins LLM_MODE BEFORE this runs, so the
 *     offline guard cannot be undone by a committed `.env`
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes.
 * No variable interpolation and no `export` prefix — anything needing those
 * belongs in real deployment config, not in a 20-line parser.
 */
export function loadDotEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;   // no .env is normal — in Docker, in CI, and in a fresh clone
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;          // already set: leave it alone
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // An empty value is treated as ABSENT, so `ANTHROPIC_API_KEY=` in
    // .env.example does not look like a key that is set to the empty string and
    // trip the live/record guard with a confusing message.
    if (value.length > 0) process.env[key] = value;
  }
}
