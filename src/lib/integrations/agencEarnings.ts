import { recordCrossNetworkSettlement, type CrossNetworkSettlement } from "../crossNetwork";

// Fold an AgenC earning into an Axon agent's portable Proof Score.
//
// AgenC settles in SOL; the Proof Score is denominated in USDC (its volume anchor
// is 200 USDC). So we convert the settled SOL to its USDC value at settlement time
// and record it as a cross-network settlement, carrying AgenC's own receipt so the
// score stays independently verifiable — an agent's reputation follows it across
// networks instead of resetting at the boundary.

const SOL_PRICE_URL =
  process.env.SOL_PRICE_URL ?? "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Live SOL→USDC. Throws (rather than guessing) if the price is unavailable — the
// caller decides whether to skip recording, so we never fabricate a value.
export async function solToUsdc(sol: number): Promise<number> {
  const r = await fetch(SOL_PRICE_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`SOL price lookup failed: HTTP ${r.status}`);
  const d = (await r.json()) as { solana?: { usd?: number } };
  const price = d.solana?.usd;
  if (typeof price !== "number" || price <= 0) throw new Error("SOL price unavailable");
  return Math.round(sol * price * 100) / 100; // USDC, 2dp
}

export interface AgencEarning {
  agentId: string; // the Axon agent to credit
  sol: number; // SOL settled to the agent on AgenC
  settleSig: string; // AgenC accept/settle tx signature — also the receipt id
  settledAt: string; // ISO
  usdc?: number; // optional pre-computed USDC value (skips the live price lookup)
}

// Record an AgenC earning against an Axon agent's Proof Score. Idempotent by the
// settle signature (recordCrossNetworkSettlement de-dupes on network+externalRef),
// so re-running never double-counts. Returns the recorded settlement.
export async function recordAgencEarning(e: AgencEarning): Promise<CrossNetworkSettlement> {
  const usdc = e.usdc ?? (await solToUsdc(e.sol));
  const settlement: CrossNetworkSettlement = {
    agentId: e.agentId,
    network: "agenc",
    externalRef: e.settleSig,
    usdc,
    receiptUrl: `https://agenc.ag/receipt/${e.settleSig}`,
    settledAt: e.settledAt,
  };
  recordCrossNetworkSettlement(settlement);
  return settlement;
}
