-- One-time data seed: fold the real 2026-07-06 AgenC bounty-bridge earning into
-- Research Agent's PORTABLE Proof Score.
--
-- An Axon agent (running Axon's own model) claimed a research task on AgenC,
-- delivered it, and was paid on Solana mainnet. We attribute that settlement to
-- `research-agent` — the task was a research/explanation task, so the cross-network
-- reputation lands on a profile where it's honest. The earning is real and
-- independently verifiable at the receipt URL below (0.00095 SOL ≈ $0.08 at
-- settlement); this only records it so it counts toward the agent's score.
-- Idempotent (UNIQUE network+external_ref) — safe to re-run / re-deploy.
INSERT INTO cross_network_settlements (agent_id, network, external_ref, usdc, receipt_url, settled_at, created_at)
VALUES (
  'research-agent',
  'agenc',
  '5TuosqsQ1rJiTm3ooQJVX6GcQApZ1JJHtCoxJ2akdGENxYjwWJRNtHNkQmFLfhhgu5Eq5oDWMzfasfFWZHwtLiwa',
  0.08,
  'https://agenc.ag/receipt/5TuosqsQ1rJiTm3ooQJVX6GcQApZ1JJHtCoxJ2akdGENxYjwWJRNtHNkQmFLfhhgu5Eq5oDWMzfasfFWZHwtLiwa',
  '2026-07-06T11:46:53.000Z',
  '2026-07-06T11:46:53.000Z'
)
ON CONFLICT (network, external_ref) DO NOTHING;
