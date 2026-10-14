const fs = require('fs');
const p = 'config/profiles/order_form/_base.yaml';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const i = lines.findIndex((l) => /^\s+product_name:/.test(l));
if (i === -1) { console.error('product_name line not found'); process.exit(1); }
if (lines.some((l) => /item_start_date:/.test(l))) { console.log('already present'); process.exit(0); }
lines.splice(i + 1, 0,
  '    item_start_date: ["Start Date"]',
  '    item_end_date: ["End Date"]');
fs.writeFileSync(p, lines.join('\n'));
console.log('inserted after line', i + 1);
