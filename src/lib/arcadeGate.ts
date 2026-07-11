// Axon Arcade — the freemium gate: playing is free, RANKING takes skin in the
// game. A finished time only enters the leaderboard if the connected wallet
// holds ≥ GATE_AMOUNT $AXON. Times always display locally either way.
//
// Casual-leaderboard trust model (documented, deliberate): the client reports
// the wallet with the run; we verify the BALANCE on-chain but not wallet
// ownership (no signature challenge — nothing pays out on this board). If the
// RPC is down we fail OPEN: an outage shouldn't eat a legitimate climb.

import { logger } from "./logger";

// Same mint as src/lib/burn.ts (the buyback-and-burn pipeline).
const AXON_MINT = "6qeQe1LS5yXigxJLUavNmFdbLWbcKLFgnUjqPSpopump";
export const GATE_AMOUNT = 1000; // whole $AXON tokens

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; holds: boolean }>();

// Does this wallet hold at least GATE_AMOUNT $AXON? Balance-only check via
// getTokenAccountsByOwner (parsed), cached 5 min per wallet.
export async function holdsAxon(wallet: string): Promise<boolean> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return false;
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.holds;

  try {
    // Up to 3 attempts: Solana RPCs return rate limits and node errors as
    // JSON-RPC error objects inside an HTTP 200 — treating those as "no
    // accounts" would misread a real holder as broke. Only a genuine
    // `result.value` array counts as an answer.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet, { mint: AXON_MINT }, { encoding: "jsonParsed" }],
        }),
      });
      if (!res.ok) { lastErr = new Error(`rpc http ${res.status}`); continue; }
      const json = (await res.json()) as {
        error?: { code?: number; message?: string };
        result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }[] };
      };
      if (json.error || !Array.isArray(json.result?.value)) {
        lastErr = new Error(`rpc error: ${json.error?.message ?? "no result"}`);
        continue;
      }
      const total = json.result.value.reduce(
        (s, a) => s + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
        0,
      );
      const holds = total >= GATE_AMOUNT;
      cache.set(wallet, { at: Date.now(), holds });
      return holds;
    }
    throw lastErr ?? new Error("rpc failed");
  } catch (err) {
    // Fail open — a leaderboard entry is not worth blocking on an RPC outage.
    // NOT cached: the next call retries for a real answer.
    logger.warn("arcade.gate_rpc_failed", "AXON gate balance check failed — allowing", { err });
    return true;
  }
}

// Test seam.
export function _clearGateCache(): void {
  cache.clear();
}
