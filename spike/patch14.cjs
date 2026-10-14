const fs = require('fs');
const p = 'config/profiles/order_form/_base.yaml';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(
`    signature_present:
      labels: ["Buyer Signature", "Customer Signature"]
      strategy: two_column_signature
      buyer_column: right`,
`    signature_present:
      labels: ["Buyer Signature", "Customer Signature"]
      strategy: two_column_signature
      buyer_column: right
    # "Name:", "Title:" and "Date:" each appear TWICE — once per column — so a
    # plain label lookup would always return the vendor's (leftmost) signer.
    signer_name:    { labels: ["Name"],  strategy: two_column_signature, buyer_column: right }
    signer_title:   { labels: ["Title"], strategy: two_column_signature, buyer_column: right }
    signature_date: { labels: ["Date"],  strategy: two_column_signature, buyer_column: right,
                      input_formats: [dash_mdy, long_month] }`);
fs.writeFileSync(p, t);
console.log('signer fields added');
