# SafeBook — Document Data Extraction Service

## Context

Home assignment (`Assignement - Document Data Extraction.pdf`). SafeBook's customers drop
contract PDFs into a dedicated folder. The service must process any document landing there,
identify its type, and extract a fixed field set using **customised definitions per customer
and document type**, producing tabular structured data.

The brief's KPIs: **≥95%** field accuracy, **≥2** document types, **≥2** customer-specific
variations per document type. The four sample PDFs map onto that exactly — two Order Forms
(Acme, CloudShield) and two Purchase Orders (BrightOps, NovaFleet).

Why this needs real design rather than a parsing script: the two Order Forms state payment
terms only in prose ("within thirty (30) days from invoice"), name their Burst allowance in
paragraphs rather than fields, and in Acme's case never use the phrase "Technical Account
Manager" at all. The two POs state the same facts as labelled key/value pairs. A regex
template cannot reach 95% on the prose; an LLM alone is unreliable on the money columns.
Hence a hybrid, with definitions held as data so a fifth customer is a config change.

**Status: greenfield.** `/Users/lirazfriedman/workspace/safeBook/safebookshomeassignment/`
contains only the brief and `sample docs/`. No git repo yet.

## Decisions (settled with the user)

| Area | Decision |
|---|---|
| Extraction | Hybrid — deterministic rules for structure, Claude for natural language |
| Database | PostgreSQL 16 in Docker |
| DB access | `pg` driver + hand-written SQL migrations, thin repository layer |
| Language/scope | TypeScript; two entrypoints (`api` + `worker`) over one `src/` |
| Job queue | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED`. No Redis |
| Mixed ingress | Folder poll and `POST /documents` are both normal paths. `documents.ingress` ('poll'/'upload') records which; dedupe is by `file_sha256` so the same bytes arriving both ways is one document, no second job |
| Triggers | **In-process polling timer** in the worker + `POST /documents`. No `chokidar` — the assigner confirmed no file alerts exist, and polling also survives the folder being a cloud drive |
| Optional fields | Profile-declared, stored in `attributes` JSONB on documents **and** items |
| Original PDF | Local `archive/<sha256>.pdf` behind a `StorageAdapter`; S3 noted as the production choice |
| Dates | Stored `DATE`; `input_format` declared per field in the profile; `mm-dd-yyyy` only at the API boundary |
| Payment terms | Stored as `payment_terms_days INT`; the brief's `Net xx` is rendered at the API, same rule as dates |
| Layout | **Not stored.** Reprocess re-parses the archived PDF, so parser improvements apply retroactively. Only `raw_text` is frozen, because evidence offsets index into it |
| Currency | `NUMERIC` + `currency CHAR(3)` ISO code; symbol→code map is a constant in code |
| Raw forms | Not duplicated into columns — kept as evidence in `extraction_runs.field_confidence` |
| Missing item values | Group-row `inherited` → previous-row `filled_down` → `from_document` → NULL; recorded in `document_items.field_sources`, money and `product_name` never filled down |
| Classification | From **parsed content only** — never the filename or folder |
| Customer identity | From parsed content only, matched against registered customers |
| Unknown issuer | Still extracted via base profile (`customer_id NULL`), reassignable later |
| Result storage | Current values replace in place; append-only `extraction_runs` audit log |
| Doc-type tables | One shared `documents` table + `order_form_details` / `purchase_order_details` 1:1 extensions |
| Parties | `document_parties` keyed `(document_id, role)` — buyer and vendor symmetric. All four samples name both, with very different completeness (Acme's vendor has no address at all) |
| Special terms | One `special_terms` table; `term_text` as received + parsed columns + `attributes` JSONB |
| Definitions | **YAML in git is the single source of truth.** `npm run seed` projects it into versioned `extraction_profiles` rows; nothing else writes them. Rows exist because `extraction_runs.profile_id` needs an immutable target for the audit trail |
| Profile storage | `definition` holds the **merged** result — the seeder resolves `extends: _base` once, so a row is self-contained and needs no re-merge to interpret |
| LLM in tests | Recorded Claude responses committed as fixtures → tests run offline |
| Model | **`claude-opus-5`**, id in config. No `temperature`/`budget_tokens` (both 400 on this model); depth via `output_config.effort` |
| LLM calls | **One per section** — payment terms, special terms, + doc-type tiebreak when scores are close |
| LLM output | `client.messages.parse()` + `zodOutputFormat`; model returns `quote`, **we** resolve offsets via `indexOf` |
| UI | **None.** Brief asks for repo + README; a read-only HTML page is a stretch goal, not a phase |
| Upload | `POST /documents` multipart, 1..N files, per-file results (`202`/`207`); duplicate sha256 → `200`, no job |
| Human edits | **Routing only** — `customerId`, `docType`, plus review acknowledgement. Extracted values are never writable |
| Traceability | Evidence spans with page + character offsets; `GET /documents/:id/trace` |
| HTTP framework | **Express** — chosen by the OpenAPI tooling below |
| Item arithmetic | Profile-declared `reconcile` formula + tolerance; CloudShield needs `× order_term_months` and 0.5% for documented rounding |
| Total mismatch | Persist everything + `needs_review`, never discard |
| DB `CHECK`s | **Formats and structure only** — value checks (`amount >= 0`, `end_date >= start_date`, negative quantity) are validation warnings, so a legitimate credit note can't discard a whole extraction |
| Missing doc dates | Derived from `min/max` of item dates (`field_sources: 'from_items'`); envelope vs stated dates is a third reconciliation check, exact on all four samples |
| Mixed currencies | Reconciliation groups by currency; a bare `$` resolves only when the document has **exactly one** ISO code, else `AMBIGUOUS_CURRENCY` |
| Bad LLM evidence | Value rejected (column `NULL`) + `LLM_EVIDENCE_MISMATCH` flag |
| Confidence | **Recorded, never gated on** — self-reported scores aren't calibrated. Flagging comes from deterministic checks: quote found in `raw_text`, value derivable from its own quote, reconciliation, explicit nulls |
| HTTP errors | Simple `{ error, code }`, `code` shared with `jobs.error_code` |
| API docs | Hand-written `openapi.yaml`, **spec-first**: served at `/docs` via `swagger-ui-express` and *enforced* at runtime by `express-openapi-validator` |

## Assumptions — four confirmed by the assigner

The brief says only "a dedicated folder", so these were the open assumptions. **A1, A2, A3 and
A8 have since been confirmed by email** (quoted below), and **A4 was scoped out by decision** —
image-only scans are out of support for now. Nothing here is still open.

| # | Assumption | Status / if it's wrong |
|---|---|---|
| A1 | The folder is a **local directory** | ✅ *"Feel free to use either a local directory or a shared cloud drive — whichever is easiest for you."* Local it is. `StorageAdapter` stays as a seam but S3 is not needed. Because a cloud drive was offered as equally acceptable, the trigger must not depend on filesystem events — see A2 |
| A2 | **No arrival notification**; the service discovers files itself | ✅ *"There are no incoming file alerts, so the process will need to poll/check periodically for new arrivals."* **This changed the design:** `chokidar` is dropped in favour of an in-process polling timer (below) |
| A3 | The service **may move** processed files to `archive/` | ✅ *"You can move completed files into an archive folder once processed."* As designed — and still not load-bearing, since the scan hash-checks rather than assuming an emptied inbox |
| A4 | PDFs always have a **text layer** | ✅ **Scoped out by decision** — image-only scans are explicitly not supported for now, and the README says so. A scan is still *detected* rather than mishandled: zero extracted text fails fast as `NO_TEXT_LAYER`, which is countable. If it ever needs supporting, the mitigation is already recorded — PDF-direct base64 input to Claude's vision, which needs no change elsewhere in the pipeline |
| A5 | A re-uploaded identical file is a **no-op**; a corrected version has a different sha256 and becomes a new document | If supersede semantics are wanted, add `supersedes_document_id` rather than overwriting, so the earlier extraction stays auditable |
| A6 | **Modest volume** — a single serial worker suffices | High volume → the `jobs` table already supports concurrent workers via `FOR UPDATE SKIP LOCKED`; raise the worker replica count |
| A7 | **PDF only** | `.docx` / `.xlsx` / image formats are out of scope as planned |
| A8 | **One flat inbox**, not a folder per customer — the customer comes from parsed content; the scan glob is `inbox/**/*.pdf` (recursive on purpose, so nesting never breaks ingestion) | ✅ *"Extracting the customer and document type directly from the file content is definitely the right approach."* Confirmed outright. The evidence below was correct, and is still worth keeping as README material |

### Why A8 is an inference rather than a guess (README material)

1. **The delivered samples are a flat folder.** `sample docs.zip` holds all four PDFs at the
   root, zero subdirectories — two document types from four different customers, mixed.
2. **The brief says "folder", singular, three times**, never "folders" and never per-customer:
   "documents in a folder", "automatically processes **this folder**", "any document landing in
   **a dedicated folder**".
3. **The brief assigns type identification to the service** — "identifies the document type".
   If the folder or filename carried the type, that requirement would be vacuous. The same
   reasoning extends to the customer.
4. **Filenames are demonstrably unreliable.** `ACME Order From.pdf` misspells "Form", so
   anything keyed on filenames breaks on sample #1. The convention is also inconsistent in
   direction: two files are named after the **vendor** (ACME, CloudShield), two after the
   **buyer** (BrightOps, NovaFleet).
5. **"Various types of documents in a folder"** states outright that types are mixed in one
   place.

## Terminology (deliberate, resolves a real collision)

- **customer** — SafeBook's customer: the **issuer** of the document. Acme, CloudShield,
  BrightOps, NovaFleet. Owns the extraction profile.
- **buyer** / **vendor** — the two parties named *on* the document.

The collision this avoids: the Acme form has a section headed `Customer Information →
Customer Billing Company Name: Appsoft Inc.` — that is the **buyer**, not SafeBook's
customer. The word "customer" is therefore never used for a document party.

Which role the issuer holds inverts by document type:

| Customer (issuer) | Its role | Doc type | Counterparty | Its role |
|---|---|---|---|---|
| Acme | vendor | Order Form | Appsoft Inc. | buyer |
| CloudShield Security, Inc. | vendor | Order Form | TechNova Solutions, Inc. | buyer |
| BrightOps Analytics Ltd. | buyer | Purchase Order | DataPulse Software Inc. | vendor |
| NovaFleet Technologies Inc. | buyer | Purchase Order | SecureCloud Systems LLC | vendor |

BrightOps and NovaFleet are both SafeBook's customer *and* the buyer on their own PO; the
model handles this with no special case. The brief's `billing address` is always the
**buyer's**, and `customer signature` is always the **buyer's** signature.

## Document type definitions

**Order Form** — issued by the **seller**; a priced offer that becomes a contract on signature.
**Purchase Order** — issued by the **buyer**; authorises a purchase from a vendor.

Classification signals, weighted and **position-aware** (the page-1 title region dominates):

| Order Form | w | Purchase Order | w |
|---|---|---|---|
| title `/^order form$/i` in top region | 3 | title `/purchase order/i` in top region | 3 |
| `Quote Number:` | 3 | `Purchase Order Number:` | 3 |
| `Quote Expiration Date:` | 2 | `Vendor` **and** `Buyer` section headings both present | 3 |
| `Proposed By:` | 2 | `PO Date:` | 2 |
| `To: <company>` near top | 2 | `Total PO Amount:` | 2 |
| two side-by-side signature blocks | 2 | single `Buyer Signature:` | 2 |
| `Customer Information` heading | 1 | `Line Items` heading | 1 |
| `This is not an invoice` | 1 | | |

⚠️ **The CloudShield trap.** Its *Order Form* contains a section headed `Purchase Order
Information` with `PO Number:` and `PO Amount: USD 0.00`. A substring match on "purchase
order" misclassifies it, and a naive `amount` lookup picks up `USD 0.00`. Two defences:
position weighting (its actual title is `ORDER FORM`) decides classification, and the
profile's `ignore_sections` excludes that block during **extraction**.

When `|score_order − score_po| < 3` or both scores `< 4`, Claude arbitrates on page-1 text.
If still unresolved → `status='needs_classification'`, no extraction attempted (field
definitions are per doc type, so there is nothing meaningful to extract), correctable via
the same `PATCH` + reprocess path as a customer reassignment.

## Pipeline

```
ingest (sha256 dedupe)
  → parse            pdfjs-dist → raw_text (stored) + positioned items (in-memory only)
  → classify         weighted signals, LLM tiebreak        → doc_type
  → resolve customer DB match patterns incl. signature block → customer_id | NULL
  → resolve profile  (customer_id, doc_type) → fallback (NULL, doc_type)
  → extract          per-field strategies: rules first, LLM for prose
  → normalise        dates → mm-dd-yyyy, money → NUMERIC+currency, terms → "Net xx"
  → validate         Σ items == amount, per-item arithmetic, date envelope,
                     evidence spans — failures flag, never block (see Validation)
  → persist          one tx: replace documents fields, type details row, items,
                     special terms; append extraction_runs row
