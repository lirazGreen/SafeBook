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

### Without Docker

Two things run with **no database and no API key**, which is deliberate — it is what makes the
accuracy number reproducible from a fresh clone:

```bash
npm install
npm run accuracy    # scores the real pipeline against hand-read ground truth
npm test            # 289 tests; the 39 that need Postgres skip themselves, with a reason
```

---

## Accuracy

```
  230 / 239 scored values  =  96.2%
  9 pending — fields that must escalate, with no fixture recorded yet
```

**Zero wrong.** Every value that can be extracted without a language model is correct on all
four documents — document fields, both parties, type-specific details, every item column and
every special term.

The nine outstanding values are the prose fields (payment terms on both order forms,
CloudShield's billing frequency, and the Burst/TAM special terms). They need **one recording run
with an API key**:

```bash
LLM_MODE=record ANTHROPIC_API_KEY=... npm run accuracy   # or: npm run accuracy:record
```

Until then the harness reports the KPI as **NOT YET MEASURABLE** rather than as a pass. That is
a deliberate choice: a "≥95%" computed over only the fields that did not need a model is a claim
about a *smaller problem than the brief set* — the prose fields are precisely what the hybrid
design exists for. Hand-writing those fixtures would be worse still, because it would score the
pipeline against an invention of what the model might say.

Every item table reconciles exactly against its stated total, which is the check that makes the
rest trustworthy:

| | Σ items | stated |
|---|---|---|
| Acme | 50,000 + 60,000 + 25,000 + 12,500 + 5,000 | **152,500** ✓ |
| CloudShield | 7,020,000 + 275,000 + 7,605,000 + 275,000 + 8,190,000 + 275,000 | **23,640,000** ✓ |
| BrightOps | 72,000 + 78,000 + 6,000 + 6,000 | **162,000** ✓ |
| NovaFleet | 120,000 + 132,000 + 145,000 + 54,000 | **451,000** ✓ |

---

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
npm test            # 289 tests
npm run accuracy    # the scored number
npm run typecheck
npm run lint:api
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
| **Nine prose values await one recording run with an API key.** | The deterministic 230/239 is final; the full KPI is reported as not-yet-measurable rather than inflated. See [Accuracy](#accuracy). |
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
openapi.yaml                       the contract
docs/DESIGN.md                     the full design record, including what went wrong
```

`docs/DESIGN.md` is the long form: every decision, why the alternative was rejected, and the bugs
that changed the design. It is where the reasoning lives — including the parts that were wrong
first.
