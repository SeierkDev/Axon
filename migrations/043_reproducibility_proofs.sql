-- Reproducibility proofs — Proof Layer #2.
--
-- A receipt proves a task ran and settled. Reproducibility proves it ran *right*:
-- the task is re-run deterministically (temperature 0, pinned to the originally-
-- used model, the recorded input frozen) and the new output is compared to the
-- original. Exact output-hash match → "exact"; otherwise a published, recomputable
-- lexical similarity decides "equivalent" (semantically the same work) vs
-- "divergent".
--
-- Privacy rule matches receipts + traces (migration 039): the PUBLIC face exposes
-- only hashes, the verdict, the similarity, and the published method — NEVER the
-- output text. The reproduced_output column stays private (owner-recomputable via
-- the authed path); the public API returns everything except it.
CREATE TABLE IF NOT EXISTS reproducibility_proofs (
  task_id                TEXT PRIMARY KEY,
  verdict                TEXT NOT NULL,     -- exact | equivalent | divergent
  similarity             REAL NOT NULL,     -- 0..1 lexical cosine over token frequencies
  original_output_hash   TEXT NOT NULL,     -- sha256 of the receipt's committed output
  reproduced_output      TEXT NOT NULL,     -- the re-run output (private; owner-recomputable)
  reproduced_output_hash TEXT NOT NULL,     -- sha256 of the re-run output
  model                  TEXT,              -- model used for the deterministic re-run
  temperature            REAL NOT NULL,     -- 0 for a deterministic re-run
  method                 TEXT NOT NULL,     -- JSON: {formula, threshold, inputHash, note}
  content_hash           TEXT NOT NULL,     -- sha256 of canonical proof body (tamper-evident/citable)
  reproduced_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repro_proofs_verdict ON reproducibility_proofs(verdict);
