const fs = require('fs');
const p = 'src/extract/engine.ts';
let t = fs.readFileSync(p, 'utf8');

const find = "  'buyer_signature_present', 'vendor_signature_present',\n]);";
const repl = [
  "  'buyer_signature_present', 'vendor_signature_present',",
  '  // "Who issued this?" escalates too, when all three deterministic methods',
  '  // fail (PO title, PO buyer label, signature-line subtraction). Safe because',
  '  // the answer is matched against a CLOSED SET of registered customers: an',
  '  // invented or unrecognised name degrades to unmatched + the base profile,',
  '  // never to a WRONG profile. The dangerous failure is naming the counterparty',
  '  // instead, so the prompt states the role and the result is cross-checked.',
  "  'issuer_name',",
  ']);',
  '',
  '/**',
  ' * Rejects an escalated issuer name that is really the counterparty.',
  ' *',
  ' * On a PO the issuer is the buyer; naming the vendor would route the document to',
  " * the wrong customer's profile if that vendor happened to be registered. This is",
  ' * the one issuer failure mode the closed-set lookup does NOT catch, because a',
  ' * counterparty name is a real organisation that may well be registered.',
  ' */',
  'export function issuerIsNotCounterparty(',
  '  issuerName: string,',
  '  counterpartyName: string | null,',
  '  normalise: (s: string) => string,',
  '): boolean {',
  '  if (counterpartyName === null) return true;',
  '  const a = normalise(issuerName);',
  '  const b = normalise(counterpartyName);',
  '  if (a.length === 0 || b.length === 0) return true;',
  '  return !(a === b || a.startsWith(b) || b.startsWith(a));',
  '}',
].join('\n');

if (!t.includes(find)) { console.error('anchor missing'); process.exit(1); }
fs.writeFileSync(p, t.replace(find, repl));
console.log('patched');