```

`raw_text` is stored at parse time and then **frozen** — the evidence offsets index into it, so
the trace stays verifiable. Positioned layout is deliberately **not** stored: reprocessing
re-parses the archived PDF instead. Parsing a 191 KB file is ~50 ms against 2–5 seconds of LLM
calls, so there is nothing to save, and re-parsing means a reprocess picks up improvements to
`pdf/tables.ts` rather than replaying stale stored layout.

## Processes, triggers and retries

Two entrypoints over one `src/`, both in `docker-compose` against the same Postgres:

- **`worker`** — owns the polling timer and the job loop. All parsing, LLM calls and writes.
- **`api`** — read-mostly; mutations enqueue a job and return `202` with a job id.

Why split, precisely: **not** to avoid DB locks. Postgres MVCC means readers never block
writers and writers never block readers (writers contend only on the same row), and both
processes would hit the same instance anyway. The real reasons are that `pdfjs-dist` parsing
is CPU-bound and single-threaded so a large PDF blocks Node's event loop, and
`POST /documents/reprocess?customer=…` can touch dozens of documents with LLM calls — which
cannot run inside an HTTP handler. A queue is required regardless; given one, a separate
worker is nearly free.

Both ingresses converge on one enqueue path — sha256, archive the file, upsert the `documents`
row, insert a job. No parsing in the ingress path:

```
polling timer    ─┐
                  ├─→ enqueueIngest()  → jobs(kind='ingest')   ⟵ returns here
POST /documents  ─┘
```

### Polling, not a watcher

The assigner confirmed there are no file-arrival alerts. A filesystem watcher would also have
satisfied that — it is *pushed* by the OS rather than a check — but the folder was explicitly
allowed to be **a shared cloud drive**, and filesystem events are unreliable on sync-backed and
network mounts (often absent entirely on SMB/NFS). Polling behaves identically on both, so it is
the choice no answer can invalidate.

The reconciliation scan already in the design **is** the poll body: list, stat, hash, skip
anything whose sha256 is already in `documents`, enqueue the rest. It was always idempotent
because the hash check is the authority — so running it on a timer rather than once at boot is
the whole change.

```ts
async function tick() {
  try { await scanInbox(); }
  finally { setTimeout(tick, POLL_INTERVAL_MS); }   // chained, never overlapping
}
```

Chained `setTimeout` rather than `setInterval`, so a slow scan delays the next tick instead of
racing it — the overlap problem an external cron would need a lockfile to solve. An in-process
timer is also the right home because the worker is already long-lived (it holds the
`SKIP LOCKED` job loop); cron would pay Node startup and a fresh connection pool every tick,
floor the interval at one minute, and buy no resilience — if the worker is down, cron-enqueued
jobs go unprocessed anyway.

**Write-completion gate — this replaces what `awaitWriteFinish` gave us.** A file becomes
eligible only once its `size` and `mtime` are unchanged across two ticks (or its mtime is older
than `STABLE_AFTER_MS`). Without it a tick catches a half-copied file — copying Acme's 191 KB
PDF is not instantaneous — and on a cloud drive, a file that has appeared but not finished
syncing. A `path + size + mtime` in-memory cache keeps steady-state ticks to `stat()` only, so
the archive is never re-hashed every interval.

`POLL_INTERVAL_MS` is short in dev (a couple of seconds, so demos feel immediate) and longer in
production — one env var, same code.

Jobs are not 1:1 with files:

| kind | Raised by | Does |
|---|---|---|
| `scan_inbox` | the polling timer, or `POST /scan` | one sweep of the inbox; enqueues an `ingest` per eligible file and records a summary in `jobs.result` |
| `ingest` | a scan, or upload | full pipeline, first time |
| `reextract` | profile change, `PATCH docType`/`customerId` | re-extracts from stored `raw_text` |
| `reresolve_customer` | `npm run seed`, on a new/changed customer | re-matches the `unmatched` backlog, chains `reextract` on a hit |

Bulk reprocess fans out into **one job per document**, so each retries independently and
progress is observable.

### Mixing the two ingresses

Folder polling and `POST /documents` are both expected in normal operation — a PDF can land
in the synced folder *and* be uploaded by hand. Nothing special is needed:

- **Profile resolution never asks how the file arrived.** It is `(customer_id, doc_type)`
  either way, so the same customer and document type is handled identically.
  (Profiles are not writable over HTTP at all — they come from YAML. See "One writer".)
- **Dedupe is by content, not ingress.** The same bytes arriving both ways is **one** document
  and **one** job, so no second round of LLM calls. This works even though the two copies
  almost certainly have different filenames — verified: `contract.pdf` from the folder and
  `CloudShield Q4 signed.pdf` from the upload dedupe to a single row.
- **`ON CONFLICT (file_sha256) DO NOTHING` is required, not optional.** A poll tick and an
  upload can land the same bytes simultaneously; without it the loser raises a unique violation
  and the upload returns 500 for what is really a successful no-op. It returns `200` with
  `duplicate: true` instead — the same rule a re-dropped folder file follows.
- **`documents.ingress`** records `'poll'` or `'upload'`, and is **not** overwritten on a
  cross-ingress duplicate: the first arrival is the one that was actually processed. It answers
  "why did this document appear?" and surfaces one path quietly failing while the other works.

### Attempt and retry policy

A blanket retry count is the wrong instrument, because the two failure classes behave
differently and one of them costs money per attempt:

| `error_class` | Examples | Policy |
|---|---|---|
| `transient` | LLM 429 / timeout, DB connection drop, worker killed mid-job | retry up to the `MAX_ATTEMPTS` constant (3) with backoff via `run_after`: ~1s, 10s, 60s plus jitter |
| `permanent` | corrupt or password-protected PDF, zero extractable text (image-only scan), unclassifiable after LLM tiebreak | **no retry** — `status` is set to `'failed'` directly. Retrying re-bills the same LLM calls for an identical failure |

- **Per file, not per drop.** `attempts` lives on the job, and the sha256 dedupe means
  re-copying a failed PDF does **not** enqueue a second job — so a file cannot accumulate
  retries by being dropped repeatedly. The deliberate retry path is
  `POST /documents/:id/reprocess`, which resets `attempts` and enqueues fresh. Operator-driven,
  which is correct after a profile fix.
- **A modified file is a different sha256**, so it becomes a new document with its own job.
- **Crash recovery:** a `running` job whose `locked_at` is older than a timeout returns to
  `queued`. `attempts` was already incremented at claim time, so a worker crash-looping on one
  document cannot retry forever.
- **Terminal failure:** `documents.status='failed'`, the file moves to `failed/`, and
  `jobs.error` keeps the message.
- **LLM budget cap per document** (tracked in `extraction_runs.llm_calls`) so one pathological
  file cannot burn an unbounded number of calls inside a single attempt.

## Database schema

```sql
CREATE TYPE doc_type            AS ENUM ('order_form','purchase_order');
CREATE TYPE customer_resolution AS ENUM ('matched','ambiguous','unmatched','manual');
CREATE TYPE document_status     AS ENUM ('received','parsed','needs_classification',
                                         'extracted','needs_review','failed');

