// Buy a good from AgenC's goods market — from inside Axon, non-custodially.
//
// The federation "goods leg", mirroring the hire-through (agencHire.ts): the user
// signs + pays with their OWN Phantom wallet; Axon only reads AgenC's on-chain
// goods listing and composes an UNSIGNED `purchase_good` transaction for the
// wallet to sign. No Axon funds, no secret key, no middleman wallet. The buyer is
// a bare wallet — AgenC's goods purchase needs no agent registration (unlike a
// hire), so this is a single unsigned transaction.
//
// Discovery reads AgenC's PUBLIC goods feed (agenc.ag/api/goods) and surfaces the
// items in the Axon marketplace. Server-only (imports the marketplace SDK; NEVER
// import into client code).

import {
  fetchGoodsListing,
  facade,
  findProtocolConfigPda,
  fetchProtocolConfig,
  findModerationBlockPda,
} from "@tetsuo-ai/marketplace-sdk";
import { createSolanaRpc, address, createNoopSigner } from "@solana/kit";
import { buildUnsignedTx } from "./agencHire";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const GOODS_FEED = process.env.AGENC_GOODS_FEED ?? "https://agenc.ag/api/goods";
const TTL_MS = 5 * 60 * 1000; // cache 5 min — the feed is dynamic, don't refetch per request
const MAX_ITEMS = 12;
// `Pubkey::default()` (32 zero bytes) — the "no operator leg" sentinel on the
// goods listing. Base58-encodes to 32 ones, same string as the System Program.
const NO_OPERATOR = "11111111111111111111111111111111";

// ── Discovery ────────────────────────────────────────────────────────────────

export interface AgencGood {
  id: string; // goods listing PDA (also the sale target)
  name: string;
  description: string | null;
  category: string | null;
  price: string; // human amount, e.g. "0.002"
  currency: string; // "SOL" or "USDC" (or a mint address)
  remaining: number; // units left (totalSupply - soldCount)
  totalSupply: number;
  soldCount: number;
  restockCount: number;
  sellerAgent: string;
  verified: boolean; // AgenC metadata verification state
  url: string; // agenc.ag goods page (view on AgenC)
  // Portable Axon Proof Score, attached by the API route when the seller maps
  // to an agent Axon knows (cross-listed). Absent/null = no portable proof yet.
  axonProof?: import("./agencProof").AgencAxonProof | null;
}

interface RawGood {
  pda?: string;
  name?: string;
  sellerAgent?: string;
  priceLamports?: string;
  priceMint?: string | null;
  operator?: string | null;
  totalSupply?: string;
  soldCount?: string;
  remainingSupply?: string;
  restockCount?: number;
  isActive?: boolean;
  metadata?: { state?: string; displayName?: string; longDescription?: string; category?: string } | null;
}

// USDC mainnet mint — render its price in USDC; any other mint shows the raw mint;
// null mint = native SOL.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS = 1_000_000_000;
const USDC_UNITS = 1_000_000;

function priceDisplay(lamports: string, mint: string | null | undefined): { price: string; currency: string } {
  const raw = (() => {
    try {
      return BigInt(lamports || "0");
    } catch {
      return 0n;
    }
  })();
  if (!mint) return { price: (Number(raw) / LAMPORTS).toString(), currency: "SOL" };
  if (mint === USDC_MINT) return { price: (Number(raw) / USDC_UNITS).toString(), currency: "USDC" };
  return { price: raw.toString(), currency: `${mint.slice(0, 4)}…` };
}

function normalize(g: RawGood): AgencGood {
  const soldCount = Number(g.soldCount ?? "0") || 0;
  const totalSupply = Number(g.totalSupply ?? "0") || 0;
  const remaining =
    typeof g.remainingSupply === "string" ? Number(g.remainingSupply) || 0 : Math.max(0, totalSupply - soldCount);
  const { price, currency } = priceDisplay(g.priceLamports ?? "0", g.priceMint);
  const id = typeof g.pda === "string" ? g.pda : "";
  return {
    id,
    name: typeof g.name === "string" ? g.name.trim() : g.metadata?.displayName?.trim() ?? "",
    description: typeof g.metadata?.longDescription === "string" ? g.metadata.longDescription.trim() || null : null,
    category: typeof g.metadata?.category === "string" ? g.metadata.category : null,
    price,
    currency,
    remaining,
    totalSupply,
    soldCount,
    restockCount: typeof g.restockCount === "number" ? g.restockCount : 0,
    sellerAgent: typeof g.sellerAgent === "string" ? g.sellerAgent : "",
    verified: g.metadata?.state === "verified",
    // Canonical AgenC goods page, never a feed-supplied href.
    url: `https://agenc.ag/goods/${id}`,
  };
}

