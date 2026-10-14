-- How a document entered the system. Separate from extraction_runs.trigger,
-- which records why extraction RE-ran, not how the file arrived.
--
-- Needed because the folder poll and POST /documents are both normal paths in
-- this deployment: when something looks wrong you want to know which one
-- produced a document, and whether one path has quietly stopped delivering
-- (e.g. uploads still fine while a synced folder stopped syncing).
--
-- On a cross-ingress duplicate the value is NOT overwritten: dedupe is by
-- file_sha256, so the first arrival is the one that was actually processed.
ALTER TABLE documents ADD COLUMN ingress TEXT CHECK (ingress IN ('poll','upload'));

CREATE INDEX ON documents (ingress);
