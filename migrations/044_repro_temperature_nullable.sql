-- Reproducibility proofs: temperature must be nullable.
--
-- Current Claude models deprecate the temperature parameter entirely (the API
-- rejects it with a 400), so a re-run against an Anthropic-backed agent cannot
-- set temperature 0 — the proof records NULL there instead of claiming a knob
-- that was never applied. 043 declared the column NOT NULL; rebuild the table
-- (safe: no proof could ever persist before this fix, so it is empty).
DROP TABLE IF EXISTS reproducibility_proofs;
CREATE TABLE IF NOT EXISTS reproducibility_proofs (
  task_id                TEXT PRIMARY KEY,
  verdict                TEXT NOT NULL,     -- exact | equivalent | divergent
  similarity             REAL NOT NULL,     -- 0..1 lexical cosine over token frequencies
  original_output_hash   TEXT NOT NULL,     -- sha256 of the receipt's committed output
  reproduced_output      TEXT NOT NULL,     -- the re-run output (private; owner-recomputable)
  reproduced_output_hash TEXT NOT NULL,     -- sha256 of the re-run output
  model                  TEXT,              -- model used for the deterministic re-run
  temperature            REAL,              -- 0 where the provider accepts it; NULL where deprecated (Anthropic)
  method                 TEXT NOT NULL,     -- JSON: {formula, threshold, inputHash, note}
  content_hash           TEXT NOT NULL,     -- sha256 of canonical proof body (tamper-evident/citable)
  reproduced_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repro_proofs_verdict ON reproducibility_proofs(verdict);
