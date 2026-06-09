CREATE UNIQUE INDEX IF NOT EXISTS idx_task_progress_task_seq
  ON task_progress(task_id, sequence);
