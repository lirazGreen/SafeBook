# SafeBook — Document Data Extraction

Watches a folder for contract PDFs, works out **what each document is and who issued it from the
content alone**, and extracts a fixed field set using customised definitions per customer and
document type.

Built against four sample documents — two Order Forms (Acme, CloudShield) and two Purchase
Orders (BrightOps, NovaFleet) — but the samples are *examples, not the universe*: an
unregistered customer in an unseen layout is extracted with the base profile and flagged for
review, never dropped.

---

## Run it

Needs Docker and Node 22 (`.nvmrc`).

```bash
docker compose up -d                       # postgres + api + worker
docker compose exec api node --import=tsx src/db/migrate.ts
docker compose exec api node --import=tsx src/profiles/seed.ts

cp "sample docs/"*.pdf inbox/              # that's it — the worker polls
```

Within a few seconds all four documents are extracted, with no further input:

```
id  customer     docType         status        amount        items
 1  acme         order_form      needs_review    152,500.00      5
 2  cloudshield  order_form      needs_review 23,640,000.00      6
 3  brightops    purchase_order  extracted       162,000.00      4
 4  novafleet    purchase_order  extracted       451,000.00      4
```

The two order forms sit at `needs_review` because their payment terms are stated only in prose
and no API key is configured — the deterministic rule failed, the field escalated, and nothing
answered. That is the documented graceful degradation, not a bug: every other field on both
documents is extracted and correct.

```bash
docker compose logs -f worker               # structured JSON, never document text
curl -s localhost:3000/documents | jq
curl -s localhost:3000/documents/3/trace | jq   # where each value came from
open localhost:3000/docs                    # Swagger UI — upload a PDF from the browser
```

Or sweep immediately instead of waiting for the timer. Real output, called twice right after
the copy:

```bash
$ curl -s -X POST 'localhost:3000/scan?wait=30000'
{"status":"done","jobId":7,"found":4,"enqueued":0,"unstable":4,"duplicate":0,"rejected":0}
$ curl -s -X POST 'localhost:3000/scan?wait=30000'
{"status":"done","jobId":14,"found":4,"enqueued":0,"unstable":0,"duplicate":4,"rejected":0}
```

`unstable: 4` on the first call is the **write-stability gate** working, not a problem: the files
were copied moments ago, so their size and mtime have no previous tick to be compared against and
they are held back rather than read mid-copy. By the second call the polling timer has already
ingested them, so they come back as `duplicate` — content-addressed, so a re-dropped file costs
nothing.

### Letting it answer the prose fields

Out of the box `LLM_MODE=off`: a field whose deterministic rule fails is flagged
`FIELD_NOT_FOUND` and the document still persists. No key needed, nothing fails. To let the
service answer those fields instead, put a key in `.env` and switch the mode:

```bash
# .env   — gitignored, so it cannot reach the repo
ANTHROPIC_API_KEY=sk-ant-api03-...
LLM_MODE=live
```

```bash
docker compose restart worker       # or just rerun npm run worker
npm run check:llm                   # confirm it is wired, without printing the key
```

```
LLM_MODE   live
model      claude-opus-5
api key    set — 108 chars, starts "sk-ant-api…"
fixtures   0 recorded in tests/fixtures/llm/

Escalations CALL the API and are BILLED (~3-6 cents each).
```

`npm run check:llm` reports length and a ten-character prefix rather than the value, because the
obvious alternative — `echo $ANTHROPIC_API_KEY` — puts a live credential in your shell history
and your terminal scrollback. Length and prefix are enough to distinguish "set correctly" from
the mistakes that actually happen: set to an empty string, or pasted with a trailing newline. It
flags surrounding whitespace explicitly.

