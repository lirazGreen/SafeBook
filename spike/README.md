# Phase 0 spike — table reconstruction verification

Throwaway code, kept as the record of how the table algorithm in
`docs/DESIGN.md` was verified. Not part of the service; phase 2 reimplements
this properly in `src/pdf/tables.ts`.

```bash
node spike/dump.mjs      "<pdf>" <page>                        # positioned runs, y desc
node spike/tables.mjs    "<pdf>" <page> <yTop> <yBot>          # reconstruct a region
node spike/header.mjs    "<pdf>" <page> <yTop> <yBot> <cols>   # assemble a header
node spike/reconcile.mjs                                       # all four, Σ vs stated total
```

## Result

All 19 item rows recovered across the four documents, and every one reconciles:

```
PASS  ACME Order From                                5 rows  Σ=152,500      stated=152,500
PASS  CloudShield Order Form                         6 rows  Σ=23,640,000   stated=23,640,000
PASS  Purchase Order – BrightOps Analytics Ltd       4 rows  Σ=162,000      stated=162,000
PASS  Purchase Order – NovaFleet Technologies Inc    4 rows  Σ=451,000      stated=451,000
```

## What it corrected

The pre-spike algorithm was wrong in four places — see "What phase 0 corrected"
in `docs/DESIGN.md`. Briefly: wrapped product names **bracket** the data line
rather than preceding it; there are **no group rows** (`Year 1` is a sparse
column cell that carries down); the row band must come from the **median line
gap** rather than the row pitch, which is not uniform; and column positions must
be discovered from **data rows only**, since header fragments are offset from
their columns.

It also found that **both POs' tables span a page break**, with the header on
the first page only — a case the design had not considered at all.

## Note

`pdfjs-dist@4.10` prints `process.getBuiltinModule is not a function` warnings
on Node 18. Harmless for text extraction, and they disappear on the Node 22 the
project targets (see `docs/DEPENDENCIES.md`).

## Inspection tools kept from later phases

Beyond the phase-0 table verification, these were useful enough to keep:

```bash
npx tsx spike/check-pipeline.ts "<file.pdf>"   # full extraction for one document
npx tsx spike/escalations.ts                   # which fields fail their rule, per document
npx tsx spike/audit-profiles.ts                # compare the two base profiles section by section
npx tsx spike/check-items.ts                   # item column mapping
npx tsx spike/check-resolve.ts                 # classification + issuer resolution
npx tsx spike/check-infer.ts                   # generic issuer inference
```

`audit-profiles.ts` earns its place: it found that the order-form base profile declared no
`parties` and no `type_fields`, which would have silently produced no buyer, vendor, address,
signature or quote number on both order forms.
