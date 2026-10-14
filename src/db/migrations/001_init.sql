-- SafeBook document extraction — initial schema.
-- See docs/DESIGN.md for the reasoning behind each decision.

CREATE TYPE doc_type            AS ENUM ('order_form','purchase_order');
CREATE TYPE customer_resolution AS ENUM ('matched','ambiguous','unmatched','manual');
CREATE TYPE document_status     AS ENUM ('received','needs_classification',
                                         'extracted','needs_review','failed');
CREATE TYPE party_role          AS ENUM ('buyer','vendor');

-- SafeBook's customers: the ISSUER of the document (Acme, CloudShield,
-- BrightOps, NovaFleet). Never a party named on the document.
CREATE TABLE customers (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How an issuer name in the document text maps to a customer. Runtime-editable
-- so registering a 5th customer needs no deploy.
-- No `weight` column: resolution is a COUNT, not a score. Exactly one match
-- wins; two or more is 'ambiguous' and gets flagged rather than guessed.
CREATE TABLE customer_match_patterns (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL CHECK (kind IN ('text','signature_block','doc_id')),
  pattern     TEXT   NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_match_patterns (customer_id);

-- Append-only PROJECTION of config/profiles/*.yaml. The YAML is the single
-- source of truth; `npm run seed` projects it into rows here, and nothing else
-- writes this table — so there is no `source` column and no drift to arbitrate.
-- Rows still need to exist (and be versioned) because extraction_runs.profile_id
-- must point at an immutable record of the exact rules that produced each value.
-- `definition` holds the MERGED result: the seeder resolves `extends: _base`
-- once, so a row is self-contained and no re-merge is needed to interpret it.
CREATE TABLE extraction_profiles (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NULL REFERENCES customers(id) ON DELETE CASCADE, -- NULL = base profile
  doc_type     doc_type NOT NULL,
  version      INT NOT NULL,
  definition   JSONB NOT NULL,
  content_hash TEXT NOT NULL,            -- lets the seeder tell whether the YAML changed
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON extraction_profiles (COALESCE(customer_id,0), doc_type, version);
CREATE UNIQUE INDEX ON extraction_profiles (COALESCE(customer_id,0), doc_type) WHERE is_active;

CREATE TABLE documents (
  id                      BIGSERIAL PRIMARY KEY,
  file_sha256             TEXT NOT NULL UNIQUE,          -- idempotency
  original_filename       TEXT NOT NULL,                 -- stored, never used for logic
  ingress                 TEXT CHECK (ingress IN ('poll','upload')),  -- how it arrived;
                                                 -- not overwritten on a cross-ingress duplicate
  page_count              INT,
  raw_text                TEXT,                          -- frozen: evidence offsets index into it
  storage_key             TEXT,                          -- archive/<sha256>.pdf

  doc_type                doc_type,                      -- NULL until classified
  doc_type_confidence     NUMERIC(4,3),
  doc_type_source         TEXT CHECK (doc_type_source IN ('classified','manual')),

  customer_id             BIGINT NULL REFERENCES customers(id),
  customer_resolution     customer_resolution,
  detected_issuer_name    TEXT,                          -- raw string, even when unmatched

  status                  document_status NOT NULL DEFAULT 'received',
  review_reasons          TEXT[] NOT NULL DEFAULT '{}',
  reviewed_at             TIMESTAMPTZ,
  reviewed_by             TEXT,
  review_note             TEXT,

  -- extracted values (the brief's field set, minus the per-party ones)
  start_date              DATE,
  end_date                DATE,
  amount                  NUMERIC(18,2),
  currency                CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
  payment_terms_days      INT CHECK (payment_terms_days > 0),  -- "Net 30" rendered at the API
  billing_frequency       TEXT,
  attributes              JSONB,                         -- profile-declared optional fields

  current_run_id          BIGINT,                        -- FK added after extraction_runs
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON documents (status);
CREATE INDEX ON documents (ingress);
CREATE INDEX ON documents (customer_id, doc_type);
CREATE INDEX ON documents (customer_resolution) WHERE customer_resolution <> 'matched';
CREATE INDEX ON documents USING GIN (attributes);

-- Both parties, both doc types. All four samples name buyer AND vendor, with very
-- different completeness (Acme's vendor has no address anywhere in the document).
CREATE TABLE document_parties (
  document_id       BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role              party_role NOT NULL,
  name              TEXT,
  address           TEXT,     -- buyer's = the brief's "billing address"
  shipping_address  TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  signature_present BOOLEAN,  -- buyer's = the brief's "customer signature"
  signer_name       TEXT,
  signer_title      TEXT,
  signature_date    DATE,
  PRIMARY KEY (document_id, role)
);

CREATE TABLE order_form_details (
  document_id              BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  quote_number             TEXT,
  quote_date               DATE,
  quote_expiration_date    DATE,
  proposed_by              TEXT,
  subscription_term_months NUMERIC(6,2),
  master_agreement_ref     TEXT,
  po_required              BOOLEAN,
  po_number                TEXT,
  po_amount                NUMERIC(18,2)
);

CREATE TABLE purchase_order_details (
  document_id BIGINT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  po_number   TEXT,
  po_date     DATE
);

CREATE TABLE document_items (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no         INT NOT NULL,
  -- nullable on purpose: if the table parse cannot recover the name, the row's
  -- money still reconciles and is worth keeping. NOT NULL would force dropping
  -- the row and break the sum(items) == amount check.
  product_name    TEXT,
  quantity        NUMERIC(18,4),
  unit_price      NUMERIC(18,4),
  total_amount    NUMERIC(18,2),
  currency        CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
  item_start_date DATE,
  item_end_date   DATE,
  attributes      JSONB,   -- e.g. CloudShield's subscription_year, order_term_months
  -- provenance for values NOT read directly off the page. Empty => all from the document.
  field_sources   JSONB,
  has_inferred    BOOLEAN GENERATED ALWAYS AS
                    (field_sources IS NOT NULL AND field_sources <> '{}'::jsonb) STORED,
  UNIQUE (document_id, line_no)
);
CREATE INDEX ON document_items USING GIN (attributes);
CREATE INDEX ON document_items (document_id) WHERE has_inferred;

-- Natural-language special terms. All four samples have a literal "Special Terms"
-- heading. item_id NULL => document-scoped (no `scope` column: it would duplicate
-- this test). Burst may be either; TAM is always document-scoped.
CREATE TABLE special_terms (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id)      ON DELETE CASCADE,
  item_id     BIGINT NULL     REFERENCES document_items(id) ON DELETE CASCADE,
  term_type   TEXT NOT NULL,   -- burst | technical_account_manager | free_trial |
                               -- tiered_pricing | conversion_right | renewal_cap |
                               -- credit | sla | unknown   (TEXT so new types need no migration)
  ordinal     INT,
  percent     NUMERIC(6,3),
  cap_value   NUMERIC(18,2),
  cap_unit    TEXT,
  period      TEXT,
  applies_to  TEXT,
  term_text   TEXT NOT NULL,   -- as received; source of truth, never modified
  attributes  JSONB,
  page_no     INT
);
CREATE INDEX ON special_terms (document_id, term_type);
CREATE INDEX ON special_terms (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX ON special_terms (percent) WHERE term_type = 'burst';

-- Postgres is the job queue; no Redis.
CREATE TABLE jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('scan_inbox','ingest','reextract','reresolve_customer')),
  document_id  BIGINT REFERENCES documents(id) ON DELETE CASCADE,  -- NULL for scan_inbox
  payload      JSONB,
  result       JSONB,          -- scan summary: found/enqueued/duplicate/unstable
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts     INT  NOT NULL DEFAULT 0,   -- limit is a constant in code; a permanent
                                          -- error sets status='failed' directly
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_class  TEXT CHECK (error_class IN ('transient','permanent')),
  error_code   TEXT,
  error        TEXT,
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX ON jobs (status, run_after) WHERE status = 'queued';
-- the same work cannot be queued twice for one document
CREATE UNIQUE INDEX ON jobs (document_id, kind) WHERE status IN ('queued','running');
-- at most one pending document-less job per kind, so repeat POST /scan calls coalesce
CREATE UNIQUE INDEX ON jobs (kind) WHERE document_id IS NULL AND status IN ('queued','running');

-- Append-only audit log. One row per extraction attempt.
CREATE TABLE extraction_runs (
  id               BIGSERIAL PRIMARY KEY,
  document_id      BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  profile_id       BIGINT REFERENCES extraction_profiles(id),  -- pins the exact version
  trigger          TEXT NOT NULL,
  engine           JSONB,           -- {pdf:'pdfjs-dist@x', model:'claude-opus-5'}
  field_confidence JSONB,           -- per field: value, strategy, evidence {page,start,end,text}
  llm_calls        INT NOT NULL DEFAULT 0,
  outcome          TEXT NOT NULL CHECK (outcome IN ('ok','partial','failed')),
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX ON extraction_runs (document_id, started_at DESC);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_run_fk
  FOREIGN KEY (current_run_id) REFERENCES extraction_runs(id) ON DELETE SET NULL;
