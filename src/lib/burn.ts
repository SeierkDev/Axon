// Platform earnings go to the Splitter, and the Splitter feeds the burn.
//
// What this used to do: buy $AXON on Jupiter with accumulated USDC and burn the tokens itself. That
// whole path is gone. The contracts do the buying and the burning now, on their own schedule, and
// this module's only job is to move what the platform has earned to the address that feeds them.
//
// The proportions are fixed in the Splitter at deploy time and no one can change them, this process
// included. Nothing here decides how much is burned.
//
// Sending money is not idempotent, so rows are CLAIMED before the transfer and settled after it. A
// run that dies mid-flight leaves them claimed with the hash in the log, which is recoverable;
// re-reading them as pending would send the same earnings a second time.

import { encodeFunctionData } from "viem";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { PAYMENT_RECEIVER_WALLET_ADDRESS, toWei, weiToEth, formatEth } from "./money";
import { normalizeAddress, sameAddress } from "./address";
import { publicClient, walletClientFor, withRpc } from "./evm";

/** Below this, gas is a meaningful share of the transfer, so it waits for the next run. */
export const MIN_FORWARD_WEI = 1_000_000_000_000_000n; // 0.001 ETH, the pot's own minimum burn

export function splitterAddress(): string | null {
  return normalizeAddress(process.env.AXON_SPLITTER_ADDRESS);
}

export function burnPotAddress(): string | null {
  return normalizeAddress(process.env.AXON_BURN_POT_ADDRESS);
}

export interface BurnResult {
  skipped: boolean;
  reason?: string;
  /** what was queued when the run started */
  pendingEth: number;
  /** what actually moved */
  forwardedEth?: number;
  transferHash?: string;
  distributeHash?: string;
  txIds: string[];
}

interface PendingRow {
  tx_id: string;
  amount_eth: number;
}

/**
 * Move everything the platform has earned since the last run into the Splitter.
 *
 * Two steps on-chain: send the ETH, then tell the Splitter to split it. The second is separate
 * because `receive()` only accepts the ETH and `distribute()` is what divides it. Anyone may call
 * distribute, so a failure there is not a loss: the ETH sits in the Splitter until someone does.
 */
export async function forwardEarningsToSplitter(): Promise<BurnResult> {
  const db = getDb();
  const splitter = splitterAddress();
  if (!splitter) {
    return { skipped: true, reason: "AXON_SPLITTER_ADDRESS is not set", pendingEth: 0, txIds: [] };
  }

  // Claim the rows before sending anything. Reading and marking in one transaction means two runs
  // overlapping cannot both pick up the same earnings.
  const claimId = `claim-${Date.now().toString(36)}`;
  const claimed = db.transaction((): PendingRow[] => {
    const rows = db
      .prepare("SELECT tx_id, amount_eth FROM transactions WHERE burn_status = 'pending'")
      .all() as PendingRow[];
    if (rows.length === 0) return rows;
    const mark = db.prepare(
      "UPDATE transactions SET burn_status = ? WHERE tx_id = ? AND burn_status = 'pending'",
    );
    return rows.filter((r) => mark.run(claimId, r.tx_id).changes > 0);
  })();

  const pendingWei = claimed.reduce((sum, r) => sum + (toWei(r.amount_eth) ?? 0n), 0n);
  const txIds = claimed.map((r) => r.tx_id);
  const release = (status: string) => {
    const stmt = db.prepare("UPDATE transactions SET burn_status = ? WHERE tx_id = ?");
    db.transaction(() => {
      for (const id of txIds) stmt.run(status, id);
    })();
    void syncToTurso();
  };

  if (pendingWei < MIN_FORWARD_WEI) {
    release("pending"); // back on the queue; they accumulate until they are worth a transaction
    logger.info("burn.skipped", "Nothing worth forwarding yet", {
      pending: formatEth(pendingWei),
      minimum: formatEth(MIN_FORWARD_WEI),
    });
    return {
      skipped: true,
      reason: `Below the minimum of ${formatEth(MIN_FORWARD_WEI)}`,
      pendingEth: weiToEth(pendingWei),
      txIds,
    };
  }

  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) {
    release("pending");
    throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");
  }

  let transferHash = "";
  try {
    const { account, client } = walletClientFor(rawKey);
    if (!sameAddress(account.address, PAYMENT_RECEIVER_WALLET_ADDRESS)) {
      throw new Error("REFUND_SIGNER_PRIVATE_KEY does not match PAYMENT_RECEIVER_WALLET_ADDRESS");
    }

    // The ledger says what was earned; the wallet says what is actually there. Sending more than
    // the balance just fails, so check first and say so plainly rather than stranding the run.
    const balance = await withRpc(async (request) =>
      BigInt(await request<string>("eth_getBalance", [account.address, "latest"])),
    );
    if (balance < pendingWei) {
      release("pending");
      logger.warn("burn.underfunded", "Treasury holds less than the ledger says is queued", {
        balance: formatEth(balance),
        pending: formatEth(pendingWei),
      });
      return {
        skipped: true,
        reason: `Treasury holds ${formatEth(balance)}, less than the ${formatEth(pendingWei)} queued`,
        pendingEth: weiToEth(pendingWei),
        txIds,
      };
    }

    transferHash = await client.sendTransaction({ to: splitter as `0x${string}`, value: pendingWei });
    const receipt = await publicClient().waitForTransactionReceipt({
      hash: transferHash as `0x${string}`,
      timeout: 180_000,
    });
    if (receipt.status !== "success") throw new Error(`transfer ${transferHash} reverted on-chain`);
  } catch (err) {
    // Nothing moved, or we cannot prove it did. Put the rows back so the next run tries again
    // rather than quietly writing the earnings off.
    release("pending");
    logger.error("burn.forward_failed", "Could not forward earnings to the Splitter", {
      err,
      pending: formatEth(pendingWei),
      transferHash: transferHash || undefined,
    });
    throw err;
  }

  // The ETH has left the treasury and is in the Splitter. From here nothing can be lost, so the
  // rows settle even if the split itself has to wait for another caller.
  release("burned");
  logger.info("burn.forwarded", "Platform earnings forwarded to the Splitter", {
    amount: formatEth(pendingWei),
    transferHash,
    rows: txIds.length,
  });

  let distributeHash: string | undefined;
  try {
    distributeHash = await callDistribute(rawKey, splitter);
  } catch (err) {
    // Not a failure of this run: the ETH is already where it needs to be, and distribute() is
    // callable by anyone, so the next run or any other caller splits it.
    logger.warn("burn.distribute_deferred", "Forwarded, but the split has not run yet", { err, transferHash });
  }

  return {
    skipped: false,
    pendingEth: weiToEth(pendingWei),
    forwardedEth: weiToEth(pendingWei),
    transferHash,
    distributeHash,
    txIds,
  };
}

