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
| Currency | `NUMERIC` + `currency CHAR(3)` ISO code; symbol→code map is a constant in code. A bare `# SafeBook — Document Data Extraction Service

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
 resolves from the document's single ISO code, else the profile's `default_currency` — **never** from an address |
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
| LLM in tests | `vi.fn()` mocks for plumbing, **recorded fixtures for the accuracy number** — a mock there would score the pipeline against our own invented Claude output. A setup file **refuses** `live`/`record` under Vitest, so offline is enforced, not merely true |
| Model | **`claude-opus-5`**, id in config. No `temperature`/`budget_tokens` (both 400 on this model); depth via `output_config.effort` |
| **When the LLM runs** | **Deterministic-first, escalate on failure.** Never declared per customer — a field tries its rule, and reaches Claude only if that yields nothing or fails to parse. Two of the four samples never escalate |
| LLM calls | At most one per escalating section. The item table never escalates. `llmCalls` counts calls ACTUALLY made (zero on a fixture replay); `escalations` is the separate question of what needed the model |
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
profile's `ignore_sections` masks that block during **extraction** — ✅ *applied in phase 6.*

The extraction half had a wrinkle worth recording: `po_number` and `po_amount` are real
`order_form_details` columns that exist **for** that block, so a blanket mask would have deleted
the data it was added to protect. It needed a complement, `in_section`, which reads a field only
from inside a named block. Note also that the exposure was never CloudShield itself — its own
`amount` label is `Total Subscription Fee` — but the **base profile**, whose synonyms include a
generic `Total Amount`, and therefore an unregistered order form with a similar block.

When `|score_order − score_po| < 3` or both scores `< 4`, Claude arbitrates on page-1 text.
If still unresolved → `status='needs_classification'`, no extraction attempted (field
definitions are per doc type, so there is nothing meaningful to extract), correctable via
the same `PATCH` + reprocess path as a customer reassignment.

## Inferring the issuer: "who sent this", not "what did we register"

Match patterns alone answer the wrong question. They find a customer we already
configured; they cannot tell us who issued a document from a customer nobody has
registered — which is the case the design claims to handle, and the case where an
accurate `detected_issuer_name` matters most.

So the issuer is **inferred from content with no per-customer configuration**, and the method
differs by document type because the issuer's ROLE inverts:

| Doc type | Issuer is the | How it is found | Config needed |
|---|---|---|---|
| Purchase Order | **buyer** | the title `Purchase Order – X` **and** `Company Name:` under the `Buyer` heading — two independent sources | none |
| Order Form | **vendor** | the shared signature line **minus** the buyer | none |

The order-form case is the hard one: **the vendor is never stated plainly.** Acme's name
occurs exactly once in its whole document; CloudShield's is buried in legal preamble prose. But
both parties share ONE signature line, and the buyer *is* stated plainly (`To:`,
`Customer Billing Name:`). So the issuer is obtained by subtraction:

```
"Acme Appsoft Inc"                                    - "Appsoft Inc."             = "Acme"
"CloudShield Security, Inc. TechNova Solutions, Inc." - "TechNova Solutions, Inc." = "CloudShield Security, Inc."
```

No geometry and no regex per customer. CloudShield is independently corroborated by its
preamble (`by and between X, a company…`), giving two agreeing methods.

**Subtraction must be positional, not token-based.** Both CloudShield and TechNova end in
`Inc.`, so filtering by token set keeps both and yields `"CloudShield Security, Inc. Inc."`.
Cutting the matched span out by offset — the same normalise-with-index-map technique as
`llm/evidence.ts` — avoids that, with a final strip for the buyer's own trailing period, which
falls outside the normalised span and otherwise survives as an orphan.

**The inferred name is then matched to a registered customer by NORMALISED NAME** (casefold,
drop punctuation), not by regex. Two consequences:

- Registering a customer needs only their **name**. Explicit `match` patterns remain in
  `customers.yaml` as a supplement for awkward cases, but they are no longer the only route.
- An **unregistered** customer still produces an accurate `detected_issuer_name`, so a human
  can register them from the record without opening the PDF.

Covered by `tests/unit/inferIssuer.test.ts`, including that a PO's two sources agree, that the
shared `Inc.` suffix is not duplicated, and that an unregistered issuer is still named.

### If all three rules fail, Claude is asked

`issuer_name` is escalatable, so a layout that defeats the PO title, the buyer label AND the
signature subtraction still gets an answer rather than going straight to `unmatched`.

Escalating here is safe for a structural reason: **the answer is matched against a CLOSED SET
of registered customers.** An invented or unrecognised name cannot route anywhere — it degrades
to `unmatched` and the base profile, exactly where a failed rule would have left it. So
hallucination costs nothing.

One failure mode the closed set does **not** catch, and the only genuinely dangerous one:
**naming the counterparty.** On a PO the issuer is the buyer; if Claude returned the vendor and
that vendor happened to be a registered customer, the document would route to the *wrong*
customer's extraction rules. Three guards:

1. **The prompt names the role**, because it inverts by document type — `issued BY THE BUYER`
   for a PO, `issued BY THE SELLER` for an order form — and explicitly warns off the other
   party, which on an order form is the more prominently named and therefore more tempting one.
2. **The quote must exist in `raw_text`**, so a name cannot be fabricated.
3. **`issuerIsNotCounterparty()`** rejects an answer matching the party already extracted.

A test asserts escalation does **not** fire for any of the four samples, since the
deterministic rules already succeed — so the LLM is genuinely a fallback here, not the path.

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

> The README has a shorter table-by-table tour of the same schema, aimed at a
> reviewer rather than at the decision record. This section is the full DDL and the
> reasoning behind each column.


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

These snippets are excerpts of the **real files**, not illustrations. An earlier draft of this
section carried invented YAML that would now fail schema validation outright — `strategy: llm`,
`header_rows`, `wrapped_cells`, `placeholder_lines` — which is its own small lesson about
documenting a config format before writing one.

```yaml
# config/profiles/order_form/_base.yaml — excerpt
doc_type: order_form
fields:
  start_date:
    labels: ["Start Date", "Subscription Start Date", "Contract Start Date"]
    input_formats: [long_month, slash_mdy, dash_mdy]
  amount:
    labels: ["Total fee", "Total Subscription Fee", "Total Price", "Total Amount"]
  payment_terms:
    labels: ["Payment Terms"]
    sections: ["Payment Terms", "Terms and Conditions"]   # sent ONLY if it escalates
type_fields:
  # `type: number` is not decoration: the label is followed by a parenthetical
  # before the value, so the raw tail of the line is not a number.
  subscription_term_months: { labels: ["Subscription Term (months)"], type: number }
  # scoped back INTO the block `ignore_sections` masks, or these would be
  # permanently null
  po_required: { labels: ["Is a Purchase Order (PO) required"],
                 in_section: "Purchase Order Information", type: boolean }
  po_amount:   { labels: ["PO Amount"], in_section: "Purchase Order Information" }
items:
  column_synonyms:
    product_name: ["Name", "Product Name", "Subscriptions", "Description"]
    unit_price:   ["Rate", "Unit Price", "Monthly / Unit Price"]
    total_amount: ["Total amount", "Total Amount", "Total Price"]
  reconcile: quantity * unit_price
  tolerance: 0.01
```

```yaml
# config/profiles/order_form/acme.yaml — the whole file
extends: _base
# No ISO code appears anywhere in Acme's document, so rule 1 finds nothing and
# this answers. Declared rather than inferred: the tempting inference is the
# billing address, and NovaFleet is the counterexample in the same sample set.
default_currency: USD
fields:
  amount:     { labels: ["Total fee"], money_format: symbol_prefix }   # "$152,500"
  start_date: { labels: ["Start Date"], input_format: long_month }     # "January 1, 2025"
  end_date:   { labels: ["End Date"],   input_format: long_month }
items:
  date_format: short_month_compact     # "Jan 1,2025" — abbreviated, no space after the comma
special_terms:
  # Acme never writes the phrase. A wording HINT passed to Claude, not a locator:
  # its terms are numbered prose with no labels, so this section escalates.
  synonyms:
    technical_account_manager: ["Customer Support Manager", "Product Architect"]
