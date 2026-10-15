import { column, makePdf, row, type TextLine } from './makePdf.ts';

/**
 * Synthetic documents from customers the system has never seen.
 *
 * Structured to mirror the REAL samples' conventions — the labels and section
 * headings a base profile looks for — because that is the claim under test: an
 * unregistered customer following the usual shape of a PO or an order form is
 * extracted from the base profile alone, with no configuration.
 *
 * Deliberately NOT copies of the four samples with names changed. Different
 * companies, different money, different dates, different products, different
 * column order where the synonyms allow it — otherwise a test would pass by
 * reproducing values that are hard-coded in the expectations elsewhere.
 */
const PO_ITEM_X: [number, number, number, number, number] = [60, 230, 320, 410, 480];

/** A purchase order from an unregistered customer, in the conventional shape. */
export function newCustomerPurchaseOrder(): Buffer {
  const items: [string, string, string, string, string][] = [
    ['Fleet Telemetry Suite', '04-01-2025', '03-31-2026', '$96,000', '$96,000'],
    ['Fleet Telemetry Suite', '04-01-2026', '03-31-2027', '$104,000', '$104,000'],
    ['Onboarding Services', '04-01-2025', '03-31-2026', '$20,000', '$20,000'],
  ];
  return makePdf([
    [
      ...column(730, [
        'Purchase Order – Northwind Logistics Ltd.',
        'Purchase Order Number: PO-NW-44120',
        'PO Date: 03-18-2025',
        'Vendor',
        'Vendor Name: Helios Telematics GmbH',
        'Vendor Address:',
        '17 Hafenstrasse',
        'Hamburg, 20457, Germany',
        'Buyer',
        'Company Name: Northwind Logistics Ltd.',
        'Billing Address:',
        '8 Dock Road',
        'Liverpool, L3 4AA, UK',
        'Order Summary',
        'Contract Start Date: 04-01-2025',
        'Contract End Date: 03-31-2027',
        'Billing Frequency: Annual',
        'Payment Terms: Net 60',
        'Line Items',
      ]),
      ...row(430, [
        [PO_ITEM_X[0], 'Product Name'], [PO_ITEM_X[1], 'Start Date'],
        [PO_ITEM_X[2], 'End Date'], [PO_ITEM_X[3], 'Unit Price'], [PO_ITEM_X[4], 'Total Amount'],
      ]),
      ...items.flatMap((cells, i) =>
        row(410 - i * 20, cells.map((c, j) => [PO_ITEM_X[j] as number, c] as [number, string])),
      ),
      ...column(330, [
        'Total PO Amount: $220,000 USD',
        'Special Terms',
        '● Burst (Item Level): Buyer may exceed licensed vehicle count by up to 12% per',
        'contract year at no additional cost.',
        '● Technical Account Manager: Vendor will assign a Technical Account Manager for',
        'the duration of the contract.',
        'Authorization',
        'Buyer Signature: ✔ Signed',
        'Name: Priya Raman',
        'Title: Head of Operations',
        'Date: 03-18-2025',
      ]),
    ],
  ]);
}

/**
 * An order form from an unregistered customer.
 *
 * Note the two-column signature block built from x coordinates, and payment
 * terms stated only in PROSE — the two things that distinguish an order form
 * from a PO in this system, and the reason one escalates and the other does not.
 */
export function newCustomerOrderForm(): Buffer {
  const ITEM_X: [number, number, number, number, number, number] = [60, 200, 290, 380, 450, 510];
  const items: [string, string, string, string, string, string][] = [
    ['Observability Platform', 'Apr 1,2025', 'Mar 31,2026', '$80,000', '1', '$80,000'],
    ['Observability Platform', 'Apr 1,2026', 'Mar 31,2027', '$88,000', '1', '$88,000'],
    ['Premium Support', 'Apr 1,2025', 'Mar 31,2027', '$400', '30', '$12,000'],
  ];
  return makePdf([
    [
      ...column(740, [
        'Quote Number: Q-ZN-5513',
        'Quote Date: March 3, 2025',
        'Quote Expiration Date: April 15, 2025',
        'To: Harbourline Freight Inc.',
        'Order Form',
        'Customer Information',
        'Customer Billing Company Name: Harbourline Freight Inc.',
        'Bill To: 220 Quay Street, Auckland, New Zealand',
        'Start Date: April 1, 2025',
        'End Date: March 31, 2027',
        'Terms and Conditions',
        'Billing Frequency: Annual',
        'Payment Terms: Fees are invoiced annually in advance. Payment shall be made',
        'within sixty (60) days of the invoice date.',
        'Order Details',
      ]),
      ...row(520, [
        [ITEM_X[0], 'Name'], [ITEM_X[1], 'Start Date'], [ITEM_X[2], 'End Date'],
        [ITEM_X[3], 'Rate'], [ITEM_X[4], 'Quantity'], [ITEM_X[5], 'Total amount'],
      ]),
      ...items.flatMap((cells, i) =>
        row(500 - i * 20, cells.map((c, j) => [ITEM_X[j] as number, c] as [number, string])),
      ),
      ...column(420, [
        'Total fee: $180,000',
        'Special Terms',
        '1. During each consecutive 12 months of the Subscription Term, Customer may',
        'utilize up to 8% more Billable Units than listed above at no additional cost.',
        '2. Customer will be assigned a Technical Account Manager.',
      ]),
      // the two-column signature block: vendor LEFT, buyer RIGHT, same baselines
      { x: 60, y: 320, text: 'Zenith Cloud Inc.' },
      { x: 330, y: 320, text: 'Harbourline Freight Inc.' },
      ...([
        ['Signature:', 'Signature:'],
        ['Name: Dana Okafor', 'Name: Tom Whitaker'],
        ['Title: CFO', 'Title: COO'],
        ['Date: 03-03-2025', 'Date: 03-20-2025'],
      ] as const).flatMap(([left, right], i): TextLine[] => [
        { x: 60, y: 300 - i * 16, text: left },
        { x: 330, y: 300 - i * 16, text: right },
      ]),
    ],
  ]);
}

