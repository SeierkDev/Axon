import { createHash } from "crypto";
import { getDb } from "./db";
import { postMemoTransaction } from "./solana";
import { logger } from "./logger";

// Memo format: axon:commitment:v1:{taskId}:{sha256hex}
// This is posted to Solana so anyone can independently verify the task output
// by hashing the result and checking it matches the on-chain record.
const MEMO_PREFIX = "axon:commitment:v1";

export interface OutputCommitment {
  hash: string;
  signature: string;
  explorerUrl: string;
}

export function hashOutput(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}

// Posts a Solana memo anchoring the SHA-256 hash of a completed task's output.
// Fire-and-forget safe — never throws. Always stores the hash; stores the
// signature only when the on-chain post succeeds.
export async function commitOutput(taskId: string, output: string): Promise<string | null> {
  const hash = hashOutput(output);
  const memo = `${MEMO_PREFIX}:${taskId}:${hash}`;

  let signature: string | null = null;
  try {
    signature = await postMemoTransaction(memo);
    getDb()
      .prepare("UPDATE tasks SET output_hash = ?, output_commitment = ? WHERE task_id = ?")
      .run(hash, signature, taskId);
    logger.info("output.committed", "Output commitment posted to Solana", {
      taskId,
      hash,
      signature,
    });
  } catch (err) {
    // Store the hash even if the on-chain post failed — it's still locally verifiable
    getDb()
      .prepare("UPDATE tasks SET output_hash = ? WHERE task_id = ?")
      .run(hash, taskId);
    logger.warn("output.commitment_skipped", "Output hash stored locally; Solana post failed", {
      taskId,
      hash,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return signature;
}

export function getOutputCommitment(taskId: string): OutputCommitment | null {
  const row = getDb()
    .prepare("SELECT output_hash, output_commitment FROM tasks WHERE task_id = ?")
    .get(taskId) as { output_hash: string | null; output_commitment: string | null } | undefined;

  if (!row?.output_hash || !row?.output_commitment) return null;

  const cluster = process.env.SOLANA_NETWORK === "devnet" ? "?cluster=devnet" : "";
  return {
    hash: row.output_hash,
    signature: row.output_commitment,
    explorerUrl: `https://explorer.solana.com/tx/${row.output_commitment}${cluster}`,
  };
}