```

```yaml
# config/profiles/order_form/cloudshield.yaml — excerpt
extends: _base
fields:
  amount:     { labels: ["Total Subscription Fee"], money_format: code_prefix }
  start_date: { labels: ["Subscription Start Date"], input_format: slash_mdy }
parties:
  buyer:
    # "Customer Billing Name:" appears TWICE — the organisation, then the person
    contact_name: { labels: ["Customer Billing Name"], occurrence: 2 }
  vendor:
    # order forms never label the vendor's address; CloudShield states it once,
    # in the legal preamble. Labels are tried first, so this only answers because
    # the base profile's "Vendor Address" finds nothing.
    address: { pattern: 'principal place of business at ([^,]+,\s*[^,]+,\s*[A-Z]{2}\s*\d{5})' }
ignore_sections: ["Purchase Order Information"]   # masks "PO Amount: USD 0.00"
items:
  carry_down: [subscription_year]      # sparse column: blank rows inherit from above
  date_format: slash_mdy               # "3/1/2025" — declared, so not flagged ambiguous
  reconcile: quantity * unit_price * order_term_months   # priced monthly
  tolerance_pct: 0.5                   # unit price rounded to 2dp per the document
  optional_columns:
    subscription_year: ["Subscription Year"]
    order_term_months: ["Order Term (Months)"]
optional_fields:
  # a BARE LINE near the top with nothing labelling it, so there is no key to
  # look up
  marketplace: { pattern: '^((?:Azure|AWS|GCP|Google Cloud)[A-Za-z ]*(?:Private Offer|Marketplace))$' }
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

### The driver undid the DATE choice — a bug that reached the API

Choosing `DATE` over `TIMESTAMPTZ` was necessary but **not sufficient**. Every date came out
of the API a day early:

```
PDF:                  Contract Start Date: 03-01-2025
stored in Postgres:   2025-03-01            <- verified directly in psql
returned by the API:  02-28-2025            <- a day lost
```

node-postgres parses a `DATE` column into a **JS `Date` at LOCAL midnight**. In UTC+3 that
makes `2025-03-01` the instant `2025-02-28T22:00:00Z`, and rendering it through
`toISOString()` drops the day. The database was right the whole time; only the read path was
wrong.

Fixed with explicit driver type parsers in `src/db/types.ts`:

| OID | Type | Parser | Why |
|---|---|---|---|
| 1082 | `DATE` | return the raw `yyyy-mm-dd` string | a calendar date has no instant to convert to |
| 1700 | `NUMERIC` | return the decimal string | already the default, pinned so it cannot change by accident — as a float `22916.67` becomes `22916.669999999998` |

Two things worth taking from this. **It is invisible west of UTC** — the same code passes in
UTC-5 and fails in UTC+3, so a test asserting the output date would pass on a reviewer's machine
and fail in production. The regression test therefore asserts the *mechanism*, reproducing the
shift explicitly and checking the parser is registered. And **it is the same class of mistake as
storing `mm-dd-yyyy` strings** — letting a representation decision leak into a layer that
should not be making one.

