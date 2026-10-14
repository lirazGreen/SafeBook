const fs = require('fs');

// order_form base was missing the item date columns that the PO base has
let b = fs.readFileSync('config/profiles/order_form/_base.yaml', 'utf8');
b = b.replace(
`  column_synonyms:
    product_name: ["Name", "Product Name", "Subscriptions", "Description"]
    quantity:     ["Quantity", "Quantity of Billable Units"]
    unit_price:   ["Rate", "Unit Price", "Monthly / Unit Price"]
    total_amount: ["Total amount", "Total Price"]`,
`  column_synonyms:
    product_name: ["Name", "Product Name", "Subscriptions", "Description"]
    item_start_date: ["Start Date"]
    item_end_date: ["End Date"]
    quantity:     ["Quantity", "Quantity of Billable Units"]
    unit_price:   ["Rate", "Unit Price", "Monthly / Unit Price"]
    total_amount: ["Total amount", "Total Price", "Total Amount"]`);
fs.writeFileSync('config/profiles/order_form/_base.yaml', b);

// CloudShield's item dates are slash_mdy; without declaring it, parseDate would
// flag "3/1/2025" as M/D-vs-D/M ambiguous rather than trusting it
let c = fs.readFileSync('config/profiles/order_form/cloudshield.yaml', 'utf8');
c = c.replace(
`  carry_down: [subscription_year]      # sparse column: blank rows inherit from above`,
`  carry_down: [subscription_year]      # sparse column: blank rows inherit from above
  date_format: slash_mdy               # "3/1/2025" — declared, so not flagged ambiguous`);
fs.writeFileSync('config/profiles/order_form/cloudshield.yaml', c);
console.log('profiles patched');
