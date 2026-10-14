const fs = require('fs');
const p = 'src/extract/pipeline.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`    const pick = (f: string) => {
      const s = spec[f];
      if (s === undefined) return null;
      return s.strategy === 'multiline_after_label'
        ? multilineAfterLabel(rawText, s.labels ?? [], {
            maxLines: s.max_lines ?? 4,
            ...(def.section_headings ? { stopAt: def.section_headings } : {}),
          })
        : labelValue(rawText, s.labels ?? []);
    };`,
`    const pick = (f: string) => {
      const s = spec[f];
      if (s === undefined) return null;
      switch (s.strategy) {
        case 'multiline_after_label':
          return multilineAfterLabel(rawText, s.labels ?? [], {
            maxLines: s.max_lines ?? 4,
            ...(def.section_headings ? { stopAt: def.section_headings } : {}),
          });
        case undefined:
        case 'label_value':
          return labelValue(rawText, s.labels ?? []);
        default:
          // A strategy is DECLARED but not implemented yet. Return null so the
          // field escalates, rather than falling through to a plain label lookup.
          //
          // Falling through was actively harmful: an order form's buyer
          // signer_name is declared with the bare label "Name", which matched
          // the ITEM TABLE HEADER and produced
          // "Start Date End Date Rate Quantity Total amount". Garbage is worse
          // than nothing — "could not tell" and "here is a value" are different
          // answers, and only the first one escalates.
          return null;
      }
    };`);
fs.writeFileSync(p, t);
console.log('patched');