**Keys cannot be read back from Anthropic.** [console.anthropic.com](https://console.anthropic.com)
→ Settings → API keys shows the value **once**, at creation; afterwards you can only revoke and
create another. Note also that a Claude.ai subscription does **not** include API credits — they
are separate balances on the same account, and a subscription with no API credit returns a 400
that looks like a broken key but isn't.

`docker compose` passes `.env` through via `env_file`, so the containers pick the key up with no
further configuration. Locally, `src/config/dotenv.ts` loads the file, and a variable already
present in the environment **wins** — so `LLM_MODE=record npm run accuracy` is not silently
overridden by `.env`.

### Without Docker

Two things run with **no database and no API key**, which is deliberate — it is what makes the
accuracy number reproducible from a fresh clone:

```bash
npm install
npm run accuracy    # scores the real pipeline against hand-read ground truth
npm test            # 292 tests; the 39 that need Postgres skip themselves, with a reason
```

---

## Accuracy

```
  239 / 239 scored values  =  100.0%
  KPI is >=95%: PASS  (allows 11 wrong, 0 wrong)
```

Every scored value on all four documents: document fields, both parties, type-specific details,
every item column and every special term.

**Reproducible from a clone with no API key and no network.** `npm run accuracy` replays recorded
model responses from `tests/fixtures/llm/` and makes **zero** calls — verified by running it with
`ANTHROPIC_API_KEY=` empty and again with the API base URL pointed at a dead address. Both print
100%.

```
ACME Order From.pdf
  65/65 (100.0%)  escalated: payment_terms_days,special_terms   api calls: 0
CloudShield Order Form.pdf
  78/78 (100.0%)  escalated: payment_terms_days,billing_frequency,special_terms   api calls: 0
```

`escalated` and `api calls` are separate columns on purpose: those fields *did* need the model —
their deterministic rules correctly failed — and the recording answers them without a call. The
two POs escalate nothing at all, because `Net 30` / `Net 45` and their labelled special-term
bullets parse.

### The fixtures are real recordings, not hand-written

One run against `claude-opus-5` produced all five. That distinction is what the number rests on:
a hand-written fixture would score the pipeline against an *invention* of what the model says, so
the printed figure would describe my imagination rather than the system. Four assertions in
`tests/unit/llmModes.test.ts` hold the line — exactly five fixtures, none marked `provisional`,
all recorded against the configured model, and each keyed on a hash of its **prompt**, so editing
an instruction invalidates its recording instead of silently replaying a stale answer.

The model got the hardest field in the set right. CloudShield's Burst clause is ~190 words
carrying three different percentages, a 280,000-unit cap, **and** a `$275,000` figure that is *not*
the cap:

```
burst 38.89  → CloudShield Sensor
burst 28.21  → CloudShield Sensor
burst 19.05  → CloudShield Sensor
burst        → cap 280000 Billable Units
```

"First percentage" and "first money value" both give wrong answers there, which is why this is
the one field a mock could not have proven.

### What recording the fixtures found

A bug that 292 tests had not. The design called for server-side `fallbacks`, and the **first real
call** rejected it:

```
400 invalid_request_error — "fallbacks: Extra inputs are not permitted"
```

That line had never executed. It typechecked, and every test around it passed against mocks
returning shapes *I* had decided the SDK would produce. Removing it was the fix — fallbacks are a
routing optimisation, not something extraction depends on — but the lesson is the general one:
verified-from-documentation is not the same as executed.

### Re-recording

Only needed after editing a prompt, since the key hashes the instruction:

```bash
LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy   # or: npm run accuracy:record
```

Five calls, roughly 25 cents. Note that this is **not** needed to run the service against real
documents — see [Letting it answer the prose fields](#letting-it-answer-the-prose-fields). A
fixture key hashes the input text, so a genuinely new document can only ever *miss*; fixtures
exist so the tests and this number are offline and deterministic, not to serve production.

Every item table also reconciles exactly against its stated total, which is the check that makes
the rest trustworthy:

| | Σ items | stated |
|---|---|---|
| Acme | 50,000 + 60,000 + 25,000 + 12,500 + 5,000 | **152,500** ✓ |
| CloudShield | 7,020,000 + 275,000 + 7,605,000 + 275,000 + 8,190,000 + 275,000 | **23,640,000** ✓ |
| BrightOps | 72,000 + 78,000 + 6,000 + 6,000 | **162,000** ✓ |
| NovaFleet | 120,000 + 132,000 + 145,000 + 54,000 | **451,000** ✓ |

---

## Trying it with your own documents

Drop any PDF into `inbox/` and it is picked up within a poll interval. **Nothing needs to be
configured first** — not the customer, not the document type, not the layout. What varies is how
much comes out, and what you do about the rest.

Set a key first (`LLM_MODE=live`, see [above](#letting-it-answer-the-prose-fields)): you cannot
know in advance whether a document states its payment terms as `Net 30` or as *"within thirty
(30) days"*, so running without one guarantees you will eventually see fields flagged for a
reason that has nothing to do with the document.

### What to expect, by case

| | what happens | likely outcome |
|---|---|---|
| **Existing customer, same doc type** | matched by name or pattern; their own profile applies | `extracted`. A field that changed wording comes back null — that is the drift case, below |
| **New customer, Purchase Order** | issuer inferred from the title **and** `Company Name:` under the Buyer heading — two independent sources agreeing | usually `extracted` straight away, from `purchase_order/_base.yaml` alone. `customer_resolution: unmatched` and a populated `detectedIssuerName` |
| **New customer, Order Form** | order forms never label their vendor, so the issuer is derived by **subtraction**: the shared signature line minus the buyer | same, plus the prose fields which need the key |
| **Existing customer, a type they have not sent before** | profiles are keyed `(customer, doc_type)`, so this resolves to the base profile for that type | works; add a customer profile file only if the base one misses something |

`unmatched` is not an error — it means *"extracted with the base profile, and here is who I think
sent it"*. NovaFleet scores **48/48 from the base profile with no customer file at all**, which is
the evidence that an unfamiliar customer is cheap rather than special.

### Which mode, and what each does with an unseen document

**You cannot know in advance whether a new document needs the model** — that is the premise the
whole deterministic-first design rests on, and it applies to deployment too. So for real use the
key is an operational dependency, not an optional extra:

| mode | a new document |
|---|---|
| **`live`** + key | the correct configuration. Labelled fields come from rules at no cost; prose fields escalate and are answered |
| **`off`** | everything the rules can reach is extracted; prose fields are `NULL` + `FIELD_NOT_FOUND` + `needs_review`. Nothing breaks |
| **`fixture`** | **refused at boot.** A fixture key hashes the input text, so a new document can only *miss*, and a miss is classed permanent — the **whole document** fails, not just its prose field. `off` degrades; `fixture` destroys |

`off` is for a reviewer cloning the repo without an API account, for CI, and for keeping the
service *running* through a key outage or rotation. It is not a configuration for processing
unknown documents.

#### Recovering what was missed

There is an asymmetry here worth knowing, because only one half self-heals:

| | recovers on its own? |
|---|---|
| Key present, API unreachable → `LLM_UNAVAILABLE` | **yes** — classed transient, so backoff retries and the fields are recovered |
| Key **absent** → `FIELD_NOT_FOUND` | **no** — nothing *failed*, so nothing retries. A silent partial loss |

Once a key is in place, pick those up by **reason** rather than by status:

```bash
curl -X POST 'localhost:3000/documents/reprocess?reason=FIELD_NOT_FOUND'
```

`?status=needs_review` would also re-run every document in review for an unrelated reason —
a reconciliation mismatch, an ambiguous currency — and re-bill each one.

#### If other people are testing it

**Do not share your key.** Each tester should use their own, or run `off`. And set a spend limit
in the Anthropic console first: each escalating document is a few cents, but
`POST /documents/reprocess` has **no authentication**, so anyone who can reach the port can
re-bill the entire corpus. That is the auth gap in [Limitations](#limitations) turning into a
cost risk rather than a theoretical one.

### Then look at what it decided

```bash
curl -s localhost:3000/documents | jq '.documents[0]'
curl -s localhost:3000/documents/1/trace | jq      # every value + the text it came from
curl -s localhost:3000/documents/1/runs  | jq      # what the previous attempts produced
```

`/trace` is the one to reach for. It re-slices `raw_text` at each recorded offset and reports
`evidenceVerified`, so a wrong value tells you immediately whether the locator found the wrong
text or the normaliser mangled the right text.

### If something is flagged

`status` is `needs_review` and `reviewReasons` says why. Each one has a specific fix:

| reason | what it means | what to do |
|---|---|---|
| `FIELD_NOT_FOUND` | a rule failed **and** nothing answered the escalation | usually no key. Set one, then `POST /documents/reprocess?reason=FIELD_NOT_FOUND` |
| `UNMATCHED_CUSTOMER` | nobody registered matches the inferred issuer | add them to `config/customers.yaml`, `npm run seed` — the backlog re-resolves itself. Or `PATCH /documents/{id} {"customerId":N}` for a one-off |
| `AMBIGUOUS_CUSTOMER` | two patterns matched | make one pattern more specific. Resolution is a *count*, so it will not guess |
| `UNMAPPED_COLUMNS` | the item table has a column header no synonym covers | add it under `items.column_synonyms` in that customer's profile |
| `TOTAL_MISMATCH` | `Σ items ≠ amount` | the table reconstruction mis-read a row. Check `/trace` and the item rows; this is the check that catches a bad parse rather than letting it through |
| `ITEM_ARITHMETIC` | a row's `quantity × unit_price ≠ total` | the customer may price per period, like CloudShield. Declare `items.reconcile` and a tolerance |
| `AMBIGUOUS_CURRENCY` | a bare `$` and no single ISO code in the document | set `default_currency` in that customer's profile. It is never inferred from an address |
| `MIXED_CURRENCY` | more than one currency in one document | expected, not a defect — subtotals are compared per currency |
| `DATE_ENVELOPE_MISMATCH` | the stated dates disagree with `min`/`max` of the item dates | one side was misread. Often a date format needing `input_format` declared |
| `DATE_OUT_OF_RANGE` | outside 1990–2050 | almost always a format mis-parse rather than a real date |
| `INFERRED_VALUES` | an item value was filled down from the row above | check it. Money and `product_name` are never filled down, so this is a date or an attribute |
| `LLM_EVIDENCE_MISMATCH` / `VALUE_NOT_IN_EVIDENCE` | the model's answer could not be verified against the document, so it was **rejected** rather than stored | the field is null by design. Worth reading the prompt if it recurs |
| `BURST_UNATTRIBUTED` | a Burst term could not be matched to a line item | stored document-scoped with `appliesTo` set, rather than guessing an item |

And two that are **not** `needs_review` but `failed`:

| | |
|---|---|
| `NO_TEXT_LAYER` | an image-only scan. Not supported — see [Limitations](#limitations) |
| `PDF_CORRUPT` / `PDF_ENCRYPTED` | unreadable or password-protected. Fails once, permanently, rather than retrying |

A document with `status: needs_classification` is neither: the type could not be determined, so
there was nothing meaningful to extract (field definitions are per type). Fix it with
`PATCH /documents/{id} {"docType":"order_form"}` and it re-extracts.

### The drift case, end to end

The most common real situation: an existing customer renames a label.

```bash
# 1. the field comes back null
curl -s 'localhost:3000/documents?status=needs_review' | jq '.documents[0].reviewReasons'

# 2. see what the run actually produced
curl -s localhost:3000/documents/7/runs | jq '.[0]'

# 3. add the new wording to that customer's profile, then
npm run seed                    # inserts v3 and activates it

# 4. repair every affected document, not just this one
curl -X POST 'localhost:3000/documents/reprocess?customer=cloudshield&status=needs_review'

# 5. the audit shows v2 -> null, v3 -> the value. Nothing was overwritten.
curl -s localhost:3000/documents/7/runs | jq '.[] | {profileVersion, outcome, isCurrent}'
```

That is the fix that scales: a profile change repairs the whole backlog, where a `PATCH` repairs
one document.

## Terminology — this resolves a real collision

- **customer** — SafeBook's customer: the **issuer** of the document. Acme, CloudShield,
  BrightOps, NovaFleet. Owns the extraction profile.
- **buyer** / **vendor** — the two parties named *on* the document.

The collision: Acme's form has a section headed `Customer Information → Customer Billing Company
Name: Appsoft Inc.` That is the **buyer**, not SafeBook's customer. So "customer" is never used
for a document party.

Which role the issuer holds **inverts** by document type, and the code handles it with no special
case:

| Customer (issuer) | its role | doc type | counterparty |
|---|---|---|---|
| Acme | vendor | Order Form | Appsoft Inc. (buyer) |
| CloudShield Security, Inc. | vendor | Order Form | TechNova Solutions, Inc. (buyer) |
| BrightOps Analytics Ltd. | **buyer** | Purchase Order | DataPulse Software Inc. (vendor) |
| NovaFleet Technologies Inc. | **buyer** | Purchase Order | SecureCloud Systems LLC (vendor) |

The brief's *billing address* is always the buyer's, and *customer signature* always the buyer's
signature.

---

## How it works

```
ingest (sha256 dedupe)
  → parse            pdfjs-dist → raw_text (frozen) + positioned runs (in memory only)
  → classify         weighted, POSITION-AWARE signals             → doc_type
  → infer issuer     from content, with no per-customer regex      → customer
  → resolve profile  (customer, doc_type) falling back to (NULL, doc_type)
  → extract          per field: deterministic rule, escalate on failure
  → normalise        dates → DATE, money → NUMERIC + ISO code, terms → integer
  → validate         Σ items == amount, per-item arithmetic, date envelope — flags, never blocks
  → persist          ONE transaction, including the job's completion
```

Two processes over one `src/`: **`api`** is read-mostly and enqueues jobs; **`worker`** owns the
polling timer and does all parsing, all model calls and all extraction writes. Not to avoid
database locks — Postgres MVCC means readers never block writers — but because `pdfjs` parsing is
CPU-bound and single-threaded, so a large PDF blocks the event loop, and a bulk reprocess cannot
run inside an HTTP handler.

### Nothing is decided by the filename

Classification and customer both come from parsed content. The filenames in the sample set
demonstrate why: `ACME Order From.pdf` misspells "Form", and two files are named after the
**vendor** while two are named after the **buyer**. `original_filename` is stored as metadata and
never used for logic — not even to build a storage path, since the key is always
`archive/<sha256>.pdf`.

### The model is reached, never chosen

No profile ever says "use the LLM". Each field runs its deterministic rule and escalates **only**
if that yields nothing or yields something that fails to parse:

| Document | `Payment Terms:` label | its text parses as `Net xx` | outcome |
|---|---|---|---|
| BrightOps | yes | `Net 30` → yes | rule, **no call** |
| NovaFleet | yes | `Net 45` → yes | rule, **no call** |
| Acme | yes | *"made within thirty (30) days from invoice"* → no | **escalates** → 30 |
| CloudShield | yes | prose → no | **escalates** → 45 |

Same code path, opposite outcomes, zero configuration. **Two of the four documents never call the
model at all.** A future BrightOps PO whose wording drifts escalates automatically — no config
change and no deploy.

`LLM_MODE` (`off` / `fixture` / `live` / `record`) decides whether the model is reachable *at
all*; it is deployment plumbing, not a property of a customer. With no API key the service runs
deterministic-only: lower recall on prose, no failures.

### Every stored value points back at document text

`GET /documents/:id/trace` returns each field with the exact characters it came from, and
**re-slices `raw_text` at the recorded offsets to prove it**:

```jsonc
{ "field": "amount", "value": "162000", "source": "rule",
  "evidence": { "start": 777, "end": 789, "text": "$162,000 USD" },
  "evidenceVerified": true }
```

Rule-sourced values carry offsets too, so this has no exception for the deterministic path. A
model-sourced value additionally has to survive two checks — its quote must exist in `raw_text`,
and the value must be derivable from that quote — or it is **rejected rather than stored**.

---

## Database

PostgreSQL 16, eleven tables, one migration (`src/db/migrations/001_init.sql`). Hand-written SQL
and a thin repository layer rather than an ORM — the schema *is* the design here, and most of the
decisions below are visible in it.

```
customers ──< customer_match_patterns        how an issuer in the text maps to a customer
    │
    ├──< extraction_profiles                 the rules; versioned, append-only
    │                                        customer_id NULL = the base profile
    └──< documents                           one row per PDF; the brief's nine fields
           ├──< document_parties             buyer + vendor, keyed (document_id, role)
           ├──1  order_form_details      ┐   exactly one of the two,
           ├──1  purchase_order_details  ┘   chosen by doc_type
           ├──< document_items
           │       └──< special_terms        item_id NULL = document-scoped
           ├──< extraction_runs              append-only audit; pins the profile version
           └──< jobs                         the queue, claimed with SKIP LOCKED

      ──<  one-to-many        ──1  one-to-one
```

`special_terms` carries `document_id` as well as `item_id`, so a document-scoped term needs no
item row to hang off.

### Configuration — projected from YAML, never edited by hand

| table | purpose |
|---|---|
| `customers` | SafeBook's customers: the **issuers**. `slug`, `name`. |
| `customer_match_patterns` | How an issuer in the text maps to a customer. `kind` is `text`, `signature_block` or `doc_id`, which *scopes* the search — Acme's name occurs exactly once in its whole document, in the signature block, so a whole-text search would be too weak. **No `weight` column**: resolution is a *count*, not a score. Exactly one match wins; two or more is `ambiguous` and gets flagged, because letting a heavier pattern win silently would be guessing. |
| `extraction_profiles` | The per-customer, per-doc-type extraction rules, as JSONB. **Append-only and versioned** — a change inserts `version+1` rather than mutating, because `extraction_runs.profile_id` needs an immutable record of the rules that produced each value. `definition` holds the **merged** result (`extends: _base` resolved once at seed time), so a row is self-contained and the audit never needs a re-merge that might behave differently later. `customer_id IS NULL` **is** the base-profile case — one lookup rule, no sentinel customer row. Two partial unique indexes enforce one version number per pair and at most one `is_active`. |

`npm run seed` is the only writer of these three. YAML in git is the single source of truth; the
pipeline reads only the database.

### Documents

| table | purpose |
|---|---|
| `documents` | One row per PDF, holding the brief's nine fields as **current values**. `file_sha256` is `UNIQUE` — that one constraint is the whole idempotency story. `raw_text` is stored at first extraction and then **frozen**, because evidence offsets index into it. Positioned layout is deliberately *not* stored: a reprocess re-parses the archived PDF, so parser improvements apply retroactively. |
| `document_parties` | Both parties, both document types, keyed `(document_id, role)`. Symmetric because which role is SafeBook's customer *inverts* by type. All four samples name both, with wildly different completeness — Acme's vendor has a name and a signature but **no address anywhere in the document** — and varying completeness becomes NULLs here rather than columns scattered across three tables. |
| `order_form_details`<br>`purchase_order_details` | 1:1 extensions holding only what is genuinely type-specific: `quote_number`, `po_required`… / `po_number`, `po_date`. Real typed columns with real `NOT NULL`s, which a shared table could not have. |
| `document_items` | The line items. `product_name` is **nullable on purpose**: if the table parse cannot recover it, the row's money still reconciles and is worth keeping — `NOT NULL` would force dropping the row and break the `Σ items == amount` check that validates all four samples. `field_sources` records provenance for values *not* read directly off the page (`inherited`, `filled_down`, `from_document`), and `has_inferred` is a `GENERATED` column over it, so "show me anything inferred" is an index lookup. |
| `special_terms` | Natural-language terms, one row each. `term_text` is the **source of truth, as received**; `percent`, `cap_value`, `period`, `applies_to` are a *projection* of it written once at extraction, not derived per request — CloudShield's burst paragraph contains 38.89%, 28.21% **and** 19.05%, so choosing the right one needs item context only the extraction stage has. `item_id IS NULL` means document-scoped; there is **no `scope` column**, because it would be pure duplication of that test. `term_type` is `TEXT` not an enum, so a new kind of term needs no migration. |

**Why one `documents` table rather than `order_forms` + `purchase_orders`:** the brief's nine
fields are identical for both types, so two tables would duplicate every one of them. More
decisively, `doc_type` is **unknown at insert time** — `needs_classification` is a real state — so
split tables leave an unclassified document with no home, and `PATCH /documents/:id {docType}`
degrades from an `UPDATE` into a cross-table move dragging items, terms and runs with it.

### Audit and operations

| table | purpose |
|---|---|
| `extraction_runs` | Append-only, one row per attempt. Carries `field_confidence` — per field, the value, the strategy that found it, and the **evidence span** `{page, start, end, text}` — plus `profile_id` pinning the exact rules version, `llm_calls`, and the outcome. It holds **no duplicated field values**, so current-state queries stay a single join while history is still answerable: after a profile fix the audit shows `v2 → null, v3 → 23,640,000.00` with nothing overwritten. |
| `jobs` | The queue. Postgres *is* the queue — no Redis. Claimed with `FOR UPDATE SKIP LOCKED`. `attempts` is incremented **at claim time**, not on failure, which is what stops a worker crash-looping on one document from retrying forever. Two partial unique indexes do the deduplication: `(document_id, kind) WHERE status IN ('queued','running')` means the same work cannot be queued twice, and `(kind) WHERE document_id IS NULL AND …` makes repeat `POST /scan` calls coalesce instead of piling up sweeps. |

### Two schema decisions worth defending

**`CHECK` constraints encode our own formats, never assumptions about the world.** A violated
`CHECK` aborts the transaction and discards *everything*, so a constraint that encodes a guess
turns one odd value into total data loss. `CHECK (amount >= 0)` was in an earlier draft and is
exactly that mistake — a credit line is legitimate, and CloudShield itself carries a `$412,583.67`
credit. So `currency ~ '^[A-Z]{3}$'` stays a constraint (if that fails, *our normaliser* is
broken and should be loud), while `amount >= 0` and `end_date >= start_date` are **validation
warnings** that flag for review. Validation never blocks persistence: partial data with a clear
flag beats no data.

**Money is `NUMERIC` and dates are `DATE`, never formatted strings.** `22916.67 × 12` only
reconciles to `275,000.00` without float error, and the brief's `mm-dd-yyyy` / `Net xx` are
*output* formats applied by one serialiser at the API boundary — storing them would break ordering
and range queries. The driver needed explicit type parsers to stop undoing this (`src/db/types.ts`):
node-postgres parses a `DATE` into a JS `Date` at **local midnight**, which in UTC+3 made
`2025-03-01` come out of the API as `02-28-2025`. The database was right the whole time; only the
read path was wrong.

### Looking at it

```bash
docker compose exec postgres psql -U safebook -d safebook
\dt                      -- the eleven tables
\d documents             -- columns, constraints, indexes
```

Any Postgres client works against `localhost:5432` (`safebook` / `safebook` / `safebook`).

---

## Adding a fifth customer

One entry in `config/customers.yaml`, plus a profile file only if the base one does not already
cope:

```yaml
customers:
  - slug: northwind
    name: Northwind Logistics Ltd.
    match:
      - { kind: text, pattern: 'Northwind Logistics Ltd\.' }
```

```bash
npm run seed    # projects YAML into versioned extraction_profiles rows,
                # and re-resolves the `unmatched` backlog against the new patterns
```

NovaFleet is the evidence that this is cheap: it scores **48/48 from
`purchase_order/_base.yaml` alone**, with no customer profile file at all.

**YAML in git is the single source of truth.** `npm run seed` is the only writer of
`extraction_profiles`; the pipeline reads only the database. There is deliberately no
`POST /profiles` — an earlier draft had one, plus a `source` column and an export command to
reconcile the resulting drift, and all of that machinery existed only to manage a *second
writer*.

### Drift: a customer renames a label

1. Next PDF: issuer still matches, `amount` comes back null → `status='needs_review'`.
2. `GET /documents/:id/runs` shows profile v2 with `amount: null`.
3. Add the new label to that customer's YAML; `npm run seed` inserts **v3** and activates it.
4. `POST /documents/reprocess?customer=cloudshield&status=needs_review`
5. The audit shows v2 → null, v3 → the value. Nothing was overwritten.

---

## API

`openapi.yaml` is the **contract, not documentation written afterwards**: served at `/docs`,
**enforced at runtime in both directions** by `express-openapi-validator`, linted by
`npm run lint:api`, and exercised operation-by-operation by the contract test.

Response validation is the part that earns its keep. Every response schema is
`additionalProperties: false`, so a handler that returns an undeclared field or renders a date
wrong **fails the test suite** rather than shipping.

| | |
|---|---|
| **ingest** | `POST /documents` (multipart, 1..N) · `POST /scan` |
| **inspect** | `GET /health` · `/documents` · `/documents/{id}` · `/{id}/runs` · `/{id}/trace` · `/{id}/file` · `/jobs/{id}` · `/special-terms` · `/customers` · `/customers/{slug}/profiles` |
| **correct** | `PATCH /documents/{id}` · `POST /{id}/reprocess` · `POST /{id}/review` · `POST /documents/reprocess` |

### A human may correct routing, never a value

Only `customerId`, `docType` and a review acknowledgement are writable. Both routing fields
change the **input** to extraction, so re-extraction regenerates every field with fresh
evidence — even a manual override cannot produce an unevidenced value. The contract enforces it:

```bash
$ curl -X PATCH localhost:3000/documents/1 -d '{"amount":"1.00"}'
{"error":"request/body must NOT have additional properties: /body/amount …","code":"BAD_REQUEST"}
```

A wrong *value* means the definition is wrong, and the fix is a profile change — which repairs
every affected document rather than one.

Dates render `mm-dd-yyyy` and payment terms `Net xx` **at this boundary only**; they are stored as
`DATE` and `INTEGER`, because storing the display format would break ordering and range queries.
Money is always a decimal **string** — `22916.67` becomes `22916.669999999998` as an IEEE double,
and the point of `NUMERIC` is defeated if anything parses it on the way through.

---

## Operations

### The folders

```
inbox/        dropped here, by you or by a sync client. Swept on a timer
processed/    moved here once registered, UNDER ITS ORIGINAL NAME
failed/       moved here if the scan rejects it (not a PDF, over the size cap)
archive/      content-addressed storage: <sha256>.pdf. The service reads from here
```

A file leaves `inbox/` as soon as it is registered — the assigner explicitly allowed moving
completed files to an archive folder, and it is not merely tidiness. Leaving them there means the
inbox grows without bound **and every poll tick re-reads and re-hashes every file in it** just to
rediscover it is a duplicate. With moving on, a steady-state tick reports `found: 0` and does
nothing.

`processed/` keeps the **original filename** rather than the content hash, because
`archive/<sha256>.pdf` is right for retrieval and useless to a human looking at a folder. A
name collision appends `.1`, `.2` — two customers can both send `Order Form.pdf`, and the
earlier file is never clobbered.

A **rejected** file moves to `failed/` for the same reason: a scan-stage rejection is permanent,
so leaving it in place would re-read and re-reject it on every tick forever.

```bash
cp "sample docs/"*.pdf inbox/
echo "not a pdf" > inbox/broken.pdf
# a few seconds later
ls inbox/          # empty
ls processed/      # the four PDFs, original names
ls failed/         # broken.pdf
```

**Set `MOVE_PROCESSED=false` to leave files where they are.** Worth having, because the inbox may
be a shared cloud drive the customer also uses, where silently relocating their files is
unwelcome. With it off, a file that has already been settled is skipped on later ticks by its
`size + mtime`, so it is still not re-hashed — and a file whose bytes change is reconsidered,
because a corrected version is a different document.

- **Polling, not a filesystem watcher.** The assigner confirmed there are no file-arrival alerts.
  A watcher would also have satisfied that, but the folder was explicitly allowed to be a shared
  cloud drive, and filesystem events are unreliable on sync-backed mounts. Polling behaves
  identically on both.
- **A write-stability gate.** A file is eligible only once its size and mtime have held steady
  across two ticks. Without it a tick catches a half-copied file, or one that has appeared on a
  cloud drive but not finished syncing.
- **Postgres is the queue** — `FOR UPDATE SKIP LOCKED`, no Redis. Scaling out is more worker
  replicas, with no code change.
- **Retries are classified, not counted.** A `transient` failure backs off (~1s, 10s, 60s with
  jitter); a `permanent` one — corrupt PDF, image-only scan, a value that can never cast — is
  terminal at the first attempt, because retrying it produces an identical failure and, where
  model calls are involved, an identical bill.
- **Graceful shutdown with a grace period.** `docker compose down` SIGKILLs after ~10s, so
  waiting indefinitely for an in-flight job does not buy it more time — it forfeits the chance to
  hand its lock back, leaving the job to wait out the five-minute stale sweep. The worker waits 8s,
  then releases the lock and exits.
- **Content-addressed idempotency.** The same bytes arriving in the folder *and* by upload is one
  document and one extraction. Re-dropping a file costs nothing.
- **Logs never carry document text.** These are customer contracts. Every line carries ids, the
  stage, a duration and an error code.

---

## Testing

```bash
npm test            # 292 tests
npm run accuracy    # the scored number
npm run typecheck
npm run lint:api
npm run check:llm    # is Claude reachable, and what happens when a rule fails
```

**No test ever calls Claude**, and that is enforced rather than assumed: a Vitest setup file
*refuses* `LLM_MODE=live` or `record` and pins the suite to `fixture`, so an exported shell
variable cannot turn `npm test` into a billed run.

Mocks and recorded fixtures do different jobs, deliberately. A `vi.fn()` mock proves the
**plumbing** — a hallucinated quote is rejected, a refusal is handled, an explicit null does not
crash. The accuracy number must come from a **recorded real response**, because a mock there
would score the pipeline against output I imagined.

The 39 integration tests need Postgres and **skip themselves with a printed reason** without it.
They use their own database (`safebook_test`, created and migrated by a global setup), because
sharing the development one meant a worker running in another terminal claimed the tests' jobs —
`SKIP LOCKED` doing exactly its job — and, worse, ran `LLM_MODE=off` while the runner pinned
`fixture`, so the same document succeeded under one and failed under the other.

---

## Limitations

Stated plainly, because a reviewer should not have to discover them.

| | |
|---|---|
| **Image-only scanned PDFs are not supported.** | Detected as `NO_TEXT_LAYER` and failed fast rather than silently mis-extracted as an empty document. The mitigation needs no pipeline change — PDF-direct base64 input to the model's vision — but it is not built. |
| **The scored number replays recorded responses, not live calls.** | 239/239 reproduces offline with no key, which is the point — but it pins the model's answers as of one recording. A prompt edit invalidates them by design (the key hashes the instruction); a model change would want a re-record. See [Accuracy](#accuracy). |
| **No UI beyond Swagger.** | The brief's deliverable is a repo and a README. `/docs` renders a real file picker for the multipart upload, so the samples can be submitted from a browser and results browsed — which covers most of what a read-only page would have. |
| **No authentication.** | Out of scope for the assignment. Every endpoint is open, and `GET /jobs/{id}` exposes a worker hostname. This is not deployable as-is. |
| **One document type pair.** | A third type (invoice, SOW, amendment) needs a migration: a new enum value and a new field catalog. |
| **A new date or money *format*** (D/M/Y, `EUR 1.234,56`) | needs a registry entry in code, not config. It fails *safe*: the ambiguity guard flags rather than guessing. |
| **Burst → item attribution is the softest extraction.** | Mapping "monitored workloads" to `Advanced Threat Monitoring` is a judgement call. An ambiguous mapping is written document-scoped and flagged, rather than guessing an item. |
| **A single serial worker** | suits the assignment's volume. The queue already supports concurrency; raise the replica count. |

### Assumptions, and which the assigner confirmed

| | |
|---|---|
| ✅ The folder may be a local directory **or a shared cloud drive** | confirmed — which is why the trigger must not depend on filesystem events |
| ✅ **No arrival notifications**; the service discovers files itself | confirmed — *"the process will need to poll/check periodically"* |
| ✅ Processed files may be moved to an archive | confirmed |
| ✅ Extracting type and customer **from content** is the right approach | confirmed outright |
| ⬜ Image-only scans | scoped out by decision, above |
| ⬜ PDF only | `.docx` / `.xlsx` out of scope |

---

## What I'd do next

[Limitations](#limitations) says what does not work. This says what I would fix first, and why
that order — the gaps are not equally urgent, and two of them are disqualifiers rather than
rough edges.

**1. Authentication, before this touches anything real.** Not a hardening pass — a disqualifier.
`GET /documents/{id}/file` serves customer contracts to anyone who can reach the port, and
`POST /documents/reprocess` lets them re-bill the entire corpus against your API key. The
cheapest credible version is an API key per consumer checked in middleware, declared in
`openapi.yaml` as a security scheme so the validator enforces it; the right version is an
authenticating gateway in front, since this is an internal service. Either way it comes first.

**2. Durable storage.** `LocalFsAdapter` is the only implementation — `S3Adapter` is an interface
and a comment. So there is no durability and no multi-instance deployment: two workers on
different hosts would archive to different disks. The seam already exists and nothing outside
`storage/` would change, which is exactly why it was worth building as a seam.

**3. Secrets out of the repo.** `POSTGRES_PASSWORD: safebook` and the full `DATABASE_URL` are in
`docker-compose.yml`, in git. Fine for a local demo, wrong anywhere else. The Anthropic console
offers identity federation for this, which is the better answer than shipping a key around.

**4. OCR for scanned contracts.** A real share of signed contracts arrive as images, and today
they fail fast as `NO_TEXT_LAYER`. The mitigation needs no pipeline change — PDF-direct base64
input to the model's vision — so this is cheaper than its position here suggests. It sits fourth
only because the three above are correctness and security rather than coverage.

**5. Timeouts, then observability.** There are no timeouts in `extract`, `pdf` or `llm`: a
pathological PDF or a hung API call blocks the worker until the stale-lock sweep five minutes
later. After that, metrics and alerting on the review queue and the job-failure rate — the
structured logs are there, nothing aggregates them.

**6. Retention.** `archive/` grows without bound, and these are customer contracts: a deletion
policy is a compliance question as much as a disk one. There is also no audit of *who read which
document* — `extraction_runs` audits extraction, not access, and Acme's own document cites GDPR.

Deliberately **not** on this list: more customers or document types. Those are the things the
design already makes cheap — a new customer is one YAML entry, and the base profiles handle an
unfamiliar layout. Adding more would demonstrate less than the six above would fix.

## Layout

```
src/
  entrypoints/{api,worker}.ts      HTTP; polling timer + job loop
  pdf/{parse,tables,findTable}.ts  text + positioned runs; table reconstruction from geometry
  classify/{docType,inferIssuer}   what is this, and who sent it
  profiles/{schema,loader,seed}    YAML → versioned rows; strict validation
  extract/{engine,pipeline}        deterministic-first, escalate on failure
  extract/strategies/              labelValue · patternValue · multilineAfterLabel ·
                                   twoColumnSignature · sections (offset-preserving masks)
  extract/normalize/               date · money · netTerms · coerce
  llm/{client,evidence,schemas}    live | fixture | record; quote verification
  jobs/{repo,loop,errors}          SKIP LOCKED queue; retry classification
  poller/{loop,scan}               chained timer; write-stability gate
  api/{server,routes,present}      spec-enforced; present.ts shapes every response
  db/                              migrations, pool, type parsers, persistence
config/{customers,fields,profiles} the per-customer customisation
accuracy/                          ground truth + the shared scoring used by harness AND tests
tests/helpers/makePdf.ts           writes minimal PDFs, so tests can use documents
                                   from customers that do not exist
openapi.yaml                       the contract
spike/                             phase-0 throwaway: the scripts that verified the table
                                   geometry against real pdfjs output BEFORE anything was
                                   built on it. Kept because they corrected four wrong
                                   assumptions in the design — see DESIGN.md, "What
                                   phase 0 corrected". Not part of the service
docs/DESIGN.md                     the full design record, including what went wrong
```

`docs/DESIGN.md` is the long form: every decision, why the alternative was rejected, and the bugs
that changed the design. It is where the reasoning lives — including the parts that were wrong
first.
