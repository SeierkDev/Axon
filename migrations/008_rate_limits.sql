CREATE TABLE rate_limit_windows (
  key      TEXT    NOT NULL PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL  -- epoch milliseconds
);