const DISTRIBUTE_ABI = [
  { type: "function", name: "distribute", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

/** Tell the Splitter to divide whatever it holds. Callable by anyone; we just happen to be here. */
export async function callDistribute(privateKey: string, splitter: string): Promise<string> {
  const { client } = walletClientFor(privateKey);
  const hash = await client.sendTransaction({
    to: splitter as `0x${string}`,
    data: encodeFunctionData({ abi: DISTRIBUTE_ABI, functionName: "distribute" }),
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`distribute ${hash} reverted on-chain`);
  return hash;
}

/** The name the cron schedule already calls. */
export const executeDailyBurn = forwardEarningsToSplitter;

const POT_ABI = [
  { type: "function", name: "totalEthBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalTokensBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "burnCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export interface BurnStats {
  /** forwarded by this process, from its own ledger */
  totalForwardedEth: number;
  totalForwards: number;
  pendingEth: number;
  /** read from the pot itself, when one is configured. The chain is the authority on what burned. */
  onChain?: { totalEthBurned: number; totalTokensBurned: number; burnCount: number };
}

/**
 * What has gone toward the burn, and what the chain says came of it.
 *
 * The ledger only knows what this process sent. It cannot know what was burned, because the pot
 * burns on its own schedule long after the money arrives, so those figures are read from the pot
 * rather than inferred here.
 */
export async function getBurnStats(): Promise<BurnStats> {
  const db = getDb();
  const forwarded = db
    .prepare(
      "SELECT COALESCE(SUM(amount_eth), 0) AS total, COUNT(*) AS count FROM transactions WHERE burn_status = 'burned'",
    )
    .get() as { total: number; count: number };
  const pending = db
    .prepare("SELECT COALESCE(SUM(amount_eth), 0) AS total FROM transactions WHERE burn_status = 'pending'")
    .get() as { total: number };

  const stats: BurnStats = {
    totalForwardedEth: weiToEth(toWei(forwarded.total) ?? 0n),
    totalForwards: forwarded.count,
    pendingEth: weiToEth(toWei(pending.total) ?? 0n),
  };

  const pot = burnPotAddress();
  if (!pot) return stats;
  try {
    const client = publicClient();
    const [ethBurned, tokensBurned, count] = await Promise.all([
      client.readContract({ address: pot as `0x${string}`, abi: POT_ABI, functionName: "totalEthBurned" }),
      client.readContract({ address: pot as `0x${string}`, abi: POT_ABI, functionName: "totalTokensBurned" }),
      client.readContract({ address: pot as `0x${string}`, abi: POT_ABI, functionName: "burnCount" }),
    ]);
    stats.onChain = {
      totalEthBurned: weiToEth(ethBurned as bigint),
      totalTokensBurned: weiToEth(tokensBurned as bigint),
      burnCount: Number(count as bigint),
    };
  } catch (err) {
    // A pot that cannot be read is no reason to fail the whole call: the ledger half is still true,
    // and saying nothing about the chain is better than guessing at it.
    logger.warn("burn.pot_unreadable", "Could not read the burn pot", { err, pot });
  }
  return stats;
}