CREATE TABLE customers (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- how an issuer in the text maps to a customer; runtime-editable.
-- No `weight`: resolution is a COUNT, not a score — exactly one match wins,
-- two or more is `ambiguous` and gets flagged. Letting a heavier pattern win
-- silently would be guessing, which is rejected for currency and dates too.
CREATE TABLE customer_match_patterns (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- 'text' | 'signature_block' | 'doc_id'
  pattern     TEXT NOT NULL    -- regex source
);

-- append-only: a change inserts version+1, never mutates
CREATE TABLE extraction_profiles (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NULL REFERENCES customers(id) ON DELETE CASCADE,  -- NULL = base
  doc_type     doc_type NOT NULL,
  version      INT NOT NULL,
  definition   JSONB NOT NULL,
  content_hash TEXT NOT NULL,            -- lets the seeder tell whether the YAML changed
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON extraction_profiles (COALESCE(customer_id,0), doc_type, version);
CREATE UNIQUE INDEX ON extraction_profiles (COALESCE(customer_id,0), doc_type)
  WHERE is_active;

CREATE TABLE documents (
  id                      BIGSERIAL PRIMARY KEY,
  file_sha256             TEXT NOT NULL UNIQUE,       -- idempotency
  original_filename       TEXT NOT NULL,              -- stored, never used for logic
  page_count              INT,
  raw_text                TEXT,                       -- frozen: evidence offsets index into it
  doc_type                doc_type,                   -- NULL until classified
  doc_type_confidence     NUMERIC(4,3),
  doc_type_source         TEXT,                       -- 'classified' | 'manual'
  customer_id             BIGINT NULL REFERENCES customers(id),
  customer_resolution     customer_resolution,
  detected_issuer_name    TEXT,                       -- raw string, even when unmatched
  status                  document_status NOT NULL DEFAULT 'received',
  -- human review acknowledgement: a judgement about the record, not about its contents
  reviewed_at             TIMESTAMPTZ,
  reviewed_by             TEXT,
  review_note             TEXT,
  -- current extracted values
  start_date              DATE,
  end_date                DATE,
  amount                  NUMERIC(18,2),
  currency                CHAR(3),
  payment_terms_days      INT,                        -- 30; the brief's "Net 30" is an
                                                      -- output format, rendered at the API
                                                      -- boundary exactly like mm-dd-yyyy
  billing_frequency       TEXT,                       -- 'Annual' in Acme + both POs
  attributes              JSONB,                      -- profile-declared optional fields
  storage_key             TEXT,                       -- archive/<sha256>.pdf (via StorageAdapter)
  review_reasons          TEXT[],
  current_run_id          BIGINT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Both parties, both doc types. All four samples name buyer AND vendor, but with very
-- different completeness — POs label them under explicit headings, order forms bury the
-- vendor (Acme: signature block only, no address at all). Varying completeness becomes
-- NULLs here instead of columns scattered across three tables.
CREATE TYPE party_role AS ENUM ('buyer','vendor');

CREATE TABLE document_parties (
  document_id       BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role              party_role NOT NULL,
  name              TEXT,
  address           TEXT,              -- buyer's = the brief's "billing address"
  shipping_address  TEXT,              -- CloudShield only
  contact_name      TEXT,              -- Sarah Thompson
  contact_email     TEXT,              -- billing@technova.com
  contact_phone     TEXT,              -- +1 (512) 555-8900
  signature_present BOOLEAN,           -- buyer's = the brief's "customer signature"
  signer_name       TEXT,
  signer_title      TEXT,
  signature_date    DATE,
  PRIMARY KEY (document_id, role)
);
```
```sql
-- Acme order form — vendor has a name and a signature, no address anywhere in the document
(1,'vendor','Acme',                   NULL, …, true,'John Smith','CFO','2024-12-13')
(1,'buyer', 'Appsoft Inc.', '123 Main Street, New York, NY, USA', …, true,'Bob Lee','CEO','2025-01-02')
-- BrightOps PO — a vendor never signs a PO
(3,'vendor','DataPulse Software Inc.','789 Market Street, San Francisco, CA 94103, USA', …, NULL,NULL,NULL,NULL)
(3,'buyer', 'BrightOps Analytics Ltd.','42 King George Street, London, UK', …, true,'Emily Carter','VP Finance','2025-02-15')
```
```sql
-- 1:1 extensions holding only what is genuinely type-specific
CREATE TABLE order_form_details (
  document_id              BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  quote_number             TEXT NOT NULL,   -- Q-20702 / Q-78291
  quote_date               DATE,
  quote_expiration_date    DATE,
  proposed_by              TEXT,            -- Michael Chen (CloudShield)
  subscription_term_months NUMERIC(6,2),    -- 36.00 (CloudShield)
  master_agreement_ref     TEXT,            -- MSA No. 72845 dated 2023-06-22
  po_required              BOOLEAN,         -- CloudShield's own PO section
  po_number                TEXT,
  po_amount                NUMERIC(18,2)
);

CREATE TABLE purchase_order_details (
  document_id    BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  po_number      TEXT NOT NULL,   -- PO-BO-10458 / PO-NF-88219
  po_date        DATE NOT NULL    -- 02-15-2025 / 01-10-2025
);

CREATE TABLE document_items (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no         INT NOT NULL,
  product_name    TEXT,     -- nullable on purpose: if the table parse can't recover it,
                            -- the row's money still reconciles and is worth keeping.
                            -- NOT NULL would force dropping the row and break Σ items == amount
  quantity        NUMERIC(18,4),
  unit_price      NUMERIC(18,4),
  total_amount    NUMERIC(18,2),
  currency        CHAR(3),
  item_start_date DATE,
  item_end_date   DATE,
  attributes      JSONB,   -- profile-declared optional columns:
                           -- CloudShield's "Subscription Year", "Order Term (Months)"
  -- provenance for values that were NOT read directly off the page.
  -- Absent/empty ⇒ every value came straight from the document.
  field_sources   JSONB,   -- {"item_start_date":"filled_down",
                           --  "subscription_year":"inherited"}
  has_inferred    BOOLEAN GENERATED ALWAYS AS
                    (field_sources IS NOT NULL AND field_sources <> '{}'::jsonb) STORED,
  UNIQUE (document_id, line_no)
);
CREATE INDEX ON document_items USING GIN (attributes);
CREATE INDEX ON document_items (document_id) WHERE has_inferred;

-- Natural-language special terms. Present in all four samples under a literal
-- "Special Terms" heading. Burst may be item- or document-scoped (item_id), TAM is
-- always document-scoped.
CREATE TABLE special_terms (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id)      ON DELETE CASCADE,
  item_id     BIGINT NULL     REFERENCES document_items(id) ON DELETE CASCADE,
                                      -- NULL ⇒ document-scoped. No `scope` column:
                                      -- it would be pure duplication of this test
  term_type   TEXT NOT NULL,          -- TEXT not ENUM: new types need no migration.
                                      -- vocabulary: burst | technical_account_manager |
                                      -- free_trial | tiered_pricing | conversion_right |
                                      -- renewal_cap | credit | sla | unknown
  ordinal     INT,                    -- the "1." / "2." marker in the document
  -- parsed projection, written at extraction time
  percent     NUMERIC(6,3),
  cap_value   NUMERIC(18,2),
  cap_unit    TEXT,
  period      TEXT,                   -- subscription_year | 24_months | contract_year
  applies_to  TEXT,                   -- product as named in the prose
  -- the string as received: source of truth, never modified
  term_text   TEXT NOT NULL,
  attributes  JSONB,                  -- shape-specific extras, incl. at_no_cost
  page_no     INT
);
CREATE INDEX ON special_terms (document_id, term_type);
CREATE INDEX ON special_terms (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX ON special_terms (percent) WHERE term_type = 'burst';

-- Job queue. Postgres is the queue; no Redis.
CREATE TABLE jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,     -- ingest | reextract | reresolve_customer | scan_inbox
  document_id  BIGINT REFERENCES documents(id) ON DELETE CASCADE,  -- NULL for scan_inbox
  payload      JSONB,
  result       JSONB,             -- scan summary: found/enqueued/duplicate/unstable
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  attempts     INT  NOT NULL DEFAULT 0,          -- limit is a constant in code;
                                                 -- a permanent error sets status='failed'
                                                 -- directly rather than maxing out attempts
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- backoff
  error_class  TEXT,              -- 'transient' | 'permanent'
  error        TEXT,
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,              -- worker id, for debugging
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX ON jobs (status, run_after) WHERE status = 'queued';
-- the same work cannot be queued twice for one document
CREATE UNIQUE INDEX ON jobs (document_id, kind) WHERE status IN ('queued','running');
-- and at most one pending document-less job per kind, so hammering POST /scan
-- cannot pile up a hundred redundant sweeps
CREATE UNIQUE INDEX ON jobs (kind)
  WHERE document_id IS NULL AND status IN ('queued','running');
```

```sql
-- the worker claims one job; SKIP LOCKED is the idiomatic Postgres queue
UPDATE jobs SET status='running', locked_at=now(), locked_by=$1, attempts=attempts+1
WHERE id = (SELECT id FROM jobs
            WHERE status='queued' AND run_after <= now()
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

```sql
CREATE TABLE extraction_runs (
  id               BIGSERIAL PRIMARY KEY,
  document_id      BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  profile_id       BIGINT REFERENCES extraction_profiles(id),  -- pins the exact version row
  trigger          TEXT NOT NULL,  -- ingest|manual_reassign|profile_change|bulk_reprocess
  engine           JSONB,          -- {pdf:'pdfjs-dist@x', model:'claude-opus-5'}
  field_confidence JSONB,          -- per field: value, confidence, strategy, evidence span
  llm_calls        INT,
  outcome          TEXT NOT NULL,  -- ok|partial|failed
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX ON extraction_runs (document_id, started_at DESC);
```

Design notes worth defending in the README:
- `customer_id NULL` **is** the base-profile case — one lookup rule, no sentinel customer row
  polluting `customers`.
- `extraction_runs` carries confidence and evidence but **no duplicated field values**, so
  current-state queries stay a single join while history is still answerable.
- `NUMERIC` throughout for money; CloudShield's `22916.67` unit price × `1` reconciling to
  `275,000.00` only works without float error.
- **Why one `documents` table rather than `order_forms` + `purchase_orders`:** the brief's
  nine fields are identical for both types, so two tables would duplicate every one of them.
  More decisively, `doc_type` is unknown at insert time — `needs_classification` is a real
  state — so split tables leave an unclassified document with no home, and
  `PATCH /documents/:id {docType}` degrades from an `UPDATE` into a cross-table move dragging
  `document_items`, `special_terms` and `extraction_runs` with it. Type-specific fields still
  get real typed columns and `NOT NULL` constraints, in the 1:1 detail tables.
- **`document_items` is never split** — items are structurally identical across both types,
  so splitting them costs work and gains no constraint.
- **`special_terms.term_text` is the source of truth; the parsed columns are a projection
  of it.** They are written once at extraction, not derived per request: CloudShield's Burst
  paragraph contains 38.89%, 28.21% *and* 19.05%, so choosing the right one needs the item
  context that only the extraction stage has. ("First percentage" always yields 38.89%;
  "first money value" yields the `$275,000` Premium Support cap, not the 280,000-unit Burst
  cap.) Parsing per request would also make two reads of one row disagree, which would void
  the accuracy KPI. A wrong parse is corrected by reprocessing, never stuck.
- Typed columns are reserved for fields that recur across term types; one-off shapes
  (`4,000 active developers`, the `$39/$35/$31` tiers, the `$412,583.67` credit) go in
  `attributes` JSONB.

## Profile system

`extraction_profiles.definition` holds **locators + formats + strategies** — the field *list*
is fixed by the brief and lives in `config/fields/*.yaml` (it is the output contract, and
changing it changes DB columns, so it is code rather than runtime config).

What actually varies across the four samples:

| Field | Acme | CloudShield | BrightOps | NovaFleet |
|---|---|---|---|---|
| start date label | `Start Date:` | `Subscription Start Date:` | `Contract Start Date:` | `Contract Start Date:` |
| …format | `January 1, 2025` | `3/1/2025` | `03-01-2025` | `02-01-2025` |
| amount label | `Total fee:` | `Total Subscription Fee:` | `Total PO Amount:` | `Total PO Amount:` |
| …money format | `$152,500` | `USD 23,640,000.00` | `$162,000 USD` | `$451,000 USD` |
| payment terms | prose "thirty (30) days" | prose "forty-five (45) days" | `Net 30` | `Net 45` |
| billing address | `Bill To:` 1 line | `Bill to:` 1 line | `Billing Address:` +2 lines | `Billing Address:` +3 lines |
| signature test | 2-col block, buyer = right col | `Name: ____` blank → **false** | `✔ Signed` | `✔ Signed` |
| items table | 6 cols, `Rate`, `Jan 1,2025` | 8 cols, wrapped headers, `Year n` group rows | 6 cols, wrapped names | 6 cols |
| TAM wording | "Customer Support Manager and Product Architect" | absent → null | "Technical Account Manager" | "Senior Technical Account Manager" |
| Burst | 5%, prose | 38.89 / 28.21 / 19.05% per year, cap 280k | 10% per contract year | 15% annually |

Seeds, base plus deltas only:

```
config/customers.yaml                                        <- identity + match patterns, ONCE per customer
config/fields/{order_form,purchase_order}.yaml               <- the output contract (code, not config)
config/profiles/order_form/{_base,acme,cloudshield}.yaml     <- extraction deltas only
config/profiles/purchase_order/{_base,brightops,novafleet}.yaml
```

```yaml
# config/profiles/order_form/_base.yaml
doc_type: order_form
fields:
  start_date:
    labels: ["Start Date", "Subscription Start Date", "Contract Start Date"]
    input_formats: [long_month, slash_mdy, dash_mdy]
  amount:
    labels: ["Total fee", "Total Subscription Fee", "Total Price"]
  payment_terms:
    strategy: llm                 # prose by default on order forms
    sections: ["Payment Terms", "Terms and Conditions"]
items:
  column_synonyms:
    product_name: ["Name", "Product Name", "Subscriptions"]
    unit_price:   ["Rate", "Unit Price", "Monthly / Unit Price"]
    total_amount: ["Total amount", "Total Price"]
```

```yaml
# config/profiles/order_form/acme.yaml  — deltas only
extends: _base
fields:
  amount:     { labels: ["Total fee"], money_format: symbol_prefix, currency: USD }
  start_date: { labels: ["Start Date"], input_format: long_month }
  buyer_signature_present:
    strategy: two_column_signature
    buyer_column: right            # left column is Acme, the vendor
items:
  header: ["Name","Start Date","End Date","Rate","Quantity","Total amount"]
  date_format: short_month_compact  # "Jan 1,2025"
special_terms:
  tam: { synonyms: ["Customer Support Manager", "Product Architect"] }
```

```yaml
# config/profiles/order_form/cloudshield.yaml
extends: _base
fields:
  amount: { labels: ["Total Subscription Fee"], money_format: code_prefix }
  buyer_signature_present: { strategy: placeholder_lines }   # "Name: ____" ⇒ false
ignore_sections: ["Purchase Order Information"]              # blocks "PO Amount: USD 0.00"
items:
  header_rows: 2                   # wrapped headers
  carry_down: [subscription_year]  # sparse column: blank rows inherit from above
  wrapped_cells: true
```

The PO profiles are near-empty — POs are already structured. `purchase_order/brightops.yaml`
needs only `match` patterns plus
`billing_address: { strategy: multiline_after_label, max_lines: 2 }`.

### Special terms: same table, different extractor per document type

All four samples have a section headed literally `Special Terms`. Burst appears in 4/4;
TAM in 3/4 — **CloudShield has no TAM term**, which is why it must be nullable rather than
required. What differs is the *form*, so this is a profile concern, not a schema one:

POs use labelled bullets, read deterministically:
```
● Burst (Item Level): Up to 15% additional monitored workloads allowed annually without charge.
● Technical Account Manager: Vendor will assign a Senior Technical Account Manager…
```
```yaml
# purchase_order/_base.yaml
special_terms:
  strategy: labelled_bullets
  type_labels:
    burst: ["Burst (Item Level)", "Burst"]
    technical_account_manager: ["Technical Account Manager"]
```

Order Forms use numbered prose with **no labels at all** — nothing says "Burst" or "TAM", so
each paragraph is classified by meaning:
```
Special Terms
1. 2. During each consecutive 24 months … up to 5% more Billable Units in connection with
   SaaS subscription … (the "Burst Threshold"), at no additional cost.
   Customer will be assigned a Customer Support Manager and Product Architect
```
```yaml
# order_form/_base.yaml
special_terms:
  strategy: llm                 # classify each numbered paragraph into a term_type
  section: "Special Terms"
  unknown_type: unknown         # keep unclassified terms rather than dropping them
```

Two parsing quirks this has to survive, both visible above:
- Acme's `1.` and `2.` markers appear **before both paragraph bodies** in the PDF's text
  order, so `ordinal` must come from item positions, not reading order.
- Acme's TAM term never uses the phrase, hence `tam.synonyms` in its profile.

Burst attaches to an item by matching the prose product against the line items — "monitored
workloads" → `Advanced Threat Monitoring`. When that mapping is ambiguous, the row is written
with `item_id NULL` (document-scoped) and `applies_to` set, and the document flagged `needs_review`, rather
than guessing an item.

### Optional fields: profile-declared, stored in `attributes` JSONB

The brief's nine fields get typed columns; type-specific ones get typed columns in the detail
tables. Everything else a profile wants lands in `documents.attributes` or
`document_items.attributes`, so **adding an optional field is a YAML change, not a migration** —
and therefore editable at runtime through the profiles API, same as the drift flow.

What is sitting unclaimed in the samples:

| Optional field | Where it appears |
|---|---|
| `proposed_by` | CloudShield: `Michael Chen` |
| `marketplace` | CloudShield: `Azure Private Offer` |
| `vendor_signer_name` / `_title` / `_date` | Acme: `John Smith`, `CFO`, `12-13-2024` |
| `jurisdiction_note`, `tax_note` | Acme: GDPR/European regulations; "prices do not include taxes" |
| **item** `subscription_year`, `order_term_months` | CloudShield: `Year 1`–`Year 3`, `12.00` |

Two exceptions got promoted to typed columns rather than `attributes`: `billing_frequency`
(present in all four, CloudShield only in prose) on `documents`, and CloudShield's billing
contact name/email/phone plus shipping address, which are now real columns on
**`document_parties`** since they are properties of the buyer.

```yaml
# order_form/cloudshield.yaml
optional_fields:
  marketplace:              { labels: ["Azure Private Offer"] }
  subscription_term_months: { labels: ["Subscription Term (months)"], type: number }
items:
  optional_columns:
    subscription_year: ["Subscription Year"]
    order_term_months: ["Order Term (Months)"]
```

Values keep their natural JSON types; dates normalise to ISO strings via the same normalisers
as the typed columns. GIN index on both `attributes` columns. Confidence is **not** duplicated
here — `extraction_runs.field_confidence` is keyed by field path, so
`"attributes.marketplace": {value, confidence, strategy, evidence}` works unchanged.

**This also settles the scope of natural-language capture.** Prose outside the `Special Terms`
section (Acme's GDPR sentence, its tax note, CloudShield's Exhibit A definitions) is captured
only when a profile *declares* it as an optional field — never speculatively. `special_terms`
stays scoped to the `Special Terms` section, and `documents.raw_text` means nothing is lost
either way.

### A customer can issue both document types

`extraction_profiles` is keyed `(customer_id, doc_type, version)`, so one customer with
both an order form and a purchase order is simply two rows — **no schema change**. Verified
against the live DB: cloudshield + order_form and cloudshield + purchase_order coexist, both
active, while a *second* active profile for the same pair is rejected by the partial unique
index.

This is why customer identity lives in `config/customers.yaml` rather than inside each
profile file. Match patterns identify a **customer**, not a (customer, doc_type) pair — putting
them in per-doc-type files would duplicate the slug, display name and patterns across two
files that could then drift apart. The DB already reflects this: patterns hang off
`customers`, not off `extraction_profiles`.

Adding a customer that issues both types is therefore one `customers.yaml` entry plus two
small profile files, with nothing repeated.

### One writer: YAML → DB

The DB is not a second source of truth, it is a **projection**. Same relationship as source
code to a build artifact:

- `npm run seed` is the **only** writer of `extraction_profiles`. A YAML whose
  `content_hash` differs inserts `version+1` and activates it. No precedence rule is needed,
  because nothing competes.
- The pipeline reads **only** the DB, never YAML — so a profile change takes effect on
  `seed`, not on file save.
- Rows must still exist and be versioned: `extraction_runs.profile_id` has to point at an
  immutable record of the rules that produced each value. That requirement is independent of
  who writes them.
- `definition` stores the **merged** definition. The seeder resolves `extends: _base` once,
  so a row is self-contained — the audit never needs a second `base_profile_id` or a re-merge
  that might behave differently later. Editing `_base.yaml` therefore inserts a new version
  for every customer, which makes the blast radius visible rather than silent.

**Why not keep the config only in the DB?** Because the four customers' configuration has to
live in the repo in *some* form, or a fresh clone yields a service that does nothing until
someone makes a dozen API calls by hand. YAML is the most reviewable form of that bootstrap —
and the per-customer customisation is exactly what a reader of this repo wants to see.

**Why no `POST /customers/:slug/profiles`?** An earlier draft had one, plus a `source`
column and a `profiles:export` command to reconcile the resulting drift. All of that
machinery existed only to manage a *second writer* — remove the writer and it all goes. The
cost is that fixing a broken label means editing YAML and re-seeding rather than one HTTP
call; for a four-customer system with no ops team that is the right trade.

### Drift flow — CloudShield renames "Total Subscription Fee" → "Total Contract Fee"

1. Next PDF: issuer still matches, `amount` null → `status='needs_review'`.
2. `extraction_runs` shows profile v2, `amount` null, `detected_issuer_name` present.
3. Add the label to `config/profiles/order_form/cloudshield.yaml`; `npm run seed` inserts **v3** and activates it.
4. `POST /documents/reprocess?customer=cloudshield&status=needs_review` → re-extracts from
   stored `raw_text`.
5. Audit shows v2 → null, v3 → `23,640,000.00`. Nothing overwritten.

A renamed label is often better patched on `_base` (helps every customer); the API supports
either target.

## Normalisation: dates and currency

Every input shape converges on one DB representation. The symbol→code map and the format
registry are **constants in code** (`src/extract/normalize/`), unit-testable and type-safe;
only the *choice* of format per field is profile config.

### Dates → `DATE`, rendered `mm-dd-yyyy` at the API boundary

| `input_format` | Pattern | Seen in |
|---|---|---|
| `long_month` | `January 1, 2025`, `June 22, 2023` | Acme doc fields + quote dates, CloudShield prose |
| `short_month_compact` | `Jan 1,2025` — abbreviated, **no space after the comma** | Acme item table |
| `slash_mdy` | `3/1/2025` — not zero-padded | CloudShield everywhere |
| `dash_mdy` | `02-15-2025` | both POs, Acme signature block |

**The M/D vs D/M ambiguity is resolved by profile declaration, never inference.** Guessing
wrong silently shifts every CloudShield date. The documents themselves confirm M/D/Y —
`2/28/2028` and `1/20/2025` have a part > 12, and CloudShield's special term 2 spells out
"commencing on **March 1, 2025**", matching `3/1/2025`. Acme's `12-13-2024` likewise proves
mm-dd-yyyy *despite* its "applicable European regulations" sentence — precisely the detail
that would mislead a locale heuristic.

Rules:
- Profile declares `input_format`; if a value is ambiguous (both parts ≤ 12) and no format was
  declared → `needs_review`, never a guess.
- Reject impossible calendar dates (`02-30-2025`) rather than rolling them over.
- Cross-checks that catch a D/M mix-up: `start_date < end_date`, and item dates within the
  document's range.
- **Store `DATE`, not `TIMESTAMPTZ`** — these are calendar dates; a timestamp would shift them
  across timezones. The brief's `mm-dd-yyyy` is a *display* format, applied by one serialiser
  on the way out, so ordering and range queries still work in SQL.
- **Never `new Date(string)`** — its parsing is timezone-dependent and inconsistent across
  these shapes. Explicit regex → `{y,m,d}` → validated date.

### Money → `NUMERIC` + `currency CHAR(3)` (ISO 4217 code, never a symbol)

| `money_format` | Example | Seen in |
|---|---|---|
| `symbol_prefix` | `$50,000` | Acme (all), both POs (items) |
| `code_prefix` | `USD 7,020,000.00` | CloudShield table + total |
| `code_suffix` | `$162,000 USD` — symbol **and** code | both POs (totals) |

Documents **mix shapes internally**: BrightOps items are `$72,000` while its total is
`$162,000 USD`; CloudShield's table is `USD 7,020,000.00` while its prose says `$275,000` and
`$412,583.67`. So `money_format` is per *field*, not per document.

`$` is ambiguous (USD/CAD/AUD/NZD/SGD/HKD/MXN). NovaFleet is the sharp case: its buyer is in
**Toronto, Canada**, so a geographic guess yields CAD — but its total reads `$451,000 USD`.
Resolution precedence:

1. **Exactly one** distinct ISO code in the document → use it. Resolves BrightOps' and
   NovaFleet's `$` items from their `… USD` totals, and all of CloudShield. More than one
   distinct code → do **not** infer; flag `AMBIGUOUS_CURRENCY`.
2. Otherwise the profile's `default_currency` → covers Acme, which has no code anywhere.
3. Otherwise `needs_review`. **Never** infer from an address.

Unambiguous symbols map directly (`€`→EUR, `£`→GBP, `¥`→JPY, `₪`→ILS) from a frozen
`SYMBOL_TO_CODE` constant with an explicit `AMBIGUOUS_SYMBOLS` set.

Other money details: strip thousand separators before parsing; `unit_price NUMERIC(18,4)` to
hold CloudShield's `3.25` and `22916.67` (3.25 × 180,000 × 12 = 7,020,000.00 exactly, which
only reconciles without float error); totals `NUMERIC(18,2)`. If a customer ever emits
European number formatting (`1.234,56`), the profile gains a `number_locale` option rather
than the parser guessing.

**Raw forms are not duplicated into columns.** The original strings (`$162,000 USD`,
`3/1/2025`) are kept as the evidence span in `extraction_runs.field_confidence`, reachable via
`documents.current_run_id` — the same decision already made for `payment_terms` provenance.

## Missing item values: inheritance, fill-down, and marking

Three distinct cases, deliberately not collapsed into one flag — the first is not a guess:

| Order | Source | `field_sources` label | Flags review? |
|---|---|---|---|
| 1 | group-row header above the item | `inherited` | **no** — deterministic |
| 2 | previous item row | `filled_down` | yes |
| 3 | document-level equivalent | `from_document` | yes |
| 4 | nothing found | value stays `NULL` | yes |

**Case 1 is structural, not inferred.** CloudShield's reconstructed table (phase 0 output,
`·` = empty cell):
```
y=661  Year 1 | CloudShield Enterprise | 3/1/2025 | 2/28/2026 | 12.00 | 3.25     | 180000 | USD 7,020,000.00
y=631    ·    | Premium Support        | 3/1/2025 | 2/28/2026 | 12.00 | 22916.67 | 1      | USD   275,000.00
y=601  Year 2 | CloudShield Enterprise | 3/1/2026 | 2/28/2027 | 12.00 | 3.25     | 195000 | USD 7,605,000.00
```
`Year 1` is a cell **in the first data row**, in a sparse column declared by the profile's
`carry_down: [subscription_year]`. The Premium Support row's value is *defined* by the row
above it, so labelling it a suggestion would overstate the doubt — and flagging it would put
all six CloudShield items in the review queue on every run, making the queue worthless.

**Case 2 DOES occur — phase 0 disproved the earlier claim.** `subscription_year` is blank on
all three CloudShield Premium Support rows and must be inherited from the Enterprise row above:

```
y=661  Year 1 | CloudShield Enterprise | 3/1/2025 | ... | USD 7,020,000.00
y=631    ·    | Premium Support         | 3/1/2025 | ... | USD   275,000.00   <- inherits "Year 1"
```

Note this is **not** a group header row — `Year 1` is a cell *in the first data row*, in a
sparse column. So the mechanism is carry-down within a column, and it is exercised by real
data rather than only by a synthetic fixture.

### Fill-down is automatic, with a four-field deny-list

No per-customer declaration needed, so an unrecognised fifth customer benefits immediately.
These four are **never** filled down, whatever a profile says:

| Blocked field | Why |
|---|---|
| `product_name` | Fill-down would *mask* a table-parsing bug rather than surface it — producing a plausible duplicate "CloudShield Enterprise" row that reads as real data. Blank can also genuinely mean "none". The column is deliberately **nullable** so an unrecoverable name leaves a flagged `NULL` while the row's money still reconciles |
| `quantity`, `unit_price`, `total_amount` | Filling these down would make `sum(items.total_amount) == amount` pass against fabricated numbers, destroying the one check that currently validates all four samples end to end. |

A missing value in any of the four stays `NULL` and flags review. A profile may opt an
individual field *out* of fill-down, or opt one of the blocked fields *in* if a customer
genuinely uses a "same as above" convention.

The guiding principle: **marking makes a guess auditable, not safe.** A consumer running
`SELECT product_name, quantity FROM document_items` gets a fabricated value with no signal
unless it also checks `has_inferred` — so the flag is a safety net for the recoverable fields,
not a licence to invent the ones that define what an item is and what it costs.

## Table reconstruction (`pdf/tables.ts`)

A PDF has no notion of a table — only text fragments at coordinates. CloudShield's 8-column
table in reading order shows every problem at once:

```
Subscription
Year  Subscriptions  Start Date  End Date
Order Term
(Months)
Monthly /
Unit Price
**
Quantity of
Billable
Units***
Total Price
Year 1
CloudShield
Enterprise
3/1/2025  2/28/2026  12.00  3.25      180000  USD 7,020,000.00
Premium
Support  3/1/2025  2/28/2026  12.00  22916.67  1  USD 275,000.00
```

| # | Problem | Evidence above |
|---|---|---|
| 1 | **Headers shredded across lines** | `Monthly /` + `Unit Price` + `**` are three lines forming one column header. Only x coordinates reveal they belong together |
| 2 | **Wrapped cells collide with data** | `Premium` sits alone; `Support` shares its line with the whole rest of the row — a line-based parse yields a product called "Support" and loses "Premium" |
| 3 | **Two inconsistent row shapes** | Row 1's data line has **no** product text; row 2's data line **starts** with its product name's tail |
| 4 | **Group headers look like rows** | `Year 1`/`2`/`3` populate one column and supply `subscription_year` to the rows beneath |
| 5 | **Currency is not a column** | The header declares 8 columns and currency isn't one, so `USD 7,020,000.00` is a single Total Price cell |

### Finding: cluster on the baseline, not the glyph box

Verified experimentally during planning against the real PDF. Grouping rows by glyph bounding
box fails, because descenders sit lower than x-height characters:

```
y=703 [75]Subscri    y=701 [104]p    y=703 [109]tion
```

Every word containing `p`, `y`, `g`, `q`, `j` shatters. **`pdfjs-dist` is the right library
partly for this reason** — `transform[5]` on a text item is the *baseline*, which is stable
across ascenders and descenders. (The macOS PDFKit route used for inspection returns per-glyph
boxes and is unsuitable; it is not part of the service.)

### Algorithm — VERIFIED in phase 0 against all four samples

`pdfjs-dist` returns **assembled word runs** with `transform[4]`=x and `transform[5]`=the
true **baseline**, which eliminates the descender problem entirely. Confirmed: "Subscription"
y=703, "Year" y=691, no glyph-box noise.

1. **Discover columns from DATA rows only**, clustering run-start x with an 18pt gap threshold.
   **Never include the header** — header fragments are offset from their columns, and including
   NovaFleet's header invented a phantom 7th column.
2. **Find anchor rows**: y-levels populating ≥4 distinct columns. These are the real data lines.
3. **Band half-width = 1.2 × the MEDIAN gap between consecutive y-levels.** Not the row pitch.
4. **Assign every item to its nearest anchor** within that band, then to a column by x.
5. **Join multi-fragment cells** top-to-bottom, left-to-right.
6. **Assemble the header column-first** over the header's y-range, using the data columns.

Result: 19 of 19 item rows recovered across the four documents, and **all four reconcile
exactly** against their stated totals (152,500 / 23,640,000 / 162,000 / 451,000).

### What phase 0 corrected

Four things in the pre-spike design were wrong:

| Was | Actually |
|---|---|
| **"Pending prefix": wrapped names precede the data line** | ✗ Names **bracket** it. CloudShield row 1 is `y=667 "CloudShield"` / `y=661 <data>` / `y=655 "Enterprise"`. The prefix rule would have mis-assigned "Enterprise" to the *next* row. Nearest-anchor assignment handles both this and BrightOps' name-starts-on-the-data-line layout |
| **`group_rows: '^Year \d+$'` matches separate group header rows** | ✗ There are **no group rows**. `Year 1` sits at x=87.2 *in the data row itself* — it is a **sparse column** whose value carries down to the rows beneath. The regex would have matched nothing |
| **Band = row pitch / 2** | ✗ Pitch is **not uniform** — a wrapped product name makes one row taller (BrightOps page 2: 40.4 then 26.2) — and a page holding one row has no pitch at all. That orphaned `Enterprise`. Median line gap adapts: 17.5pt for BrightOps, 7.2pt for CloudShield |
| **Fill-down never occurs in the samples** | ✗ It **does**. `subscription_year` is blank on all three CloudShield Premium Support rows and must be inherited from the Enterprise row above. So the `inherited` path is exercised by real data, not only by a synthetic fixture |

### Also found: tables span pages

**Both POs continue across a page break**, and the header appears only on the first page:

| Document | Rows |
|---|---|
| BrightOps | 1 at the foot of page 1 (y=131), 3 at the head of page 2 (y=704, 663, 637) |
| NovaFleet | 2 on page 1 (y=117, 90), 2 on page 2 (y=704, 677) |

So reconstruction operates over a **list of page regions**, not one page, and the column map
learned from the first region carries to the continuation. Nothing in the pre-spike design
accounted for this.

**Reconstruction stays self-checking.** If it goes wrong, `Σ items == amount` breaks on
documents where it currently holds exactly — which is why `product_name` must never fill down.

Spike code kept in `spike/` as the record of this verification.

## LLM extraction contract

Model **`claude-opus-5`** (id in config so the accuracy harness can compare). Verified against
the bundled Anthropic SDK reference, not recalled — three current-API points that contradict
older patterns:

| ⚠️ | Why it matters here |
|---|---|
| **No `temperature` / `top_p` / `top_k`** | Removed on Opus 5 / Sonnet 5 — passing them returns **400**. Determinism for tests comes from the fixture cache, not from `temperature: 0` |
| **No `budget_tokens`** | Also 400 on Opus 5. Thinking is adaptive and on by default — omit `thinking` entirely; control depth with `output_config.effort` |
| **Structured outputs ✗ citations** | `output_config.format` + `citations` returns **400**, so the native `start_char_index` citation feature cannot be combined with schema-guaranteed JSON |

### Call plan — one call per section

Two calls for a typical document, three when classification is close:

| Call | Input | Schema |
|---|---|---|
| `payment_terms` | the `Payment Terms` / `Terms and Conditions` section only | `{ value: "Net 45", quote }` |
| `special_terms` | the `Special Terms` section only | array of `{ term_type, percent?, cap?, period?, applies_to?, quote }` |
| `doc_type` tiebreak | page-1 text, only when `|score_of − score_po| < 3` | `{ doc_type, quote }` |

Sections come from the `sections` the profile already declares, so only relevant text is sent —
CloudShield's special terms are ~1,500 words against eight pages of document.

```ts
const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 4096,
  system: [{ type: "text", text: profileInstructions,
             cache_control: { type: "ephemeral" } }],   // stable prefix first
  messages: [{ role: "user", content: sectionText }],   // volatile content last
  output_config: { format: zodOutputFormat(SpecialTermsSchema), effort: "medium" },
  betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
});
if (res.stop_reason === "refusal") { /* → needs_review, no partial write */ }
```

- `client.messages.parse()` + `zodOutputFormat` gives schema-validated output. Note the SDK
  strips unsupported JSON-Schema constraints (`minimum`, `maxLength`) and validates them
  client-side, so numeric bounds live in our own zod refinements.
- `effort: "medium"` for payment terms, **`"high"` for order-form special terms** — CloudShield's
  Burst paragraph is the hardest field in the set. Tunable per call; the accuracy harness sweeps it.
- **Server-side `fallbacks` is enabled by default** per SDK guidance, and `stop_reason: "refusal"`
  is checked before reading content.
- **Prompt caching:** render order is `tools` → `system` → `messages`, so the profile
  instructions sit in `system` behind a `cache_control` breakpoint and the document text goes
  last. Verified via `usage.cache_read_input_tokens` — if it stays 0, something in the prefix
  varies per request. The minimum cacheable prefix is 512–4096 tokens depending on model, so a
  short system prompt may legitimately never cache.

### Evidence: the model quotes, we verify, we resolve the offsets

Every schema is `{ value: T | null, quote: string | null, not_found_reason?: string }`, and the
prompt instructs **returning `null` rather than guessing** — an explicit null is far better
signal than a confident-looking wrong answer. Then two deterministic checks:

```ts
// 1. does the quote actually appear in the document?
const ev = resolver.resolve(quote);                  // src/llm/evidence.ts
if (ev === null) return reject(field, "LLM_EVIDENCE_MISMATCH");

// 2. is the value supported by the text it cited?
if (!valueAppearsIn(quote, value)) return reject(field, "VALUE_NOT_IN_EVIDENCE");

evidence = { page, start: ev.start, end: ev.end, text: ev.text };
```

⚠️ **A naive `rawText.indexOf(quote)` produces false rejections of *correct*
extractions** — worse than having no check. Two causes, both verified present in the samples:

| Cause | Evidence |
|---|---|
| **Line breaks** | Acme's payment clause is laid out `"Payment shall be\nmade within thirty (30) days from invoice."` A model returns it as one line, and `indexOf` returns **-1**. That is one of the six numeric NL fields, so the check would have failed on 1-in-6 of them |
| **Typography** | Acme uses curly quotes (U+201C/D) around `(the "Burst Threshold")`; CloudShield uses an en-dash (U+2013). Models return ASCII equivalents |

So matching runs against a **normalised copy** — whitespace runs collapsed, curly quotes,
dashes and fixed-width spaces folded to ASCII — while an index map returns offsets into the
**original**. The stored evidence is therefore always the document's real characters, newline
and curly quotes included.

One more rule: **an ambiguous quote is not a match.** `"Premium Support"` appears on four
separate CloudShield line items, so a quote occurring more than once resolves to `null` rather
than silently attaching evidence to the wrong part of the document.

Covered by `tests/unit/evidence.test.ts` against the real extracted text of both order forms.

Offsets computed by our own code against the `raw_text` we stored are stronger evidence than
offsets handed to us, and the `indexOf` failure **is** the hallucination check from the error
handling section. Native citations (`char_location` with `start_char_index`) are a **phase-6
experiment only** — they would have to replace structured outputs, so the combination needs
proving before it's relied on.

### Cost

~2 calls per document, ~3,300 input and ~800 output tokens each → **~$0.15 for all four
samples, ~$0.04 per new document** at Opus 5's $5/$25 per MTok. Tracked per run in
`extraction_runs.llm_calls` plus token counts.

PDF-direct input (`{type:"document", source:{type:"base64", media_type:"application/pdf"}}`) is
noted as the mitigation for assumption A4 — it would let Claude's vision handle a scanned
document with no text layer, without changing the rest of the pipeline.

## Project layout

```
src/
  entrypoints/api.ts        HTTP only; enqueues jobs, returns 202
  entrypoints/worker.ts     polling timer + job loop
  config/env.ts             zod-validated env
  db/{pool.ts,migrations/*.sql,repositories/*.ts}   incl. jobs repo (SKIP LOCKED claim)
  storage/                  StorageAdapter · LocalFsAdapter · S3Adapter (prod)
  jobs/{enqueue.ts,loop.ts,retry.ts}   error classification + backoff
  pdf/parse.ts              pdfjs-dist → text + positioned items
  pdf/tables.ts             rows/cols from positions: wrapped cells, group rows
  classify/docType.ts       weighted signals + LLM tiebreak
  classify/issuer.ts        DB match patterns, incl. signature-block scope
  profiles/{schema.ts,loader.ts,seed.ts,resolve.ts,export.ts}
  extract/engine.ts         orchestrates per-field strategies
  extract/strategies/       labelValue · multilineAfterLabel · signatureBlock
                            (two_column | placeholder_lines | checkmark) · itemsTable · llmField
                            specialTerms (labelled_bullets | llm) · burstAttribution
  extract/normalize/        date.ts · money.ts · netTerms.ts (word-number parser)
  extract/validate.ts       items sum vs amount, date ordering, required fields
  llm/client.ts             live | fixture | record modes
  llm/prompts/
  poller/{loop.ts,scan.ts}  chained setTimeout · stat/size/mtime stability gate
                            · sha256 dedupe → enqueue
  api/{server.ts,routes/*}  Express + express-openapi-validator + swagger-ui-express
openapi.yaml                hand-written spec: served at /docs, enforced at runtime
accuracy/{expected/*.json,score.ts}
tests/{unit,integration,accuracy}/ + tests/fixtures/llm/*.json
config/{fields,profiles}/
docker-compose.yml  .env.example  .nvmrc  README.md
```

`pdfjs-dist` for parsing: pure JS, no system binaries, resolves the subset-font `ToUnicode`
maps correctly, and crucially returns **per-item x/y** — required for Acme's two-column
signature block and CloudShield's wrapped 8-column table. (The macOS PDFKit route used to
read the samples during planning is not portable and is not part of the service.)

## REST API

No UI in scope — the brief's deliverable is "Github repo with Code, Readme". A small
read-only HTML page over this API is noted as a **stretch goal only**, not a phase.

All mutations enqueue a job and return `202 Accepted` with a job id — nothing parses inside
an HTTP handler.

### Ingest

```
POST  /documents            multipart, 1..N files via repeated -F file=@…
                            → 202 when all queued, 207 Multi-Status when some rejected
                            → always an array of per-file results
POST  /scan                 sweep the inbox now instead of waiting for the timer
                            → 202 + job id;  ?wait=<ms> blocks until done, then 200
GET   /jobs/:id             status, attempts, error_class, result
```

`POST /scan` enqueues a `scan_inbox` job rather than scanning inline: the worker owns the inbox
and the stability-gate state, and the API must not duplicate that logic or need a filesystem
mount. The worker's claim loop picks it up immediately, so latency is a loop tick, not a poll
interval. `jobs.result` then carries the summary:

```jsonc
{ "found": 5, "enqueued": 3, "duplicate": 1, "unstable": 1 }   // 'unstable' = still being written
```

`?wait=<ms>` long-polls until the job finishes and returns the summary directly — which is what
makes integration tests deterministic without sleeping on a timer, and makes the demo immediate.
A partial unique index caps pending document-less jobs at one per kind, so repeated calls
coalesce instead of queueing redundant sweeps.

One endpoint for one *or* many: a single upload is simply an array of one. Per-file results
matter because one bad file must not fail the rest:

```jsonc
207 Multi-Status
[ { "file": "a.pdf",      "status": "queued",    "jobId": 17, "documentId": 4 },
  { "file": "b.pdf",      "status": "duplicate", "documentId": 2 },
  { "file": "notes.docx", "status": "rejected",
    "error": "not a PDF (missing %PDF- header)" } ]
```

Before anything is enqueued: **magic-byte check** (`%PDF-`; Content-Type is client-supplied
and lies) → `415`; **size cap** `MAX_UPLOAD_BYTES` → `413`; **stream to temp while hashing**,
so the sha256 comes free and a large PDF never sits in memory. A duplicate sha256 returns
`200` with the existing document and enqueues nothing — identical to what a poll tick does with
a re-dropped file, so there is one rule, not two.

Uploads write **straight to the archive via `StorageAdapter`, never into `inbox/`** — writing
there would make the next poll tick pick it up too and double-enqueue. The client filename is kept only as
`original_filename` metadata and never used to build a path (the key is always
`archive/<sha256>.pdf`), so `../../etc/passwd` as a filename is inert by construction.

### Correct one document — routing only

```
PATCH /documents/:id        { customerId? , docType? }  → 202 + job id
                            ?reextract=false for a metadata-only edit
POST  /documents/:id/reprocess                          re-extract unchanged
POST  /documents/:id/review { by, note }                clears needs_review
```

**Only these three are human-writable, and none of them writes an extracted value:**

| Writable | What it is | Recorded as |
|---|---|---|
| `customer_id` | routing — which profile applies | `customer_resolution = 'manual'` |
| `doc_type` | routing — which field definitions apply | `doc_type_source = 'manual'` |
| review acknowledgement | "I looked, it's correct" | `reviewed_at`, `reviewed_by`, `review_note` |

The first two change the **input** to extraction, not its output — re-extraction then
regenerates every field with fresh evidence, so even a manual override never yields an
unevidenced value. The third records a judgement about the *record*, not a claim about the
document, and exists because otherwise `needs_review` would fill with already-approved
documents and stop being useful.

**Never writable:** `amount`, `currency`, `start_date`, `end_date`, `payment_terms_days`,
every `document_parties` column, every `document_items` column, every
`special_terms` row, and both `attributes` columns. Those come only from an extraction run.
A wrong value means the *definition* is wrong — so the fix is a profile change, which repairs
every affected document rather than one.

### Correct many — the real fix

```
POST  /documents/reprocess?customer=&status=&profileVersion=

Customers and profiles are **not** writable over HTTP — they come from YAML. Registering a
new customer is: edit `config/customers.yaml` → `npm run seed`, which enqueues
`reresolve_customer` so the `unmatched` backlog re-resolves against the new patterns.
```

`PATCH` is the one-off escape hatch; registering the customer is the fix that scales. For an
unknown issuer the flow is: `GET /documents?resolution=unmatched` → read
`detected_issuer_name` → either `PATCH` that one document (and add a pattern so it stops
recurring), or add them to `config/customers.yaml` and re-seed, which repairs the whole backlog at once.

### Inspect

```
GET /health
GET /documents?status=&resolution=&docType=&customer=&hasInferred=&page=
GET /documents/:id          fields + type details + items + special terms + latest run
GET /documents/:id/runs     audit history
GET /documents/:id/trace    every field with the exact text it came from
GET /documents/:id/file      the original PDF, via StorageAdapter
GET /special-terms?type=burst&minPercent=20&scope=
GET /customers
GET /customers/:slug/profiles   version history
```

### OpenAPI: hand-written, spec-first, enforced

`openapi.yaml` lives in the repo and is the **contract**, not documentation written afterwards:

- Served at **`/docs`** via `swagger-ui-express`; raw spec at `/openapi.json`.
- **Enforced at runtime** by `express-openapi-validator`, which validates requests *and*
  responses against the spec. A handler returning an undeclared field fails the test suite, so
  the hand-written spec cannot silently drift from behaviour.
- **Linted in CI** (`spectral lint openapi.yaml`) to catch a malformed spec before it ships.
- A **contract test** exercises all 16 endpoints against the spec.
- Every endpoint carries a worked example taken from the four real samples — the `207`
  multi-status batch response, CloudShield's `trace` output with real offsets, the
  unmatched-issuer `PATCH` flow.

Useful side effect: Swagger UI renders a real file-picker for the multipart upload, so the four
sample PDFs can be submitted from a browser and the results browsed interactively. That covers
much of what the deferred UI would have provided, for no extra code.

## Validation

Six layers, each catching what the others cannot:

| Layer | Where | Enforces |
|---|---|---|
| 1. HTTP input | `openapi.yaml` + `express-openapi-validator` | magic bytes `%PDF-` → `415`, size cap → `413`, `customerId` exists, slug format, **match patterns must compile as regexes** |
| 2. Profile config | zod, at seed **and** at API insert | known strategy/format names, `extends` resolves, `default_currency` is valid ISO 4217, **strict mode rejects unknown keys** so `labells:` fails loudly instead of being ignored |
| 3. Per-field output | `extract/validate.ts` | real calendar dates **within a plausible window** (1990–2050, configurable — `01-01-1900` is a valid date and a certain parse slip), `payment_terms_days` a positive integer (a term that isn't Net-shaped → `NULL` + flag), `quantity >= 0`, required-per-type (`quote_number` on order forms; `po_number` + `po_date` on POs) |
| 4. Cross-field reconciliation | same | the money, term and date-envelope checks below |
| 5. DB constraints | migrations | **formats and structure only** — see the policy below |
| 6. Severity | job outcome | `warn` → persist + `needs_review` + a `review_reasons` code; `info` → run log only. **Validation never blocks persistence** |

### DB constraints encode our own encoding, never assumptions about the world

A `CHECK` violation aborts the transaction and discards *everything* — so a constraint that
encodes a guess about the real world turns one odd value into total data loss. `CHECK (amount
>= 0)` was in an earlier draft and is exactly that mistake: **a credit line is legitimate**
(CloudShield itself carries a `$412,583.67` credit, in prose here but a future customer could
put one in the table), and that constraint would discard an entire correct extraction over it.
Same trap as the strict item arithmetic that would have flagged CloudShield on every run.

| Stays a `CHECK` | Demoted to a validation warning |
|---|---|
| `currency ~ '^[A-Z]{3}$'` | `amount >= 0` → `NEGATIVE_AMOUNT` |
| `payment_terms_days > 0` (a format fact now, not a value guess) | `end_date >= start_date` → `DATE_RANGE_REVERSED` |
| `document_parties` PK `(document_id, role)` | `quantity < 0` → `NEGATIVE_QUANTITY` |
| FKs, unique indexes | |

The rule: if a **format** check fails, *our normaliser* is broken and it should be loud. If a
**value** check fails, the world is messier than we assumed and it should be flagged, not fatal.
`quantity = 0` is allowed with no flag at all — a bundled or no-charge line is plausible and it
reconciles (`0 × price = 0`). A negative quantity only warns, because a misparsed sign is caught
far more reliably by the `ITEM_ARITHMETIC` check than by a sign test.

### `review_reasons` vocabulary

A fixed enum, so the review queue is filterable (`GET /documents?reason=TOTAL_MISMATCH`):

`TOTAL_MISMATCH` · `ITEM_ARITHMETIC` · `MISSING_REQUIRED_FIELD` · `NO_ITEMS_FOUND` ·
`DATE_OUT_OF_RANGE` · `DATE_RANGE_REVERSED` · `DATE_ENVELOPE_MISMATCH` · `NEGATIVE_AMOUNT` ·
`NEGATIVE_QUANTITY` · `MIXED_CURRENCY` · `AMBIGUOUS_CURRENCY` · `INFERRED_VALUES` ·
`UNMATCHED_CUSTOMER` · `AMBIGUOUS_CUSTOMER` · `BURST_UNATTRIBUTED` ·
`LLM_EVIDENCE_MISMATCH` · `VALUE_NOT_IN_EVIDENCE` · `FIELD_NOT_FOUND`

Note there is no `LOW_CONFIDENCE` — see below.

### No confidence threshold: deterministic checks instead

A model-emitted `"confidence": 0.95` is not a probability. It is a token generated because it
looked plausible, not something derived from logprobs, and in practice models emit round high
numbers largely irrespective of correctness. Thresholding it would mostly filter nothing, and
when it did fire you could not tell genuine doubt from phrasing. So **nothing is gated on it.**

What makes this affordable is that contracts are full of arithmetic, so the data largely checks
itself — `Σ items == amount`, per-item arithmetic, the date envelope, the stated term length,
and `indexOf` for the evidence quote are all objective. The only fields with no independent
cross-check are the pure-prose ones: `payment_terms`, Burst percentages, TAM.

**Those get verified against their own quote.** The extracted number must actually appear in the
text the model cited:

| Field | Value | Its quote | Found |
|---|---|---|---|
| Acme payment terms | `Net 30` | "made within **thirty (30) days** from invoice" | ✓ `30` |
| CloudShield payment terms | `Net 45` | "within **forty-five (45) days** of Customer's receipt" | ✓ `45` |
| Acme burst | `5` | "up to **5%** more Billable Units" | ✓ |
| CloudShield burst | `38.89` | "during Year 1, up to **38.89%**" | ✓ |
| BrightOps burst | `10` | "by up to **10%** per contract year" | ✓ |
| NovaFleet burst | `15` | "Up to **15%** additional monitored workloads" | ✓ |

**100% of the LLM-extracted numeric fields in the sample set.** Not luck either — legal drafting
writes "thirty (30)" precisely to be unambiguous, so the numeral sits beside the word. A model
answering `Net 30` while quoting the forty-five-day clause is caught by a regex rather than a
vibe.

So the flagging triggers are, in order:

1. Quote absent from `raw_text` → reject the value, `LLM_EVIDENCE_MISMATCH`
2. Value not derivable from its own quote → `VALUE_NOT_IN_EVIDENCE`
3. Any reconciliation failure → its own code
4. A required field returned `null` → `FIELD_NOT_FOUND`

Confidence is still **recorded** in `extraction_runs.field_confidence` — it is free, and the
accuracy harness can report whether it correlates with real errors. It simply never triggers
anything.

### Reconciliation, verified against all four samples

**Document total = Σ items** — exact everywhere, and the single most valuable check:

| | Σ items | Stated |
|---|---|---|
| Acme | 50,000+60,000+25,000+12,500+5,000 | **152,500** ✓ |
| CloudShield | 7,020,000+275,000+7,605,000+275,000+8,190,000+275,000 | **23,640,000** ✓ |
| BrightOps | 72,000+78,000+6,000+6,000 | **162,000** ✓ |
| NovaFleet | 120,000+132,000+145,000+54,000 | **451,000** ✓ |

**Term length = date range** — an independent second check: CloudShield states `36.00` months
and `3/1/2025 → 2/28/2028` is 36; Acme's Burst term says "each consecutive 24 months" and
`01-01-2025 → 12-31-2026` is 24.

**Document dates = item envelope** — a third check, and it needs no per-customer config:

| | `min(item_start)` → `max(item_end)` | Stated document dates |
|---|---|---|
| Acme | 01-01-2025 → 12-31-2026 | 01-01-2025 → 12-31-2026 ✓ |
| CloudShield | 03-01-2025 → 02-28-2028 | 03-01-2025 → 02-28-2028 ✓ |
| BrightOps | 03-01-2025 → 02-28-2027 | 03-01-2025 → 02-28-2027 ✓ |
| NovaFleet | 02-01-2025 → 01-31-2028 | 02-01-2025 → 01-31-2028 ✓ |

Exact on all four, so a mismatch is real signal that one side was misread →
`DATE_ENVELOPE_MISMATCH`. It doubles as a **fallback**: if the document states no start/end
date, derive them from the envelope and record `field_sources: 'from_items'` — the
`from_document` mechanism running in the opposite direction — then flag for review rather than
leaving a usable answer as `NULL`.

### Mixed currencies in one document

Representable already, since `currency` is per row on both `documents` and `document_items`.
Two things need handling:

- **Reconciliation groups by currency.** `Σ items == amount` is meaningless across currencies —
  USD and EUR cannot be added. Subtotals are compared per currency, and the document-total
  comparison is skipped with `MIXED_CURRENCY` when the total's currency doesn't cover every item.
- **Resolution rule tightened.** Rule 1 was "an explicit ISO code anywhere in the document wins",
  which silently picks the wrong one when two codes appear. It becomes: **exactly one** distinct
  ISO code in the document → use it; more than one → do not infer, flag `AMBIGUOUS_CURRENCY`.
  All four samples contain exactly one distinct code (USD), so rule 1 still fires on every one.

### Per-item arithmetic: profile-declared formula + tolerance

`quantity × unit_price == total_amount` holds for Acme, BrightOps and NovaFleet but **fails for
CloudShield**, which prices per month. A strict check would send a perfectly-extracted
CloudShield document to the review queue on every run — the worst class of validation bug.

```yaml
# order_form/_base.yaml
items:
  reconcile: quantity * unit_price
  tolerance: 0.01

# order_form/cloudshield.yaml
items:
  reconcile: quantity * unit_price * order_term_months
  tolerance_pct: 0.5        # unit price is rounded to 2dp per the document itself
```

| Check | |
|---|---|
| Acme `100 × 250` | 25,000 ✓ |
| NovaFleet `3 × 18,000` | 54,000 ✓ |
| CloudShield Enterprise `180,000 × 3.25 × 12` | 7,020,000 ✓ exact |
| CloudShield Premium Support `1 × 22,916.67 × 12` | 275,000.**04** vs stated 275,000.00 — `|diff| 0.04` inside 0.5% ✓ |

The four-cent gap is explained by the document: *"the Monthly/Unit Price shown above has been
rounded to two decimal places for display purposes. The totals for this order were calculated
using the actual price"* — the true price is 275,000 ÷ 12 = 22,916.666…

**On a total mismatch: persist everything, add a `review_reasons` entry naming both figures,
set `needs_review`.** Partial data with a clear flag beats no data — 19 of 20 items read
correctly is a useful starting point, whereas discarding the lot leaves only `raw_text`.

## Error handling

### Failure taxonomy — `error_class` decides whether it retries

| Stage | Failure | `error_code` | Class |
|---|---|---|---|
| Ingress | not a PDF / too large | `NOT_A_PDF` · `FILE_TOO_LARGE` | permanent — `415`/`413`; the scan moves it to `failed/`, no job created |
| Ingress | file vanished mid-read | `FILE_UNREADABLE` | transient |
| Parse | corrupt PDF | `PDF_CORRUPT` | permanent |
| Parse | password-protected | `PDF_ENCRYPTED` | permanent |
| Parse | zero text extracted | `NO_TEXT_LAYER` | permanent — **the scanned-document case (A4)**; its own code so occurrences can be counted |
| Classify | tied scores, LLM undecided | — | *not an error*: `needs_classification`, fixable via `PATCH` |
| Resolve | 2+ customers match | — | *not an error*: `needs_review` + base profile |
| Profile | no active profile for doc type | `NO_ACTIVE_PROFILE` | permanent — a deployment bug, must fail loudly |
| Extract | LLM 429 / timeout | `LLM_UNAVAILABLE` | transient |
| Extract | LLM returns invalid JSON | `LLM_INVALID_JSON` | transient **once** (one repair-prompt retry), then permanent |
| Extract | evidence span ≠ document text | `LLM_EVIDENCE_MISMATCH` | permanent, **per field** — see below |
| Validate | total mismatch, inferred values | — | warn: persist + `needs_review` |
| Persist | constraint violation | `DB_CONSTRAINT` | permanent — a bug; never retry |
| Persist | connection lost mid-tx | `DB_UNAVAILABLE` | transient; the tx rolled back |
| Storage | disk full / S3 error | `STORAGE_UNAVAILABLE` | transient |

### Evidence verification catches LLM hallucination

Because every LLM-sourced field carries `{page, start, end, text}`, the extractor asserts
`raw_text.slice(start, end) === evidence.text`. A model that invents a plausible value will
often invent a plausible citation alongside it, and this catches precisely that.

**On mismatch the value is rejected, not stored:** the column stays `NULL`,
`LLM_EVIDENCE_MISMATCH` goes into `review_reasons`, `needs_review` is set, and the rest of the
document still persists. An unverifiable value is treated as *no value*, never as data — which
is what keeps "every stored value traces to document text" true without exception.

### Transactions, shutdown, logging

- **One transaction** wraps the `documents` update, the type-details row, items, special terms,
  the `extraction_runs` insert, `current_run_id` **and** `jobs.status='done'` — so a crash can
  never leave a job marked done with no data, or data with a job still `running`.
- **Storage writes happen before the transaction.** Safe because the key is the content hash,
  so a retry overwrites identically; an orphaned archive file after a failed tx is harmless and
  GC-able by a sweep.
- **Graceful shutdown** on SIGTERM: stop claiming jobs, release the in-flight job's lock back to
  `queued`, drain the pool. Otherwise `docker compose down` mid-extraction leaves a `running`
  job stuck until the stale-lock timeout.
- **HTTP errors** use a simple `{ error, code }` body, with `code` drawn from the same enum as
  `jobs.error_code` so an HTTP failure and a job failure speak one vocabulary. Declared in
  `openapi.yaml`, and the multipart upload's per-file results reuse the same shape.
- **Never log raw document text** — these are customer contracts. Structured JSON logs carry
  `documentId`, `jobId`, `customerSlug`, `profileVersion`, `stage`, `durationMs` and
  `error_code`; never content. `extraction_runs.llm_calls` plus token counts give cost per run.

## Traceability: every DB value points back at document text

The requirement: look at a row and verify it against the document. Three pieces make that
hold, and the third is what makes it *verifiable* rather than merely plausible.

1. **`documents.raw_text`** — the full extracted text, stored at parse time.
2. **`documents.storage_key`** — the original PDF, still retrievable.
3. **Evidence spans with character offsets** in `extraction_runs.field_confidence`:

```jsonc
{
  "amount": {
    "value": "23640000.00", "currency": "USD",
    "strategy": "labelValue", "profileVersion": 2, "confidence": 0.99,
    "evidence": { "page": 2, "start": 4821, "end": 4862,
                  "text": "Total Subscription Fee: USD 23,640,000.00" }
  },
  "payment_terms": {
    "value": "Net 45", "strategy": "llm", "confidence": 0.96,
    "evidence": { "page": 3, "start": 7104, "end": 7188,
                  "text": "Payment will be made within forty-five (45) days of
                           Customer's receipt of an invoice." }
  }
}
```

Offsets matter: you can slice `raw_text[4821:4862]` and confirm the span really says that.
A quoted string alone could itself be wrong — an LLM can hallucinate its own citation.
`GET /documents/:id/trace` serves this per field, including item and special-term rows.

**Automated traceability already exists too:** `sum(items.total_amount) == amount` reconciles
on all four samples (152,500 / 23,640,000 / 162,000 / 451,000), catching a bad extraction with
no human involved. That is also why money is never filled down — doing so would let the check
pass against invented numbers.

## Ground truth for the accuracy harness

Hand-checked from the four PDFs; `accuracy/expected/*.json`. **All four reconcile:
`sum(items.total_amount) == amount`**, which also becomes a runtime validation rule driving
`needs_review`.

| | Acme | CloudShield | BrightOps | NovaFleet |
|---|---|---|---|---|
| doc_type | order_form | order_form | purchase_order | purchase_order |
| start / end | 01-01-2025 / 12-31-2026 | 03-01-2025 / 02-28-2028 | 03-01-2025 / 02-28-2027 | 02-01-2025 / 01-31-2028 |
| amount | 152,500.00 USD | 23,640,000.00 USD | 162,000.00 USD | 451,000.00 USD |
| payment_terms | Net 30 | Net 45 | Net 30 | Net 45 |
| buyer `signature_present` | true | **false** | true | true |
| buyer `name` | Appsoft Inc. | TechNova Solutions, Inc. | BrightOps Analytics Ltd. | NovaFleet Technologies Inc. |
| vendor `name` | Acme | CloudShield Security, Inc. | DataPulse Software Inc. | SecureCloud Systems LLC |
| vendor `address` | **none in document** | 500 Innovation Drive, San Jose, CA 95134 | 789 Market Street, San Francisco, CA 94103, USA | 1550 Innovation Way, Seattle, WA 98109, USA |
| vendor `signature_present` | true (John Smith, CFO) | false (blank) | n/a — POs have one block | n/a |
| items | 5 | 6 | 4 | 4 |
| type-specific id | `Q-20702` | `Q-78291` | `PO-BO-10458` | `PO-NF-88219` |
| special terms | 2 | **8** | 2 | 2 |
| burst | 5% on SaaS Subscription | 38.89 / 28.21 / 19.05%, cap 280,000 units | 10% | 15% |
| TAM | present (synonym, 2 roles) | **null** | present | present |

Scored values: 4 × 10 document fields (40) + 19 items × 6 columns (114) + ~20 special-term
assertions (burst percent and scope per burst row, TAM presence per document) ≈ **174;
≥95% allows ≤8 wrong.** `npm run accuracy` prints the per-field and overall score.

## Implementation phases

Sequenced **risk-first and vertically**, not module-by-module. Three principles behind the
order: settle the only unverified assumption before building on it; get one document end-to-end
as early as possible; and make the accuracy harness a *tool* available from phase 3 rather than
a deliverable at the end.

### Phase 0 — spike, throwaway

Dump real `pdfjs-dist` baselines and column x-bands for all four samples; confirm or correct
the table reconstruction algorithm. No repo, no infra, no tests — this code is discarded.

**Exit:** BrightOps' and CloudShield's tables print as correct rows × columns. The band geometry
is the last unverified assumption in the plan, and discovering it's wrong *after* a scaffold
exists around it would be expensive.

### Phase 1 — foundation

Repo, TS config, `docker-compose.yml` (postgres + api + worker), `.nvmrc`, env schema, `pg`
pool, migrations runner, `StorageAdapter` with the local backend.

**Exit:** `docker compose up && npm run migrate` works.

### Phase 2 — thin vertical slice, **BrightOps only**

parse → classify → resolve customer → extract (deterministic only) → validate → persist →
`GET /documents/:id`. **No LLM, no job queue, no polling.**

BrightOps first because it is the *easiest* document: `Net 30` literal, `mm-dd-yyyy` dates,
labelled special-term bullets, `✔ Signed`, a 6-column table with no group rows. The spine gets
proven without the hardest dependency.

**Exit:** that PDF in → one document row, two party rows, 4 item rows; `Σ items == amount`
passes.

### Phase 3 — accuracy harness

`accuracy/expected/brightops.json` plus the scoring script.

Deliberately this early. It is a **tool, not a deliverable** — once it exists every later change
is measured rather than guessed at, instead of building seven phases blind.

### Phases 4–7 — add customers in difficulty order

Each phase earns specific capabilities rather than building a module in the abstract:

| Phase | Customer | What it forces into existence |
|---|---|---|
| 4 | **NovaFleet** | The real profile system: YAML + zod strict, `extends` merge, versioned non-destructive seed, resolver with base fallback. Should be **nearly free** — the Adaptability KPI proven by the build order itself. If it's hard, the profile system is wrong; fix it before Acme |
| 5 | **Acme** (structured) | `long_month` + `short_month_compact` dates with the ambiguity guard, `symbol_prefix` money with the currency precedence, two-column signature strategy |
| 6 | **Acme** (prose) | `llm/client.ts` live/fixture/record modes; zod schemas with `value: null`; evidence `indexOf` + value-in-quote verification; one repair-prompt retry; per-document call cap. **Exit:** `Net 30` from "thirty (30) days", burst 5%, TAM found via synonym |
| 7 | **CloudShield** | The hard table (two-row wrapped headers, `Year n` group rows, pending-prefix rule), `ignore_sections` for its own PO-section trap, per-year burst → item attribution, `code_prefix` money, placeholder-line signature. **Exit: all four ≥95%** |

### Phase 8 — operational layer

`jobs` table + `SKIP LOCKED` claim loop, error classification, backoff, stale-lock reclaim;
polling timer + `scan_inbox` + size/mtime stability gate + sha256 dedupe; status transitions;
single-transaction persist including `jobs.status`; graceful SIGTERM shutdown.

Deliberately late — none of it is needed to prove extraction works, and extraction is what's
graded.

**Exit:** drop four PDFs in the folder and all four process; SIGTERM mid-job and it recovers.

### Phase 9 — full API + OpenAPI

`openapi.yaml` written **first**, then the 19 endpoints implemented against it with
`express-openapi-validator` enforcing both directions: multipart upload (1..N files, magic-byte
+ size guards, per-file results), routing-only `PATCH`, review acknowledgement, reprocess,
customer/profile management, `POST /scan`, `GET /jobs/:id`, `/trace`, `/file`. Swagger UI at
`/docs`, spectral lint + contract test in CI.

### Phase 10 — README + polish

Setup, the customer/buyer/vendor terminology, how to add a fifth customer, the drift demo, the
accuracy number — and a **Limitations** section stating plainly that image-only scanned PDFs
are unsupported (detected as `NO_TEXT_LAYER`, never silently mis-extracted), that there is no
UI, and that auth is out of scope.

**Weighting:** phases 7 and 9 are the heaviest. Phases 0, 2 and 3 are small but unblock
everything after them.

## Verification

```bash
# Docker Desktop must be running (it is installed but currently stopped)
docker compose up -d                        # postgres + api + worker
npm run migrate && npm run seed

cp "sample docs/"*.pdf ./inbox/             # content-only routing, filenames irrelevant
curl -s -X POST 'localhost:3000/scan?wait=60000' | jq   # sweep now, don't wait for the timer
# → {"found":4,"enqueued":4,"duplicate":0,"unstable":0}
curl -s localhost:3000/documents | jq
curl -s localhost:3000/documents/2 | jq '{items, specialTerms, attributes}'
curl -s -F file=@"sample docs/ACME Order From.pdf" localhost:3000/documents   # 202 + job id

open localhost:3000/docs                    # Swagger UI — upload a PDF from the browser

npm test            # offline, no API key — uses committed LLM fixtures
npm run accuracy    # prints per-field + overall score vs accuracy/expected/
npm run lint:api    # spectral lint openapi.yaml
```

End-to-end behaviours to demonstrate:
- **Content-only routing** — rename `ACME Order From.pdf` to `zzz.pdf`; still classified
  `order_form` and matched to Acme via its signature block.
- **CloudShield not misclassified** as a PO, and its `amount` is 23,640,000.00 not
  `USD 0.00` from the `Purchase Order Information` block.
- **Unknown issuer** — drop a PDF from an unregistered company: extracted with the base
  profile, `customer_resolution='unmatched'`, `status='needs_review'`,
  `detected_issuer_name` populated. Then add them to `config/customers.yaml`, re-seed, and watch the backlog re-resolve.
- **Drift** — add a label to the customer's profile YAML, re-seed, confirm v3 is active, reprocess,
  and check `GET /documents/:id/runs` shows v2 → null and v3 → value.
- **Special terms across both types** — CloudShield yields 8 rows (one `burst` ×3 item-scoped,
  plus `free_trial`, `tiered_pricing`, `conversion_right`, `renewal_cap`, `credit`, `sla`) and
  **no** TAM row; BrightOps yields 2. `GET /special-terms?type=burst&minPercent=20` returns the
  CloudShield Year-1 and Year-2 rows and neither PO.
- **Idempotency** — copy the same PDF twice: one `documents` row, and **no second job**, so
  the re-copy costs nothing in LLM calls. Same via upload → `200` with `duplicate: true`.
- **Batch upload with a bad file** — post three PDFs and a `.docx` in one request: `207`, the
  three queued, the `.docx` rejected with `not a PDF (missing %PDF- header)`.
- **Traceability** — `GET /documents/:id/trace` for CloudShield shows `amount` sourced from
  `Total Subscription Fee: USD 23,640,000.00` with offsets; slicing `raw_text` at those offsets
  returns exactly that string. Assert that programmatically in the test suite.
- **Routing override regenerates, not overwrites** — `PATCH /documents/:id {customerId}` on an
  unmatched document produces a new `extraction_runs` row whose every field carries fresh
  evidence; no field is set without one.
- **Date normalisation** — all four customers' formats land on the same `DATE`: CloudShield's
  `3/1/2025`, Acme's `January 1, 2025` and `Jan 1,2025`, the POs' `03-01-2025` all serialise
  back as `03-01-2025`. Assert CloudShield's end date is `02-28-2028`, not a D/M mis-read.
- **Currency resolution** — NovaFleet's `$120,000` items resolve to `USD` from its
  `$451,000 USD` total (rule 1) despite a Toronto billing address; Acme's symbol-only `$`
  amounts resolve from its profile `default_currency` (rule 2).
- **Inheritance vs fill-down** — CloudShield's six items carry
  `field_sources.subscription_year = 'inherited'` and the document is **not** flagged. The
  synthetic blank-cell fixture produces `filled_down` dates, `has_inferred = true`, and a
  `needs_review` document — while its blank `product_name` stays `NULL` rather than duplicating
  the row above.
- **Missed-while-down** — stop the worker, copy a PDF in, restart: the first poll tick picks it
  up. Nothing is lost, because the scan is driven by hashes rather than by events.
- **Partial write** — begin a slow copy of Acme's 191 KB file and force a scan mid-copy: it
  reports `unstable: 1` and is skipped, then ingests complete on the following tick. Never
  parsed truncated.
- **On-demand scan** — `POST /scan?wait=60000` returns
  `{"found":4,"enqueued":4,"duplicate":0,"unstable":0}`; calling it twice in a row coalesces
  rather than queueing two sweeps.
- **Scanned PDF is detected, not mishandled** — an image-only PDF fails fast with
  `NO_TEXT_LAYER` instead of silently producing an empty extraction.
- **Retries** — stop Postgres mid-extraction to force a `transient` failure and watch backoff
  retry; feed a password-protected PDF to see `PDF_ENCRYPTED` fail once with no retry.
- **Reconciliation** — all four samples pass `Σ items == amount`, and all four pass the date
  envelope (`min/max` of item dates equals the stated document dates). CloudShield passes
  per-item arithmetic only via its `× order_term_months` formula and 0.5% tolerance; assert that
  a strict `quantity × unit_price` rule would wrongly flag it.
- **Value checks warn, never block** — a synthetic document with a negative credit line and a
  `quantity` of `0` persists in full: the credit flags `NEGATIVE_AMOUNT`, the zero quantity
  flags nothing, and no `DB_CONSTRAINT` failure occurs.
- **Mixed currency** — a synthetic document with USD and EUR items reconciles per currency and
  flags `MIXED_CURRENCY`; a bare `$` in it resolves to nothing and flags `AMBIGUOUS_CURRENCY`
  rather than guessing.
- **Date fallback** — strip the stated dates from a sample: start/end come back derived from the
  item envelope with `field_sources: 'from_items'` and the document flagged for review.
- **Evidence verification** — feed a stubbed LLM response whose `quote` doesn't appear in
  `raw_text`: the field comes back `NULL` with `LLM_EVIDENCE_MISMATCH`, while every other field
  on the document still persists.
- **Value-vs-evidence** — stub a response returning `Net 30` while quoting CloudShield's
  forty-five-day clause: rejected with `VALUE_NOT_IN_EVIDENCE`. Conversely assert all six real
  numeric NL fields (both payment terms, all four Burst percentages) pass the check.
- **Explicit nulls beat guesses** — stub `{value: null, not_found_reason: "..."}` for TAM on
  CloudShield (which genuinely has none): no `special_terms` TAM row, no flag, no invented value.
- **Crash safety** — SIGTERM the worker mid-extraction: the job returns to `queued` with its
  lock released, no partial document rows exist, and the next claim completes it.
- **Parties** — CloudShield yields two `document_parties` rows: the vendor with its San Jose
  address from the legal preamble, the buyer with billing address, shipping address and all
  three contact fields. Acme's vendor row has a name and a signature but **no address**, because
  its document never states one — a NULL, not a failure.
- **Optional fields** — CloudShield's `documents.attributes` carries `marketplace`
  and `marketplace`; its Year-1 item's `attributes` carries `{"subscription_year":"Year 1",
  "order_term_months":12}`. Add a field to the profile via the API and reprocess to see it
  appear with no migration.

## Open risks

- **Node 18.18.2 is installed and is EOL.** `.nvmrc` pins Node 20 LTS; verify the chosen
  `pdfjs-dist` major against whichever runtime is used.
- **Docker is installed but not running** — must be started before `docker compose up`.
- **Acme's issuer name appears exactly once** in its text (signature block); its brand is in
  an embedded logo image. Verified by counting occurrences: Acme ×1, CloudShield ×35,
  BrightOps ×2, NovaFleet ×2. Signature-block matching covers it; Claude vision on the
  rendered page is the fallback if a future customer's identity is image-only.
- **CloudShield's Burst varies per subscription year** (38.89 / 28.21 / 19.05%) with a
  280,000-unit cap, buried in a ~190-word paragraph that also contains `$275,000`. Highest-risk
  area for the 95% KPI: it needs three item-scoped `special_terms` rows with the right percent
  on each, so it gets its own focused test.
- **Native citations vs structured outputs is an unresolved either/or.** Claude's citation
  feature returns real `start_char_index` offsets, but it 400s alongside `output_config.format`.
  The plan takes schema-guaranteed JSON plus our own `indexOf` resolution; swapping to citations
  would mean surrendering schema validation, so it stays a phase-6 experiment.
- **`pdf/tables.ts` is the riskiest code in the project** — recovering CloudShield's 8-column
  table with two-row wrapped headers, wrapped cells and `Year n` group rows. The `product_name`
  fill-down ban exists partly so a mis-parsed row fails visibly instead of being auto-completed
  into plausible-looking data. **The column band geometry is unverified** — confirming it against
  real `pdfjs-dist` output is the **phase-0 spike**, and the design may need revising after.
- **Burst → item attribution is the other soft spot** — mapping "monitored workloads" to
  `Advanced Threat Monitoring` or "analytics usage" to `Analytics Platform – Enterprise` is a
  judgement call. The document-scope fallback plus `needs_review` keeps a bad guess from
  silently writing a wrong item link.
- **Acme never says "Technical Account Manager"** — the TAM field relies on profile-declared
  synonyms, which is exactly the per-customer customisation the brief asks for.
