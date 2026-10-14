const fs = require('fs');
const p = 'src/extract/pipeline.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`    const dateSpec = spec['signature_date'];
    const sigDateRaw = dateSpec ? labelValue(rawText, dateSpec.labels ?? []) : null;`,
`    // through pick(), so an unimplemented strategy returns null here too rather
    // than a plain label lookup finding the WRONG column's date
    const dateSpec = spec['signature_date'];
    const sigDateRaw = pick('signature_date');`);
t = t.replace(
`    const sigSpec = spec['signature_present'];
    const sig = sigSpec ? signatureMarker(rawText, sigSpec.labels ?? []) : null;`,
`    const sigSpec = spec['signature_present'];
    const sig =
      sigSpec === undefined ? null
      : sigSpec.strategy !== undefined && sigSpec.strategy !== 'signature_marker' ? null
      : signatureMarker(rawText, sigSpec.labels ?? []);`);
fs.writeFileSync(p, t);
console.log('patched');