(Found only because the API output was checked field-by-field against the PDF rather than
assumed correct from the pipeline's own log, which showed the right values throughout.)

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

Other money details: `unit_price NUMERIC(18,4)` holds CloudShield's `3.25` and `22916.67`
(3.25 × 180,000 × 12 = 7,020,000.00 exactly, which only reconciles without float error);
totals `NUMERIC(18,2)`. **Amounts are carried as decimal STRINGS, never JS numbers** — as a
float, `22916.67` becomes `22916.669999999998`, and the whole point of NUMERIC is defeated if
anything parses it on the way to the DB.

**European number formatting is auto-detected rather than declared.** An earlier draft planned a
`number_locale` profile option; the parser instead takes the LAST separator as the decimal point
when its tail is 1–2 digits. So `$162,000` → `162000` and `EUR 1.234,56` → `1234.56` with no
configuration — which matters because an unknown customer has nobody to declare a locale for it.

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

## Generalising beyond the four samples

The four documents are **examples, not the universe**. The service must take a new customer in
a layout nobody has seen. What follows is an honest account of where that holds and where it
does not.

### Format-agnostic by construction

| Component | Why it generalises |
|---|---|
| **Table reconstruction** | Derives everything from the document: columns by x-clustering, data rows by column occupancy, band from line gaps and glyph height. **No per-customer constants.** Verified by reconstructing CloudShield (8 cols, wrapped cells, 6pt line gap, single page) and BrightOps (6 cols, no wrapping, 14.6pt gap, split across two pages) from *identical defaults* |
| **Base profile fallback** | An unregistered customer resolves to `(NULL, doc_type)`, is extracted, and is flagged `needs_review`. Nothing is dropped |
| **Evidence, dedupe, queue, reconciliation** | Nothing in them refers to a document's shape |

The three tuned thresholds are all overridable per profile, and their defaults **adapt to the
table's own geometry** rather than to a known customer:

| Option | Default | Why not a fixed number |
|---|---|---|
| `columnGapPt` | 18 | |
| `anchorColumnRatio` | 0.5 of detected columns, floor 2 | The spike used a fixed "≥4 columns", which would find **no rows at all** in a legitimate 3-column table |
| `bandFactor` | 1.2 × median line gap, capped at 0.6 × min row pitch **and** 2.5 × glyph height | Each bound alone fails: median gap equals row pitch on an unwrapped table and swallows the next row; pitch is undefined on a one-row page; and one distant stray run makes the median enormous |

### Known limits — what extending actually costs

| Extension | Cost |
|---|---|
| New customer, familiar formats | **YAML** — one `customers.yaml` entry + one profile file |
| New label wording | **YAML**, but the *first* document misses that field and is flagged |
| New date format (e.g. D/M/Y `15/03/2025`) | **Code** — a registry entry. Fails *safe*: the ambiguity guard flags rather than guessing |
| New money format (e.g. `EUR 1.234,56`) | **Code** — a registry entry |
| New document type (invoice, SOW, amendment) | **Migration** — new enum value, new field catalog |
| Image-only scanned PDF | Out of scope by decision; detected as `NO_TEXT_LAYER`, never mis-extracted |

### Tested, not merely claimed

`tests/unit/generalisation.test.ts` and the "unfamiliar layouts" block of
`tests/unit/tables.test.ts` assert graceful degradation on inputs the design was not built
around:

- A real table reconstructed with **zero configuration** — no labels, no `header_rows`, no
  carry-down declared — and still reconciling to 23,640,000
- A **3-column** table, which the pre-spike fixed "≥4 columns" rule would have missed entirely
- A **wrapped cell** in an unfamiliar 2-column layout
- **European decimal commas** (`1.234,56`) surviving reconstruction as text, to be rejected by
  the money normaliser rather than silently mis-parsed
- A stray footnote reported as an **orphan** rather than silently absorbed into a row
- A document with **no table at all** returning no rows rather than inventing one
- A **dense layout** needing `columnGapPt` lowered, proving the option works

**The guiding property: partial extraction plus a review flag, never silent wrong data.**
The reconciliation checks are what make that trustworthy — if reconstruction goes wrong,
`Σ items == amount` breaks rather than producing a plausible-looking total.

## Deterministic locators and traceability

Phase 2 built the deterministic half. Two properties worth stating because they are easy to
get wrong:

**Locators return character offsets, not just values.** So a rule-sourced value is traceable
exactly like an LLM-sourced one, and *"every stored value points back at document text"* has no
exception for the deterministic path — `GET /documents/:id/trace` works uniformly.

**The stored value and its evidence are deliberately different things.** A multi-line address
is stored joined (`"789 Market Street, San Francisco, CA 94103, USA"`) while its evidence
slices the document's original characters, newline included. Same split as dates, where a
`DATE` is stored and `"03-01-2025"` is the evidence. (A test initially compared the two
directly and failed, which is how the distinction got pinned down.)

### Block boundaries: a named heading list, not a heuristic

`multilineAfterLabel` has to know where an address block ends. Two attempts failed against the
real text before the third worked:

| Attempt | Result |
|---|---|
| Stop at a blank line or a `Label:` line | ✗ The vendor address swallowed `Buyer`; the billing address swallowed `Order Summary` |
| Also stop at a short Title-Case line with no colon, comma or digit | ✗ **Truncated NovaFleet's buyer address** — `"Canada"` alone on a line is short, capitalised, comma-free and digit-free, i.e. indistinguishable from a heading by shape |
| Stop at a **named** heading from `DEFAULT_SECTION_HEADINGS`, profile-overridable | ✓ |

The lesson generalises: shape-based heuristics over document text tend to have a counterexample
inside the documents themselves. A named list is overridable per profile, so an unfamiliar
document can declare its own.

### "Could not tell" is not "no"

`signatureMarker` returns **null** when it finds no signature marker, rather than `false`.
Acme has no `Buyer Signature:` label at all — it uses a two-column block — so defaulting to
`false` would assert the contract is unsigned, which is a wrong answer rather than a missing
one. The null escalates, which is why `buyer_signature_present` is in `ESCALATABLE_FIELDS`;
a test asserts that pairing, since the two were briefly inconsistent.

## When does the LLM run?

**Not by declaration.** An earlier draft had profiles say `strategy: llm` per field, which
quietly assumed someone had inspected that customer's documents — impossible for a customer
nobody has configured. The logic is instead:

```
for each scalar field:
  1. run the deterministic rule (label lookup / labelled bullets / signature marker)
  2. did it yield a value that PARSES?
       yes -> accept. source='rule'. no call.
  3. no  -> escalate to Claude
  4. Claude fails, or no API key -> null + FIELD_NOT_FOUND flag
```

The LLM is never *chosen*, it is *reached*. Against the real documents:

| Document | `Payment Terms:` label present | Its text parses as `Net xx` | Outcome |
|---|---|---|---|
| BrightOps | yes | `Net 30` → **yes** | rule, **no call** |
| NovaFleet | yes | `Net 45` → **yes** | rule, **no call** |
| Acme | yes | *"shall be made in advance of such period. Payment shall be made within thirty (30) days from invoice"* → **no** | **escalates** → 30 |
| CloudShield | yes | prose → **no** | **escalates** → 45 |

Identical code path, opposite outcomes, **no per-customer configuration**. Special terms behave
the same way: `labelled_bullets` finds `Burst (Item Level):` on both POs and returns two terms,
so nothing escalates; on the order forms it finds no labels and escalates.

Three consequences:

- **The seam exists from phase 2**, with nothing behind it (escalation returns `null` + flag).
  Phase 6 plugs Claude in. Adding Acme then needs no restructuring.
- **The service runs with no API key**, deterministic-only — lower recall on prose fields, no
  failures. A reviewer can clone and run it immediately.
- **The item table never escalates.** It is geometry rather than language, reconstruction is
  self-checking via `Σ items == amount`, and an LLM would be strictly worse at it.

Covered by `tests/unit/escalation.test.ts`, including that `escalate` is asserted **not
called** for the POs.

## Escalation modes (phase 5)

Four modes, because two distinct things were briefly conflated.

| `LLM_MODE` | Escalator | Key | Behaviour |
|---|---|---|---|
| `off` **(default)** | `null` | no | A failed rule is flagged `FIELD_NOT_FOUND` and the document still persists. **This is how the service behaves with no key** — lower recall on prose, no failures |
| `fixture` | replay only | no | Replays recorded responses; **a miss is a hard error**. For tests and `npm run accuracy` |
| `live` | calls Claude | yes | The real service path |
| `record` | calls + writes | yes | Run once to refresh `tests/fixtures/llm/` |

`off` and `fixture` were the same mode at first, which was wrong: a reviewer dropping a PDF
into `inbox/` would have hit a hard fixture miss instead of the graceful degradation the design
promises. `live`/`record` without a key refuse to start and name the fix.

### Fixtures are a testing artifact, not a service path

A fixture's key hashes the **input text**, so a genuinely new document can only ever *miss*.
Fixtures cannot serve production even in principle — the service runs `live`.

**The key is `sha(field, model, sha(instruction), input)`, deliberately not the field name.**
Keying on the field alone would replay an OLD response against a CHANGED prompt: tests would
pass while live behaviour differed, and the printed accuracy number would describe a prompt that
no longer exists. A prompt edit therefore misses and must be re-recorded.

A miss is an **error**, never a silent fallthrough — which would either turn an offline run into
a billed one, or hide prompt drift behind passing tests.

### No fixtures are recorded yet, and the repo says so out loud

The four order-form prose fields and CloudShield's billing frequency — **nine scored values
across two documents** — need one recording run with an API key. There is none in this
environment, so rather than hide that:

- `npm run accuracy` lists each pending value by name, prints the fixture key it would need, and
  reports the KPI as **NOT YET MEASURABLE** rather than as a pass over the remaining fields.
- `npm test` stays green, because a missing fixture is a state of the repo, not a defect in the
  extractor. It asserts **zero wrong values**, which is the part that is actually knowable today.

**Hand-writing the fixtures was the tempting shortcut and is the wrong move.** It would mean
inventing Claude's output for the five hardest fields in the set and then scoring the pipeline
against my own invention — the printed number would describe my imagination, not the system. A
fixture has to be a frozen *real* response or it proves nothing. (CloudShield's burst paragraph
makes this concrete: ~190 words carrying 38.89%, 28.21%, 19.05%, a 280,000-unit cap, **and** a
`$275,000` figure that is not the cap. "First percentage" and "first money value" both give wrong
answers, so whether a model gets it right is genuinely unknown until one is asked.)

A test asserts the fixture directory is empty. When it stops being empty that assertion is the
thing to delete; while it holds, it guarantees no hand-made fixture has crept in.

### Mocks and fixtures do different jobs — and neither can call Claude

The suite never reached the network even before this was enforced: every escalation test
supplies its own `vi.fn()`, nothing imports `llm/client.ts`, and all tests pass with the network
pointed at a dead address. But both halves are kept deliberately, because they prove different
things:

| | Proves |
|---|---|
| **`vi.fn()` mocks** (unit tests) | the **plumbing** — a hallucinated quote is rejected, a value not in its own quote is rejected, a refusal is handled, an explicit `null` doesn't crash |
| **Recorded fixtures** (`npm run accuracy`) | the **extraction** — that Claude actually finds `30` in *"within thirty (30) days from invoice"* |

Mocking the accuracy run would be the tempting shortcut, and is the one thing that must not
happen: it would score the pipeline against output *we imagined* Claude producing. One could
hand-write a mock returning the right answer for every field, print **100%**, and have the real
model fail outright. Since ≥95% is a claim about the system, the number has to come from a real
recorded response. A fixture is not a live call — it is a frozen one.

**The guard makes it a rule rather than a convention.** `tests/setup/offlineLlm.ts` runs before
any test file's module graph loads, so it pins `LLM_MODE` before `config/env.ts` reads it:

- `live` and `record` are **refused**, loudly, naming `npm run accuracy` as the command that may
  record. Silently rewriting them would hide the misconfiguration rather than report it.
- everything else — including the `off` default — is **pinned to `fixture`**. Not merely
  permitted: under `off` the escalator is `null`, so a prose field is flagged `FIELD_NOT_FOUND`
  instead of replaying its recorded response. The accuracy number would quietly drop once the
  order forms enter the scored set, with nothing naming the cause.

The hole this closes is small but real: Vitest does **not** load `.env` into `process.env`
(verified), so a committed `LLM_MODE=live` was never the risk — an **exported shell variable**
was, and the documented recording command is one word away from it (`npm run accuracy` →
`npm test`).

One complementary check, because the mode guard cannot see a module that constructs its own
client: a static assertion that `new Anthropic(` appears in exactly one file,
`src/llm/client.ts` — the one the mode gates.

⚠️ `npm run accuracy` itself runs under `tsx`, not Vitest, so it is **not** pinned — correctly,
since `record` has to work there. It currently inherits the `off` default rather than `fixture`;
harmless while only the POs are scored (neither escalates), and load-bearing in phase 7 when the
order forms arrive.

### SDK notes

The installed SDK was `0.70.1`, which has no `messages.parse`, no `output_config` and no zod
helper — the structured-output API needed `0.133.0`. Also: `zodOutputFormat` takes a **zod v4**
schema, so `src/llm/schemas.ts` imports from `zod/v4` while `src/profiles/schema.ts` stays on
v3 (nothing hands it to the SDK). The two coexist deliberately rather than by accident.

And confirming from the SDK reference rather than memory: **no `temperature`** — it is removed
on this model family and returns a 400. Determinism comes from the fixture cache. `stop_reason`
is checked for `'refusal'` before reading content, and `fallbacks: 'default'` is enabled.

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
| `payment_terms` | the `Payment Terms` / `Terms and Conditions` section — **only when the rule failed** | `{ value: 45, quote }` |
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
  extract/strategies/       labelValue · patternValue · multilineAfterLabel
                            twoColumnSignature (true | false | null) · sections (mask /
                            scope, offset-preserving) · itemsTable · llmField
                            specialTerms (labelled_bullets | llm) · burstAttribution
  extract/normalize/        date.ts · money.ts · netTerms.ts (word-number parser) · coerce.ts
  extract/validate.ts       items sum vs amount, date ordering, required fields
  llm/client.ts             live | fixture | record modes
  llm/prompts/
  poller/{loop.ts,scan.ts}  chained setTimeout · stat/size/mtime stability gate
                            · sha256 dedupe → enqueue
  api/{server.ts,routes.ts,present.ts}   Express + express-openapi-validator +
                            swagger-ui-express. present.ts shapes every response to
                            the spec, because validateResponses is ON
openapi.yaml                hand-written spec: served at /docs, ENFORCED at runtime in
                            both directions, linted by spectral, and exercised
                            operation-by-operation by tests/integration/contract.test.ts
accuracy/{expected/*.json,compare.ts,runner.ts,score.ts}   <- one comparison, shared by
                            npm run accuracy AND tests/accuracy/kpi.test.ts
.spectral.yaml              <- lint rules for the spec; npm run lint:api
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
| 3. Per-field output | `extract/validate.ts` | real calendar dates **within a plausible window** (`MIN_YEAR`/`MAX_YEAR` = 1990–2050, constants in `normalize/date.ts` — `01-01-1900` is a valid date and a certain parse slip). A plausibility guard, deliberately not per-customer config, `payment_terms_days` a positive integer (a term that isn't Net-shaped → `NULL` + flag), `quantity >= 0`, required-per-type (`quote_number` on order forms; `po_number` + `po_date` on POs) |
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

**239 scored values across the four documents** — 48 per purchase order, 65 for Acme, 78 for
CloudShield — covering the document fields, both parties, the type-specific details, every item
column and each special term. `npm run accuracy` prints the per-field and overall score.

Nine of those 239 are the prose fields awaiting a recorded fixture. The other **230 are all
correct**. ≥95% of 239 allows 11 wrong; there are currently 0 wrong and 9 unmeasurable.
## The accuracy harness (phase 3)

`npm run accuracy` scores the real pipeline against hand-read ground truth and prints a number.

```
ACME Order From.pdf
  62/65 (95.4%)  escalated: none  api calls: 0  review: FIELD_NOT_FOUND
  … paymentTermsDays  (declared as escalating; awaiting a fixture)
  … term[0].burst  (declared as escalating; awaiting a fixture)
  … term[1].technical_account_manager  (declared as escalating; awaiting a fixture)

Purchase Order – BrightOps Analytics Ltd.pdf
  48/48 (100.0%)  escalated: none  api calls: 0  review: (none)

CloudShield Order Form.pdf
  72/78 (92.3%)  escalated: none  api calls: 0  review: FIELD_NOT_FOUND
  … paymentTermsDays · billingFrequency · term[0..2].burst · term[3].tam (absent)

Purchase Order – NovaFleet Technologies Inc.pdf
  48/48 (100.0%)  escalated: none  api calls: 0  review: (none)

======================================================================
  230 / 239 scored values  =  96.2%
  9 pending — fields that must escalate, with no fixture recorded yet

  KPI is >=95%: NOT YET MEASURABLE.
  Record the fixtures once, with a key, then this number is final:
      LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy
======================================================================
```

**It runs with no database and no API key.** Profiles and customers load from YAML, and the
import graph never touches `db/pool.ts` — verified by stopping Postgres and running it anyway.
That is what makes the printed number mean something: whoever reviews this repo can reproduce it
from a fresh clone with `npm install && npm run accuracy`.

That property is also why **`DATABASE_URL` is optional in the env schema** while `db/pool.ts`
demands it. Phase 7 made the harness build the real escalator, which reaches `config/env.ts`,
which until then insisted on a `DATABASE_URL` just to read `LLM_MODE` — and would therefore have
made `npm run accuracy` require Docker. The api and worker still fail at boot, because importing
`db/pool.ts` *is* opening a pool, so the check lives there and names the fix.

**Why it exists at phase 3 rather than at the end.** It is a *tool*, not a deliverable. The
original plan had it at phase 9, which would have meant building seven phases blind — every
change a judgement call rather than a measurement.

### Three verdicts, not two — and the KPI is withheld rather than inflated

The harness has to separate two very different reasons a value is missing, and getting this
wrong in either direction would make the headline number dishonest:

| verdict | meaning |
|---|---|
| **pass** | matches the hand-read ground truth |
| **fail** | the extractor is wrong. Breaks the build |
| **pending** | the field *must* escalate and no fixture is recorded yet |

A `pending` value is **not** a miss: `LLM_MODE=off` with no API key is the documented graceful
degradation, and counting it as a parser failure would blame the extractor for an absent key. But
it is emphatically **not a pass** either, and the rule that keeps this honest is:

> **While anything is pending, the KPI is reported as NOT YET MEASURABLE — never as a PASS.**

Because a "≥95%" computed over only the fields that did not need a model is a claim about a
*smaller problem than the brief set*. The prose fields — payment terms, Burst, TAM — are
precisely the ones the hybrid design exists for. Quietly excluding them and printing a green
number would be the same mistake as mocking the accuracy run.

What it does report is the deterministic score, labelled as such: **230 / 239 = 96.2%, with
0 wrong**. Every value that does not need the model is correct on all four documents.

**`_escalates` is declared in each expected file, and is self-checking.** It names the fields
whose deterministic rule cannot succeed on that document. Declared rather than derived for two
reasons: it documents the design's central claim — *5 escalations across 2 documents, 2 documents
need zero calls* — somewhere a reviewer can check it, and it is what lets the harness tell "no
fixture yet" from "the parser is wrong". A field listed there that the rule *did* answer is
scored as a **failure**, because otherwise a stale comment would exclude a field from the KPI
forever.

**A fixture miss stays loud.** In `fixture` mode an escalation with no recording raises
`FixtureMissError` by design — a silent fallthrough would either turn an offline run into a
billed one or hide prompt drift behind passing tests. The harness catches it at the document
level, prints the field and the key to record, and then re-scores that document deterministically
so its other 62 values are still measured. Named and reported is not the same as silent.

**Scored values** are the document fields, both parties' fields, the type-specific details, every
item column, and each special term — 48 per purchase order, 65 for Acme, 78 for CloudShield.
Four deliberate choices:

- **A correctly-extracted `null` counts as a PASS.** A PO's vendor never signs, so
  `vendor.signaturePresent: null` is the right answer, and Acme's document states no vendor
  address anywhere. Scoring those as misses would make the ceiling unreachable.
- **Money compares numerically**, so `"72000"` and `"72000.00"` are equal — the DB returns
  NUMERIC with its scale, and the harness should test the value rather than the formatting.
- **Special terms are matched by `(termType, percent)` and consumed**, because CloudShield's one
  burst paragraph yields three rows with different percentages. Matching by type alone would let
  one correct row satisfy all three expectations.
- **`absent: true` asserts a type is NOT present** — CloudShield genuinely has no Technical
  Account Manager term, which is why the column must be nullable. It is only scored once the
  section has actually been extracted: with no escalator the list is empty and every absence
  would pass for free. That free pass was real, and this is what closes it.
- Keys beginning with `_` are notes for whoever reads the file, not values to score.

`tests/accuracy/kpi.test.ts` runs the **same comparison** through the same
`accuracy/runner.ts`, so the printed number and the build-breaking assertion cannot drift apart.
It asserts zero `fail` verdicts on all four documents, that neither PO escalates anything, that
`llmCalls === 0` everywhere (nothing in the suite may reach the network), and that the five
declared escalations are exactly the prose fields.

## Testing the operational layer

263 unit tests plus **16 integration tests that need Postgres and skip themselves without it**,
printing the reason rather than passing silently. `npm test` stays runnable from a fresh clone
with no Docker — the same property the accuracy harness has.

Getting the integration tests to be *reliable* rather than merely green took three attempts, and
each failure was a real lesson rather than a flake.

### The integration tests get their own database

Sharing the development database failed in three ways, all of which looked like flaky tests:

1. **A live worker claims the tests' jobs.** `FOR UPDATE SKIP LOCKED` is doing exactly its job —
   two claimants are indistinguishable from two worker replicas — so the test reported 1
   extraction where it enqueued 2. The first occurrence was a worker *I* had left running.
2. **Worse, that worker disagrees about the answer.** It runs `LLM_MODE=off` (no key) while the
   test runner pins `fixture`, so the same order form SUCCEEDS with `FIELD_NOT_FOUND` under one
   and FAILS with a fixture miss under the other. Which assertion held depended on who got there
   first.
3. **Rows leaked between runs**, so a test's own document came back as a duplicate of itself.

`vitest.workspace.ts` therefore defines two projects: the ~250 unit tests run concurrently and
touch no database; the integration project gets `safebook_test` (created, migrated and seeded by
its own `globalSetup`), a single fork, and no file parallelism. Verified by running the full suite
twice **with the containerised worker live and processing** — 266 passing both times.

Two smaller measures survive from the earlier attempts because they are still worth having:

- **Per-run nonce.** Each sample is copied in with a nonce appended as a PDF comment after
  `%%EOF` — changing the sha256 while leaving the document byte-identical to parse (verified:
  same page count, same text, same runs). The test database persists between runs, so without
  this the first run inserts the four samples and every run after it finds them already known and
  silently tests nothing. That is exactly what happened.
- **Cooperative settling.** The drain loops until every job reaches a terminal state rather than
  insisting on claiming each one itself, so a concurrent worker makes no difference to the
  outcome.

### Two bugs the tests found in the code

**Shutdown's release was dead code.** Writing the test showed `current` was already cleared by the
time `stop()` could observe it — and that a handler which settles normally needs no release at
all. The fix was the grace period described under phase 8.

**`maybe()` chose `it` vs `it.skip` at collection time**, before `beforeAll` had set the
availability flag — so every integration test skipped even with Postgres up, and the skip was
indistinguishable from "no database". The probe moved to module scope with top-level await.

### What the integration tests actually assert

| | |
|---|---|
| `claim` | increments `attempts` AT CLAIM time; returns null rather than blocking on an empty queue |
| partial unique indexes | the same work cannot be queued twice for one document; repeat `POST /scan` coalesces |
| `fail` | a transient failure returns to the queue with `run_after` in the future; a **permanent** one is terminal at attempt 1 of 3 |
| `reclaimStale` | an abandoned `running` job returns to `queued` with its lock cleared and `attempts` preserved; a FRESH lock is left alone |
| shutdown | waits for a job that settles in time; **releases** the lock when the grace period expires; stops claiming new work; catches a handler that returns without settling |
| folder → DB | four PDFs in a nested temp inbox become four documents routed **by content**, two fully extracted |
| dedupe | the same bytes under a different filename is one document and no second job |
| stability gate | a just-written file is held back on the first tick and judged on the second |
| `PDF_CORRUPT` | a truncated PDF fails **once**, permanently |

## Profile keys: declared, applied, or deleted

Tracked explicitly, because a key that silently does nothing is worse than a missing one — it
reads as working configuration. **Phase 6 closed the last of them**, and the pattern across all
nine is worth stating plainly: *every single one that was declared before being wired was wrong
in some way by the time it got wired.* Four were no-op knobs, two were a strategy that turned
out not to exist, and two needed a companion mechanism nobody had thought of. Declaring a key
before implementing it does not reserve a design — it records a guess.

| Key | Status | What wiring it actually revealed |
|---|---|---|
| `two_column_signature` | ✅ applied | one capability, not two — see below |
| `ignore_sections` | ✅ applied | needed a **companion**, `in_section`, or the mask deletes the data it protects |
| `in_section` | ✅ new | the complement of the mask; also tighter than an exemption |
| `optional_fields` | ✅ applied | its only declared field, `marketplace`, had the **value** written where a label belonged |
| `pattern` | ✅ new | `Azure Private Offer` is a bare line; no label exists to look up |
| `occurrence` | ✅ new | CloudShield reuses `Customer Billing Name:` for the org **and** the contact |
| `type` | ✅ applied | declared from the start, never read — it was storing a whole sentence into `NUMERIC(6,2)` |
| `default_currency` | ✅ applied | already implemented in the normaliser; **Acme had no profile file at all** |
| `type: money` | ✅ new | `po_amount` is `NUMERIC(18,2)` and the document says `USD 0.00`. The raw string aborted the whole insert — a class of bug only a real database produces |
| `placeholder_lines` | ❌ deleted | never a strategy — `two_column_signature`'s `false` outcome |
| `header_rows`, `wrapped_cells` | ❌ deleted | the reconstruction detects both from geometry |

A declared-but-unimplemented *strategy* returns `null` and escalates rather than falling through
to a plain label lookup — see the bug it caused above. The schema now **rejects** every deleted
key, so a stale `placeholder_lines:` fails at seed instead of reading as configuration.

### `ignore_sections` needs `in_section`, or it deletes what it protects

CloudShield's order form carries its own block:

```
Purchase Order Information
Is a Purchase Order (PO) required for the purchase or payment of the subscriptions …? No
PO Number:
PO Amount: USD 0.00
```

The classification trap was already handled by position weighting. The *extraction* trap is
`PO Amount: USD 0.00`, and the real exposure is not CloudShield — whose own `amount` label is
`Total Subscription Fee` — but the **base profile**, whose synonyms include a generic
`Total Amount`. An unregistered order form with a similar block would store a zero contract
total.

But `po_number` and `po_amount` are real `order_form_details` columns that exist *for* that
block. A blanket mask makes them permanently null: the knob would delete the very data it was
added to protect. So the mask got a complement — `in_section`, which reads a field **only**
from inside a named block. That is strictly better than exempting a field from the mask, because
it also stops `PO Number:` matching somewhere else in an eight-page document. `po_required` came
along for free: `type: boolean` over *"… required …? No"* → `false`, a column that had been
permanently `NULL`.

**The mask blanks characters with spaces rather than splicing them out, and keeps every
newline.** The masked copy is the same length with the same line breaks, so every offset a
locator returns still indexes into the original `raw_text` — which is what keeps the evidence
span verifiable. Splicing would shift every later offset and quietly corrupt the trace. A test
asserts the length and line count are unchanged, because that property is the whole file.

### Where a block ends, when the file contains no structure

A PDF has no sections, only lines, so the boundary has to be reconstructed. The rule: the
heading, plus the run of lines carrying `:` or `?`, capped at 8 lines. That is a structural
property of what these blocks **are** — key/value pairs and one question — not a guess about
capitalisation, which matters because the design already paid for a shape heuristic once:
`Canada`, alone on a line, is short, capitalised, comma-free and digit-free, and it truncated
NovaFleet's billing address.

It is also deliberately **forward-looking and bounded** rather than "walk back to the nearest
heading". Both directions are imperfect; this one's failure mode is better. Over-masking a few
lines turns a field into a flagged `NULL`, while a backwards walk that misses a boundary would
ignore everything to the end of the document. The 8-line cap is a constant in code, not config —
it exists to limit the blast radius of being wrong, and a profile raising it would be removing
the guard rather than tuning it.

On CloudShield the span lands on exactly the four lines above. A test asserts it does **not**
swallow the signature block below it — which is read geometrically, so over-masking there would
have been silent.

### `pattern` and `occurrence`: labels first, always

Two shapes no label covers, both from CloudShield:

| | the document says | mechanism |
|---|---|---|
| `marketplace` | `Azure Private Offer` — a bare line near the top, nothing labelling it | `pattern`, capture group 1 |
| vendor `address` | `…with its principal place of business at 500 Innovation Drive, San Jose,\nCA 95134, and the customer whose…` | `pattern`, anchored on standard legalese |
| buyer `contact_name` | `Customer Billing Name:` — **twice**, for the org and for the person | `occurrence: 2` |

**`find()` tries labels first and falls back to `pattern`.** A label is tied to an explicit
statement in the document; a regex over prose is weaker evidence, so it only answers where no
label does — the same precedence that already lets a labelled party name beat the inferred
issuer. So the base profile's `Vendor Address` label is tried on every order form, and
CloudShield's preamble pattern answers only because that label finds nothing.

`occurrence` is declared rather than inferred for the reason above: the tempting alternative is
*"the value that is not an organisation"*, which is another shape heuristic. It counts **per
label**, so a profile listing its own wording first cannot shift the index of a later synonym.

A pattern spanning a line break stores a whitespace-collapsed value while its **offsets stay on
the original characters** — the same split as a joined multi-line address, or a `DATE` whose
evidence reads `03-01-2025`.

**Regexes in config introduce no new trust assumption.** They are reviewed in the repo and
compiled at load time so a broken one fails at `npm run seed` rather than when the first document
arrives — exactly the rule `customers.yaml` match patterns already follow.

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

### Phase 4 — NovaFleet ✅ *already passing*

The profile-system canary. Exit criterion was "adding a second customer should be nearly free"
— it turned out to need **no customer profile file at all**: NovaFleet scores 48/48 from
`purchase_order/_base.yaml` alone. That is the Adaptability KPI demonstrated rather than
claimed.

### What actually escalates, across all four documents

Enumerated rather than assumed, by running every field's deterministic rule over all four:

| Document | Escalates |
|---|---|
| BrightOps | **nothing** |
| NovaFleet | **nothing** |
| Acme | `payment_terms_days`, `special_terms` |
| CloudShield | `payment_terms_days`, `billing_frequency`, `special_terms` |

**5 escalations across 2 documents; 2 documents need zero calls.** So phase 5 records 5
fixtures — it is not "Acme's phase", and describing it that way was the same mistake as
declaring `strategy: llm` per customer.

CloudShield's `billing_frequency` is the instructive one: Acme writes
`Billing Frequency: Annual` as a plain label, while CloudShield states it only in prose
("Payment will be made annually"). Same field, same profile, one parses and one escalates —
decided by the document.

### Two bugs the enumeration found

**1. The order-form base profile was substantially incomplete.** Auditing it against the PO base
showed it declared no `parties` and no `type_fields` at all — so both order forms would have
extracted no buyer, no vendor, no addresses, no signatures and no quote numbers. Not escalated:
*silently absent*, because an undeclared field is never attempted. (The order-form base was
written before the PO base was rewritten to include those sections, and never back-ported. This
was the third gap found in it — the first two were item date synonyms and `billing_frequency`.)

The lesson: **an undeclared field fails silently, while a failed rule escalates.** Those are
very different outcomes, and only the second is safe. A profile audit comparing the two base
profiles section by section is now a cheap check worth repeating whenever either changes.

**2. An unimplemented strategy fell through to a plain label lookup — and invented data.**
An order form's buyer `signer_name` is declared with the bare label `Name`, pending the
two-column signature strategy. Falling through made it match the **item table header**:

```
signer_name = "Start Date End Date Rate Quantity Total amount"
```

A declared-but-unimplemented strategy now returns `null`, which escalates. Garbage is worse
than nothing: *"could not tell"* and *"here is a value"* are different answers, and only the
first one escalates. Two call sites bypassed the check entirely (`signature_present` and
`signature_date` called their locators directly) and now route through it.

### Phase 5 — wire the escalator

**Not an Acme phase.** Escalation is customer-agnostic: *any* field on *any* document reaches
Claude when its deterministic rule yields nothing or fails to parse. The seam was built in
phase 2 with `escalate: null`; this phase supplies the implementation behind it — the Claude
client in live/record/fixture modes, the recorded fixtures, and the evidence + value-in-quote
verification already written in `llm/evidence.ts`.

An earlier draft of this plan called phase 6 "Acme's prose", which framed needing an LLM as a
property of a customer. It is not. Once wired, a *future* BrightOps document whose wording
changes so `Net 30` no longer parses escalates automatically — no config change and no new
phase. Building it before Acme also means Acme lands complete in one pass instead of sitting
half-extracted for a phase.

**Exit:** Acme's payment terms resolves to `Net 30` by escalation from
*"shall be made within thirty (30) days from invoice"*, while **both POs still make zero
calls** — asserted, not observed.

### Phase 6 — the remaining extraction capabilities ✅

**Not "Acme" and not "CloudShield".** Labelling these by customer was the same error as
declaring `strategy: llm` per customer, and it had a concrete cost: it would have produced a
strategy fitted to one document and then a second one for the other.

| Capability | Exercised by | Previously mislabelled as |
|---|---|---|
| `two_column_signature` ✅ | **both** order forms, **both** columns | phase 6 "Acme" **and** phase 7 "CloudShield" |
| issuer → party name ✅ | both order forms | — (never planned) |
| `default_currency` ✅ | Acme (no ISO code anywhere) | phase 6 "Acme" |
| `ignore_sections` + `in_section` ✅ | CloudShield's decoy PO block | phase 7 |
| `optional_fields` + `pattern` ✅ | CloudShield's marketplace, vendor address | phase 6–7 |
| `type` coercion ✅ | CloudShield's subscription term, `po_required` | — (never planned) |
| `occurrence` ✅ | CloudShield's duplicated billing label | — (never planned) |
| fixture recording | any escalating document | phase 6 "Acme" |

The mechanics of each are in **Profile keys: declared, applied, or deleted** above; what follows
is what wiring them changed about the plan.

**Three capabilities were not in the plan at all** — `pattern`, `occurrence` and applying
`type`. Each exists because a *declared* key turned out to be unusable as written: the
`marketplace` field had the document's **value** written where a label belonged, `contact_name`
needed a label the document reuses for two different things, and `type` had been declared from
the very first profile and never read, so CloudShield's `subscription_term_months` was storing

```
"(unless extended according to the terms of this Order Form): 36.00 months"
```

into a `NUMERIC(6,2)` column. That one is the clearest case of the pattern: the key was present,
the YAML looked right, and nothing failed.

**Acme had no profile file at all.** `default_currency` was already implemented in the money
normaliser and the plan listed it as phase-6 work, which hid the actual gap — there was no
`config/profiles/order_form/acme.yaml` for it to live in. Its date formats (`long_month` for
the document, `short_month_compact` for the item table) and its TAM synonyms were missing with
it. Nothing was broken; the fields were simply never attempted, which is the silent failure the
order-form base profile audit also found.

**The vendor's signature was one declaration, not new code.** The capability already reads
either column and the pipeline already passes `left` for the vendor on an order form — but the
base profile declared the buyer's four signature fields and not the vendor's, so Acme's plainly
signed block (`John Smith`, `CFO`, `12-13-2024`) came back null. Same lesson as the base-profile
audit: an undeclared field fails silently, while a failed rule escalates.

#### Two strategies collapsed into one

An earlier plan had `two_column_signature` for Acme and a separate `placeholder_lines` for
CloudShield. Checking the actual geometry showed the blocks are **structurally identical** —
same two columns, vendor left, buyer right:

| | left column | right column |
|---|---|---|
| Acme | x=77 `Name: John Smith` | x=311 `Name: Bob Lee` |
| CloudShield | x=96 `Name: ____` | x=312 `Name: ____` |

The only difference is whether the chosen column holds a value or blank underscores. So
`placeholder_lines` was never a strategy — it is this one capability's second outcome. It
yields three results rather than two:

| | meaning |
|---|---|
| `true` | the column carries a filled value — Acme, both roles |
| `false` | the block exists but is unfilled — CloudShield, both roles |
| `null` | **no two-column block at all** — a PO. Escalates rather than asserting unsigned |

Column positions are discovered from the document (the anchor line carrying the repeated
`Signature`/underscore marker), not from constants — which is why Acme at x=77/311 and
CloudShield at x=96/312 both work.

#### The issuer already names a party

Order forms never label their vendor — `Vendor Name:` simply does not appear — so the vendor
row was empty on documents that plainly name it. But the issuer is already inferred, and the
issuer **is** one of these parties: the vendor on an order form, the buyer on a PO. Wiring that
fills the gap (`Acme`, `CloudShield Security, Inc.`) while a label-based value always wins,
since it is tied to an explicit statement in the document.

#### Exit state

Both order forms now extract every deterministic field. `tests/unit/orderFormCapabilities.test.ts`
asserts each capability end to end on the real PDFs — every one of them had been declared and
silently doing nothing, so each gets an assertion that fails if the wiring is removed — and the
closing case asserts the only unanswered field on either document is the **prose payment term**:

| | before phase 6 | after |
|---|---|---|
| Acme | `AMBIGUOUS_CURRENCY`, `FIELD_NOT_FOUND` | `FIELD_NOT_FOUND` only |
| CloudShield | `FIELD_NOT_FOUND`, plus `po_amount` and `subscription_term_months` wrong | `FIELD_NOT_FOUND` only |

Both POs still score **48/48** and make **zero** LLM calls, so none of this leaked into the
documents that were already passing.

### Phase 7 — the order forms in the scored set ✅ (fixtures pending a key)

Both order forms are now scored, and **every deterministic value on all four documents is
correct: 230 / 239, 0 wrong.** The nine outstanding values are the prose fields, which need one
recording run with an API key — see the harness section for why the KPI is withheld rather than
printed as a pass until then.

```
LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy    # or: npm run accuracy:record
```

Writing the ground truth was the easy half. Three things in the escalation path turned out to be
wired incorrectly, and none of them would have shown up before an order form was scored.

#### 1. Special terms never escalated — the code counted a call it never made

```ts
if (specialTerms.length === 0 && input.escalate !== null) {
  llmCalls++;                     // ...and that was all
}
```

So no order form ever got special terms, **and** `llmCalls` was a count of *intentions* rather
than calls — which made it unfalsifiable. Both are fixed: the escalator is actually called, its
list is mapped onto `special_terms` rows, and `llmCalls` now comes from the client's `onCall`
hook so a replayed fixture correctly reports **zero**. The question "did this document need the
model?" is a separate field, `escalations`.

That split matters for the design's own claim. `llmCalls === 0` for a purchase order used to be
the evidence that *the rules already parse*; once fixtures exist it would be 0 for Acme too. The
honest assertion is `escalations === []`, and the KPI test now makes both.

#### 2. The escalator was built by the caller, so per-customer synonyms never reached it

`ingest.ts` built it from the document text alone:

```ts
const escalate = buildEscalator({ rawText: parsed.rawText });
```

But the escalator needs the **profile**, and the profile resolves *inside* `runExtraction`.
Acme never writes the phrase "Technical Account Manager" — it names a *"Customer Support Manager
and Product Architect"* — so its `special_terms.synonyms` have to reach the prompt, and
`withSynonyms` was dead code. `PipelineInput.escalate` is now a **factory** called once the
profile is known; `ingest.ts` passes `buildEscalator` itself. Six of the eight call sites
(`escalate: null`) needed no change at all.

#### 3. A legitimate model response could crash the pipeline

Every schema permits `{ value: null, quote: null, not_found_reason }` — the explicit "not
stated" the prompts *ask for* in preference to a guess — and that null `quote` went straight into
`resolveEvidence(quote: string)`. Narrowing through `asQuoted()` turns it into a clean
`FIELD_NOT_FOUND`, which is the right outcome.

The same change made the escalator return `unknown` rather than a claimed `{ value, quote }`,
because the transport genuinely cannot promise one shape: `special_terms` returns
`{ terms: [...] }`, and the **fixture path reads JSON off disk**. So fixtures are now validated
against their schema on replay. A hand-edited or stale fixture used to flow into the pipeline
unchecked — and a malformed one is a hard error for the same reason a missing one is: silence
would be indistinguishable from a model that answered.

#### Evidence verification applies to special terms too

Each returned term's quote must resolve in `raw_text` or the term is **dropped** and
`LLM_EVIDENCE_MISMATCH` flagged — an unverifiable value is treated as no value, never as data.
Two properties of that worth stating, both covered by tests against the real documents:

- It matches **across a line break**. Acme's burst clause wraps mid-sentence
  (`"Customer shall have\nthe right to utilize up to 5% more…"`), and a naive `indexOf` would
  reject the correct answer.
- `term_text` stores **the document's own characters**, not the model's rendering — Acme uses
  curly quotes around `(the "Burst Threshold")` where a model returns ASCII. `term_text` is the
  source of truth and the parsed columns are a projection of it, so it has to be what the page
  actually says.

### Phase 8 — operational layer ✅

`jobs` table + `SKIP LOCKED` claim loop, error classification, backoff, stale-lock reclaim;
polling timer + `scan_inbox` + the write-stability gate + sha256 dedupe; single-transaction
persist including `jobs.status`; graceful SIGTERM shutdown.

Deliberately late — none of it is needed to prove extraction works, and extraction is what's
graded.

**Verified end to end, in containers:** `docker compose up`, drop the four PDFs into `inbox/`,
and all four are picked up by the polling timer and extracted with no further input. The two POs
reach `extracted`; the two order forms reach `needs_review` because their prose payment terms
escalate and there is no API key. `GET /documents/3` renders `03-01-2025` and `Net 30` at the
boundary, and `/trace` re-slices `raw_text` at every recorded offset with `evidenceVerified:
true`.

#### The ingress/work split

`src/ingest.ts` was one function doing both halves. It is now two, because they belong in
different processes:

| | does | runs in |
|---|---|---|
| `ingest/register.ts` | magic bytes, size cap, sha256, archive, `documents` row, enqueue | the scan **or** an HTTP handler |
| `ingest/extract.ts` | re-parse the archived PDF, extract, persist | a claimed job, only |

Nothing is parsed at ingress. `pdfjs-dist` parsing is CPU-bound and single-threaded so it blocks
Node's event loop, and extraction makes network calls — neither belongs in an HTTP handler or
inside a directory sweep.

`extract.ts` re-parses from the **archive** rather than replaying stored layout, which is why
`parsePdfBytes` exists: `StorageAdapter` is the seam for S3, and an S3 backend has no path to
hand to `parsePdf`.

#### Three invariants that needed enforcing rather than documenting

**1. The job completes inside the extraction transaction.** `persistExtraction` takes a `jobId`
and marks the job done as the last statement of the same transaction. The alternative — finish
the job afterwards — leaves a window where a crash yields either a job marked done with no data,
or data with a job still `running` that the stale sweep hands to another worker to redo. The doc
comment on `persist.ts` had claimed this for two phases while `PersistInput` had no such field.

**2. A handler must settle its job.** `ingest`/`reextract` do it in the transaction; the other
two call `finish()` directly. A handler that returns with the row still `running` has left it
locked until the five-minute stale sweep — a silent stall. The loop now checks and says so
loudly.

**3. `raw_text` is written once and then frozen.** The ingress no longer parses, so the first
extraction writes it — via `COALESCE(raw_text, $n)`, in the SQL rather than in a conditional a
future caller can forget. A reprocess may produce better *tables*, but the text that evidence
offsets index into must not shift beneath them.

#### Shutdown needed a deadline, not patience

The first version waited indefinitely for the in-flight job and then released its lock. Writing
a test for it showed the release was **dead code**: a handler that settles normally needs no
release, and `current` was already cleared by the time `stop()` could observe it.

The real requirement is the opposite of patience. `docker compose down` sends SIGTERM and
SIGKILLs after about ten seconds, so waiting indefinitely does not buy the job more time — it
just forfeits the chance to hand the lock back, and the job then waits out the five-minute stale
sweep before anyone retries it. So `stop(graceMs = 8000)`: wait, and if the job is still running,
release the lock and exit. It returns to the queue immediately; its `attempts` was already spent
at claim time, so this cannot become an infinite retry.

#### `attempts` is incremented at CLAIM time

Not on failure. That is what stops a worker crash-looping on one document from retrying forever:
a process killed mid-job has already paid for the attempt, so the stale sweep returns the job
with its budget already spent.

#### Two error codes were declared and never raised

`PDF_CORRUPT` and `PDF_ENCRYPTED` had been in the taxonomy since the design was written, and
nothing produced them — a truncated PDF came through as a bare `pdfjs` exception, classified
`UNKNOWN` and therefore **transient**, so it was retried three times. Found by dropping a
half-written file into the inbox.

The same run found a third: `invalid input syntax for type numeric: "USD 0.00"`. SQLSTATE class
22 (data exception) was not in the classifier, only class 23 — so a value that can never cast was
also retried three times. Both are our bug, so neither may retry. See the `type: money` entry
below; **this is the class of bug that only writing to a real database can produce.**

#### Where `.env` actually reached

Nowhere, locally. `docker compose` reads it via `env_file`, but nothing read it for a local run:
`dotenv` is not a dependency and `--env-file` needs Node 20.6+ while the machine this was built
on has 18. So `npm run migrate` failed on the `DATABASE_URL` guard with a perfectly good URL
sitting in `.env`. `config/dotenv.ts` is a 20-line loader with the precedence that matters — a
variable already in the environment WINS, so `LLM_MODE=record npm run accuracy` is not silently
overridden, docker-compose's own `environment:` block still beats the mounted file, and the
offline test guard cannot be undone by a committed `.env`.

### Phase 9 — the API, spec-first ✅

`openapi.yaml` written **first**, then 16 operations implemented against it, with
`express-openapi-validator` enforcing it at runtime in **both directions**. Swagger UI at
`/docs`, the raw spec at `/openapi.json`, `spectral` in `npm run lint:api`, and
`tests/integration/contract.test.ts` exercising every operation.

| | |
|---|---|
| **ingest** | `POST /documents` (multipart, 1..N), `POST /scan` |
| **inspect** | `GET /health`, `/documents`, `/documents/{id}`, `/{id}/runs`, `/{id}/trace`, `/{id}/file`, `/jobs/{id}`, `/special-terms`, `/customers`, `/customers/{slug}/profiles` |
| **correct** | `PATCH /documents/{id}`, `POST /{id}/reprocess`, `POST /{id}/review`, `POST /documents/reprocess` |

#### Response validation is the part that earns its keep

`validateResponses` is ON, with `additionalProperties: false` on every response schema. So a
handler that returns an undeclared field, omits a required one, or renders a date in the wrong
format **fails the contract test** rather than shipping. That is the whole difference between a
spec and a description, and it is what makes "the hand-written spec cannot silently drift from
behaviour" a fact rather than an aspiration. A response-validation failure surfaces as a **500
with code `INTERNAL`**, named distinctly so it cannot be mistaken for a client error.

It also forced a real improvement. Raw rows could not satisfy those schemas, and they were
leaking the storage layer anyway: `document_id: "3"` as a string (the driver returns BIGINT as
text), snake_case mixed with camelCase inside one object, and internal columns like `raw_text`
and `file_sha256` that a caller has no business seeing. `src/api/present.ts` now shapes every
response, and it is the single place where three conversions happen — `DATE` → `mm-dd-yyyy`,
`INTEGER` → `Net xx`, and BIGINT → number (money deliberately **not**: it stays a decimal
string).

#### `allowUnknownQueryParameters: false`

`GET /documents?customerSlug=acme` is a **400**, not a silently-ignored filter. A caller who
mistypes a filter name otherwise believes it applied and reads the unfiltered result as the
answer — which is worse than an error.

#### The contract enforces the "no writable extracted values" rule

`PATCH /documents/{id}` declares `additionalProperties: false` over exactly `customerId` and
`docType`, so `{"amount": "1.00"}` is rejected **by the spec** rather than by a hand-written
check somewhere that could be forgotten or bypassed by a new handler.

```
$ curl -X PATCH localhost:3000/documents/1 -d '{"amount":"1.00"}'
{"error":"request/body must NOT have additional properties: /body/amount …","code":"BAD_REQUEST"}
```

#### Six bugs the spec and its validator found

Writing the spec first and then enforcing it surfaced more than the handlers would have:

| | |
|---|---|
| **YAML flow-mapping descriptions split on commas** | `description: Worker id, for debugging` silently became a property named `for debugging`. Spectral caught three. |
| **Multi-line `required:` lists** were parsed as single comma-containing strings, so 17 lists required a property literally named `"id, filename, ingress, …"`. Caught by a schema walk, not by reading. |
| **`nullable` without `type`** is rejected outright by ajv — I had used it beside `oneOf`/`allOf` in three places, which 500'd every single endpoint. |
| **`nullable` beside an `enum` still needs `null` IN the enum.** `nullable` widens the type, not the enumeration. Five places. |
| **`allOf` does NOT compose with `additionalProperties: false`** — each branch is evaluated independently and knows nothing of the other's properties, so `SpecialTermWithDocument` rejected its own `documentId`. A real trap, and only response validation surfaces it. |
| **`doc_type` is nullable and the spec said otherwise.** `needs_classification` is a real state, so an unclassified document returned `docType: null` against a non-nullable enum. This is the same fact that justifies ONE `documents` table rather than one per type. |

And two outside the spec:

- **`registerBytes` returned the document id as a STRING.** The driver returns BIGINT as text,
  and `Number()` was missing — so the id flowed out as `"26"`, compared unequal to `26`
  everywhere downstream, and silently broke the worker's own
  `job.documentId === documentId` check.
- **`?reextract=false` did nothing.** The validator *coerces* a declared boolean query
  parameter, so the handler received `false` rather than `"false"`; comparing against the string
  matched nothing and re-extraction ran anyway. Typing the query bag as
  `Record<string, string | undefined>` is what hid it.

#### Spectral configuration, and what is deliberately off

`.spectral.yaml` requires an `operationId`, a `tag` and a `description` on every operation —
all three are load-bearing rather than decorative: the tags group the Swagger UI and the
operationIds name a generated client. `oas3-unused-component` is a warning rather than an error
because auth is explicitly out of scope for this assignment, and leaving a security rule on
would mean 16 warnings a reader has to learn to ignore.

#### The contract test asserts its own completeness

It cross-checks the spec's `operationId`s against the test source and fails if one is
unexercised — because an endpoint nobody calls is an endpoint response validation never runs
against, which would make the whole mechanism silently partial.

#### Useful side effect: Swagger UI is the UI

Swagger UI renders a real file picker for the multipart upload, so the four sample PDFs can be
submitted from a browser and the results browsed interactively. That covers most of what the
deferred read-only HTML page would have provided, for no extra code — which is why the UI stays
out of scope rather than becoming a phase.

### Phase 10 — README ✅

`README.md` is the brief's second deliverable, written for a reviewer who wants to run it in two
minutes, understand why each decision was made, and verify the accuracy claim themselves.

Every command, output block and number in it was **executed against the running stack** rather
than written from memory — the `POST /scan` responses, the `GET /documents` table, the evidence
span (`start: 777, end: 789, "$162,000 USD"`) and the `PATCH` rejection are all real output.
Two things that caught, which is the argument for doing it that way:

- The scan example had been written as the *idealised* `enqueued: 4`. The real first call returns
  **`unstable: 4`** — the write-stability gate holding back files copied moments ago, which is a
  feature worth showing rather than an inconvenience to hide. The second call returns
  `duplicate: 4`, because the polling timer got there first.
- The integration test count was stated as 38 and is 39.

It documents `docs/DESIGN.md` as the long form: *"where the reasoning lives — including the parts
that were wrong first."* The split is deliberate. The README answers "how do I use this and why
is it built this way"; DESIGN.md keeps the full record, including every design that had to be
reversed.

#### The Limitations section states what does not work

Eight entries, because a reviewer should not have to discover them: no OCR (image-only scans fail
fast as `NO_TEXT_LAYER` rather than silently extracting nothing), nine prose values awaiting one
recording run, no UI beyond Swagger, **no authentication at all** — every endpoint is open and
`GET /jobs/{id}` exposes a worker hostname, so it is explicitly not deployable as-is — one
document-type pair, a new date or money *format* needing code rather than config, Burst→item
attribution as the softest extraction, and a single serial worker.

It also separates the four assumptions the assigner **confirmed by email** from the two scoped out
by decision, so a reader can tell which constraints were verified and which were chosen.

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

npm test            # offline, no API key. LLM_MODE=live/record is REFUSED here
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
