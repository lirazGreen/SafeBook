import { buildEscalator } from '../src/llm/client.ts';
const e = buildEscalator({ rawText: 'x' });
console.log(e === null ? 'escalator: null (deterministic-only)' : 'escalator: wired');
