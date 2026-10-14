#!/usr/bin/env bash
# Asserts the schema encodes the design decisions in docs/DESIGN.md — not just
# that it compiles. Becomes a vitest integration test in phase 2.
#   usage: ./scripts/verify-schema.sh     (needs: docker compose up -d postgres && npm run migrate)
set -uo pipefail
cd "$(dirname "$0")/.."
psql() { docker compose exec -T postgres psql -U safebook -d safebook -qtAX "$@"; }
fails=0
ck() {
  if psql -c "$2" >/dev/null 2>&1; then r=ok; else r=fail; fi
  if [ "$r" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (got $r, wanted $3)"; fails=$((fails+1)); fi
}

psql -c "DELETE FROM jobs; DELETE FROM documents" >/dev/null
psql -c "INSERT INTO documents (file_sha256, original_filename) VALUES ('h1','a.pdf')" >/dev/null

echo "-- format CHECKs reject: if these fire, OUR normaliser is broken, so it should be loud"
ck "currency must be uppercase ISO"  "UPDATE documents SET currency='usd' WHERE file_sha256='h1'"            fail
ck "payment_terms_days must be > 0"  "UPDATE documents SET payment_terms_days=0 WHERE file_sha256='h1'"      fail
ck "doc_type_source constrained"     "UPDATE documents SET doc_type_source='guessed' WHERE file_sha256='h1'" fail

echo "-- value cases deliberately ALLOWED: one odd row must not discard a whole extraction"
ck "negative amount (credit note)"   "UPDATE documents SET amount=-412583.67 WHERE file_sha256='h1'"         ok
ck "reversed date range (flags only)" "UPDATE documents SET start_date='2026-01-01', end_date='2025-01-01' WHERE file_sha256='h1'" ok
ck "NULL product_name (parse miss)"  "INSERT INTO document_items (document_id,line_no,total_amount) SELECT id,1,100 FROM documents WHERE file_sha256='h1'" ok
ck "quantity = 0 (bundled line)"     "INSERT INTO document_items (document_id,line_no,quantity) SELECT id,2,0 FROM documents WHERE file_sha256='h1'" ok
ck "quantity < 0 (flags only)"       "INSERT INTO document_items (document_id,line_no,quantity) SELECT id,3,-5 FROM documents WHERE file_sha256='h1'" ok

echo "-- special_terms: scope is implicit in item_id, no scope column"
ck "document-scoped (TAM)"           "INSERT INTO special_terms (document_id,term_type,term_text) SELECT id,'technical_account_manager','x' FROM documents WHERE file_sha256='h1'" ok
ck "item-scoped (burst)"             "INSERT INTO special_terms (document_id,item_id,term_type,percent,term_text) SELECT d.id,i.id,'burst',38.89,'x' FROM documents d JOIN document_items i ON i.document_id=d.id WHERE d.file_sha256='h1' AND i.line_no=1" ok

echo "-- idempotency and job coalescing"
ck "first scan_inbox queues"         "INSERT INTO jobs (kind) VALUES ('scan_inbox')" ok
ck "repeat POST /scan coalesces"     "INSERT INTO jobs (kind) VALUES ('scan_inbox')" fail
ck "same doc+kind not queued twice"  "INSERT INTO jobs (kind,document_id) SELECT 'ingest',id FROM documents WHERE file_sha256='h1'; INSERT INTO jobs (kind,document_id) SELECT 'ingest',id FROM documents WHERE file_sha256='h1'" fail
ck "duplicate file_sha256 rejected"  "INSERT INTO documents (file_sha256, original_filename) VALUES ('h1','dup.pdf')" fail

psql -c "DELETE FROM jobs; DELETE FROM documents" >/dev/null
echo
[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