let cache: { at: number; goods: AgencGood[] } | null = null;

// Fetch + normalize AgenC's public goods listings. Fails SOFT to [] (or the last
// good cache) on any outage — a marketplace section must never take down /agents.
export async function getAgencGoods(): Promise<AgencGood[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.goods;
  try {
    const res = await fetch(GOODS_FEED, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`goods feed ${res.status}`);
    const json = (await res.json()) as { items?: RawGood[] } | RawGood[];
    const raw = Array.isArray(json) ? json : json.items ?? [];
    const goods = raw
      // Only SOL-priced goods with no operator leg are buyable from Axon today: the
      // token/operator purchase path needs extra accounts (ATAs, operator wallet)
      // we don't compose yet, so we never advertise a Buy we can't fulfil (that
      // would cost the buyer a failed-tx fee). Token/operator goods → buy on AgenC.
      // Treat both null and the system-program sentinel as "no operator" so the
      // feed filter agrees with prepareBuy's on-chain guard.
      .filter((g) => !g.priceMint && (!g.operator || g.operator === NO_OPERATOR))
      .map(normalize)
      // Keep sold-out goods so the section persists and shows a real completed sale
      // (the card renders "Sold out · N sold" with Buy disabled). In-stock first.
      .filter((g) => g.id && g.name)
      .sort((a, b) => Number(b.remaining > 0) - Number(a.remaining > 0))
      .slice(0, MAX_ITEMS);
    cache = { at: Date.now(), goods };
    return goods;
  } catch {
    return cache?.goods ?? [];
  }
}

// ── Buy-through (the user pays with their OWN wallet) ────────────────────────

export interface PrepareBuyResult {
  buyTx: string; // base64 unsigned purchase_good tx — the user's Phantom signs + pays
  goodPda: string;
  serial: string; // the unit serial this purchase mints (= soldCount at prepare time)
  price: string; // human price
  currency: string;
  // The client links to the actual purchase tx (it holds the signature post-sign),
  // so the server returns no explorer URL — the listing account isn't the sale.
}

// Read the goods listing on-chain, guard it, and return an unsigned purchase_good
// transaction. Price + serial are pinned from the CURRENT on-chain state so a
// stale feed can't make the buyer overpay or race a sold-out unit (the program's
// expected_price / expected_serial gates reject a mismatch anyway).
export async function prepareBuy(opts: { goodPda: string; buyerPubkey: string }): Promise<PrepareBuyResult> {
  const rpc = createSolanaRpc(RPC_URL);
  const buyer = createNoopSigner(address(opts.buyerPubkey));
  const good = address(opts.goodPda);

  const acct = await fetchGoodsListing(rpc, good);
  const d = acct.data;

  if (!d.isActive) throw new Error("this good is no longer for sale");
  if (d.soldCount >= d.totalSupply) throw new Error("this good is sold out");
  if (String(d.sellerAuthority) === opts.buyerPubkey) {
    throw new Error("this good is listed by your wallet — AgenC rejects self-purchase");
  }
  // Only the SOL, no-operator purchase path is composed (see getAgencGoods). Refuse
  // anything else here too — composing a token/operator buy without the extra
  // accounts would revert on-chain and cost the buyer a wasted fee.
  if (d.priceMint.__option === "Some") {
    throw new Error("token-priced goods can't be bought from Axon yet — buy this one on AgenC directly");
  }
  if (String(d.operator) !== NO_OPERATOR) {
    throw new Error("goods with an operator fee leg can't be bought from Axon yet — buy this one on AgenC directly");
  }

  // treasury = the protocol config's fee treasury; moderationBlock = the content-
  // addressed block-floor PDA over this good's metadata (empty for an un-blocked
  // good, so the purchase passes) — both required by purchase_good and NOT
  // auto-derived by the facade.
  const [protocolConfig] = await findProtocolConfigPda();
  const cfg = await fetchProtocolConfig(rpc, protocolConfig);
  const [moderationBlock] = await findModerationBlockPda({ contentHash: d.metadataHash });

  const buyIx = await facade.purchaseGood({
    good,
    sellerAgent: d.seller,
    sellerWallet: d.sellerAuthority,
    authority: buyer,
    treasury: cfg.data.treasury,
    moderationBlock,
    expectedSerial: d.soldCount,
    expectedPrice: d.price,
  });

  const buyTx = await buildUnsignedTx(rpc, buyer, [buyIx]);
  // priceMint is guaranteed None here (guarded above), so the price is always SOL.
  const { price, currency } = priceDisplay(d.price.toString(), null);

  return {
    buyTx,
    goodPda: String(good),
    serial: d.soldCount.toString(),
    price,
    currency,
  };
}
