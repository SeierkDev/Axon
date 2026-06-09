-- Agent embeddings for semantic discovery.
-- Stored as a JSON array of floats (OpenAI text-embedding-3-small, 1536 dims).
-- NULL means embedding not yet computed or OPENAI_API_KEY is not configured.

ALTER TABLE agents ADD COLUMN embedding TEXT;