/** A PO whose items deliberately do NOT sum to the stated total. */
export function purchaseOrderWithBadTotal(): Buffer {
  return makePdf([
    [
      ...column(730, [
        'Purchase Order – Northwind Logistics Ltd.',
        'Purchase Order Number: PO-NW-44121',
        'PO Date: 03-18-2025',
        'Buyer',
        'Company Name: Northwind Logistics Ltd.',
        'Order Summary',
        'Contract Start Date: 04-01-2025',
        'Contract End Date: 03-31-2026',
        'Payment Terms: Net 30',
        'Line Items',
      ]),
      ...row(560, [[60, 'Product Name'], [230, 'Start Date'], [320, 'End Date'], [410, 'Unit Price'], [480, 'Total Amount']]),
      ...row(540, [[60, 'Widget Service'], [230, '04-01-2025'], [320, '03-31-2026'], [410, '$10,000'], [480, '$10,000']]),
      ...column(500, ['Total PO Amount: $99,999 USD']),   // <- not 10,000
    ],
  ]);
}

/** A PO with a bare `$` and no ISO code anywhere, and no profile to default from. */
export function purchaseOrderAmbiguousCurrency(): Buffer {
  return makePdf([
    [
      ...column(730, [
        'Purchase Order – Northwind Logistics Ltd.',
        'Purchase Order Number: PO-NW-44122',
        'PO Date: 03-18-2025',
        'Buyer',
        'Company Name: Northwind Logistics Ltd.',
        'Order Summary',
        'Contract Start Date: 04-01-2025',
        'Contract End Date: 03-31-2026',
        'Payment Terms: Net 30',
        'Line Items',
      ]),
      ...row(560, [[60, 'Product Name'], [230, 'Start Date'], [320, 'End Date'], [410, 'Unit Price'], [480, 'Total Amount']]),
      ...row(540, [[60, 'Widget Service'], [230, '04-01-2025'], [320, '03-31-2026'], [410, '$10,000'], [480, '$10,000']]),
      ...column(500, ['Total PO Amount: $10,000']),       // no "USD" anywhere
    ],
  ]);
}

/** A PO with a column header no synonym covers. */
export function purchaseOrderUnknownColumn(): Buffer {
  return makePdf([
    [
      ...column(730, [
        'Purchase Order – Northwind Logistics Ltd.',
        'Purchase Order Number: PO-NW-44123',
        'PO Date: 03-18-2025',
        'Buyer',
        'Company Name: Northwind Logistics Ltd.',
        'Order Summary',
        'Contract Start Date: 04-01-2025',
        'Contract End Date: 03-31-2026',
        'Payment Terms: Net 30',
        'Line Items',
      ]),
      ...row(560, [
        [60, 'Product Name'], [200, 'Start Date'], [290, 'End Date'],
        [380, 'Unit Price'], [450, 'Total Amount'], [520, 'Cost Centre'],
      ]),
      ...row(540, [
        [60, 'Widget Service'], [200, '04-01-2025'], [290, '03-31-2026'],
        [380, '$10,000'], [450, '$10,000'], [520, 'CC-7781'],
      ]),
      ...column(500, ['Total PO Amount: $10,000 USD']),
    ],
  ]);
}

/** Neither an order form nor a purchase order. */
export function unclassifiableDocument(): Buffer {
  return makePdf([
    column(730, [
      'Mutual Non-Disclosure Agreement',
      'This Agreement is entered into between the parties named below.',
      'Effective Date: 05-01-2025',
      'Each party agrees to hold the other\'s Confidential Information in confidence',
      'for a period of three years from the Effective Date.',
      'Signed for and on behalf of both parties.',
    ]),
  ]);
}

/** A PDF with no text at all — the image-only-scan stand-in. */
export function pdfWithNoText(): Buffer {
  return makePdf([[]]);
}
