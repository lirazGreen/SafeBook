const fs = require('fs');
const p = 'src/extract/validate.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`    if (!(f in vars)) return null;         // unknown name: cannot evaluate
    const v = vars[f];
    if (v === null || Number.isNaN(v)) return null;`,
`    const v = vars[f];
    // unknown name, or a factor we could not read: cannot evaluate, so skip the
    // check rather than invent a comparison
    if (v === undefined || v === null || Number.isNaN(v)) return null;`);
fs.writeFileSync(p, t);
