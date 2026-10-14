import { loadProfiles } from '../src/profiles/loader.ts';
const p = (await loadProfiles()).find((x) => x.customerSlug === 'cloudshield')!;
console.log(JSON.stringify(p.definition.items, null, 2));
