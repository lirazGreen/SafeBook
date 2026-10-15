import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CustomerRegistry, ProfileDefinition } from './schema.ts';

export const CONFIG_DIR = 'config';
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');
const BASE = '_base';

export type DocType = 'order_form' | 'purchase_order';

export interface LoadedProfile {
  /** null for the base profile of a doc type. */
  customerSlug: string | null;
  docType: DocType;
  /** The MERGED definition — `extends` already resolved. */
  definition: ProfileDefinition;
  /** sha256 of the merged definition; lets the seeder tell whether it changed. */
  contentHash: string;
}

async function readProfile(path: string): Promise<ProfileDefinition> {
  const raw = await readFile(path, 'utf8');
  const parsed = ProfileDefinition.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Strict schema: an unknown key reports here rather than silently disabling a field.
    throw new Error(`Invalid profile ${path}:\n${issues}`);
  }
  compilePatterns(parsed.data, path);
  return parsed.data;
}

/**
 * Compiles every `pattern` now, so a broken regex fails at SEED time rather than
 * when the first document from that customer arrives — the same rule
 * `customers.yaml` match patterns already follow.
 */
function compilePatterns(def: ProfileDefinition, path: string): void {
  const groups: Record<string, unknown>[] = [
    def.fields ?? {}, def.type_fields ?? {}, def.optional_fields ?? {},
    def.parties?.buyer ?? {}, def.parties?.vendor ?? {},
  ];
  for (const group of groups) {
    for (const [name, spec] of Object.entries(group)) {
      const pattern = (spec as { pattern?: string }).pattern;
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'm');
      } catch (err) {
        throw new Error(`${path}: field "${name}" has an invalid pattern /${pattern}/: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Deep merge, customer over base. OBJECTS merge; ARRAYS REPLACE.
 *
 * Arrays replace deliberately. CloudShield's `amount.labels` is
 * `["Total Subscription Fee"]` and must NOT accumulate the base's
 * `["Total fee", "Total Price", ...]` — otherwise its own
 * "Purchase Order Information / PO Amount: USD 0.00" block could satisfy a
 * base synonym and the wrong total would win.
 */
export function mergeDefinitions(base: ProfileDefinition, delta: ProfileDefinition): ProfileDefinition {
  const merge = (a: unknown, b: unknown): unknown => {
    if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
    if (Array.isArray(a) || a === null || typeof a !== 'object') return b;
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      out[k] = k in out ? merge(out[k], v) : v;
    }
    return out;
  };
  const { extends: _drop, ...rest } = delta;
  return merge(base, rest) as ProfileDefinition;
}

export const hashDefinition = (d: ProfileDefinition): string =>
  createHash('sha256').update(JSON.stringify(d, Object.keys(d).sort())).digest('hex').slice(0, 32);

/**
 * Loads every profile, resolving `extends` at LOAD time so each stored
 * definition is self-contained: `extraction_runs.profile_id` then points at the
 * exact complete rules that ran, with no re-merge needed to interpret it and no
 * second `base_profile_id` on the run.
 */
export async function loadProfiles(configDir = CONFIG_DIR): Promise<LoadedProfile[]> {
  const profilesDir = join(configDir, 'profiles');
  const docTypes = (await readdir(profilesDir)) as DocType[];
  const out: LoadedProfile[] = [];

  for (const docType of docTypes) {
    const dir = join(profilesDir, docType);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml'));

    const baseFile = files.find((f) => f === `${BASE}.yaml`);
    if (baseFile === undefined) throw new Error(`${dir} has no ${BASE}.yaml`);
    const base = await readProfile(join(dir, baseFile));
    out.push({
      customerSlug: null,
      docType,
      definition: base,
      contentHash: hashDefinition(base),
    });

    for (const file of files.filter((f) => f !== baseFile)) {
      const delta = await readProfile(join(dir, file));
      if (delta.extends !== undefined && delta.extends !== BASE) {
        throw new Error(`${join(dir, file)} extends "${delta.extends}"; only "${BASE}" is supported`);
      }
      const merged = mergeDefinitions(base, delta);
      out.push({
        customerSlug: file.replace(/\.yaml$/, ''),
        docType,
        definition: merged,
        contentHash: hashDefinition(merged),
      });
    }
  }
  return out;
}

export async function loadCustomers(configDir = CONFIG_DIR): Promise<CustomerRegistry['customers']> {
  const raw = await readFile(join(configDir, 'customers.yaml'), 'utf8');
  const parsed = CustomerRegistry.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config/customers.yaml:\n${issues}`);
  }
  // Compile every pattern now: a broken regex must fail at seed time, not when
  // the first document from that customer arrives.
  for (const c of parsed.data.customers) {
    for (const m of c.match) {
      try {
        new RegExp(m.pattern);
      } catch (err) {
        throw new Error(`customer "${c.slug}" has an invalid ${m.kind} pattern /${m.pattern}/: ${(err as Error).message}`);
      }
    }
  }
  return parsed.data.customers;
}

export { PROFILES_DIR };
