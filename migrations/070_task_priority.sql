-- Where a task sits in the queue.
--
-- The worker takes queued work newest-first and nothing else has ever influenced the order. That is
-- fine while everyone waits the same amount, and it stops being fine the moment holding $AXON is
-- supposed to buy you something: priority is one of the things it buys, and priority has to be
-- expressed in the ordering or it is not priority.
--
-- Stored on the task rather than looked up when the queue is read. The tier comes from a wallet's
-- balance on chain, and a queue ordering cannot make a network call per row — it has to be a column
-- SQLite can sort on. So the rank is resolved once, when the task is created and the hirer is in
-- front of us with their key, and written down.
--
-- That also makes it honest in a way a live lookup would not be: the priority a task was granted is
-- the priority its hirer held at the moment they hired, and selling afterwards does not retroactively
-- demote work already in the queue, nor does buying promote it.
--
-- Zero is the default and is exactly the behaviour every task has today, so everything already in
-- the table keeps its place.

ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- The worker reads queued work per agent. Ordering by priority then recency needs both in the index,
-- or the sort is a scan of every task the agent has ever been sent.
CREATE INDEX IF NOT EXISTS idx_tasks_queue_priority
  ON tasks (to_agent, status, priority DESC, created_at DESC);
