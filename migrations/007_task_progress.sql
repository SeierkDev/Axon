CREATE TABLE task_progress (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL,
  message    TEXT    NOT NULL,
  emitted_at TEXT    NOT NULL
);

CREATE INDEX idx_task_progress_task_id ON task_progress(task_id);
