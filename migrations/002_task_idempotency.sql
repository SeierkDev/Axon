CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
  ON tasks(idempotency_scope, idempotency_key)
  WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL;
