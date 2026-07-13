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
import { createSolanaRpc, address, createNoopSigner, type Address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
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
      // Buyable from Axon: SOL- or USDC-priced goods, with OR without an operator
      // fee leg. prepareBuy composes the extra token accounts (buyer/seller/treasury/
      // operator ATAs, idempotently created) and the operator wallet when needed.
      // Other mints are still filtered out — we can't render their price honestly
      // (unknown decimals) and don't fulfil them, so we never advertise a Buy we
      // can't complete (a failed tx would cost the buyer a fee). Those → buy on AgenC.
      .filter((g) => !g.priceMint || g.priceMint === USDC_MINT)
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

  // SOL or USDC are composed (see getAgencGoods). Any other mint is refused here
  // too — we can't build its token leg, so composing it would revert on-chain and
  // cost the buyer a wasted fee.
  const mint = d.priceMint.__option === "Some" ? address(String(d.priceMint.value)) : null;
  if (mint && String(mint) !== USDC_MINT) {
    throw new Error("this token isn't supported from Axon yet — buy this one on AgenC directly");
  }
  const hasOperator = String(d.operator) !== NO_OPERATOR;
  const operator = hasOperator ? address(String(d.operator)) : null;

  // treasury = the protocol config's fee treasury; moderationBlock = the content-
  // addressed block-floor PDA over this good's metadata (empty for an un-blocked
  // good, so the purchase passes) — both required by purchase_good and NOT
  // auto-derived by the facade.
  const [protocolConfig] = await findProtocolConfigPda();
  const cfg = await fetchProtocolConfig(rpc, protocolConfig);
  const treasury = cfg.data.treasury;
  const [moderationBlock] = await findModerationBlockPda({ contentHash: d.metadataHash });

  // For a token-priced good the program moves SPL tokens, not lamports, so it needs
  // the buyer/seller/treasury (and operator, if any) associated token accounts. The
  // program has no ATA-program account and can't create them, so any that don't yet
  // exist must be created first — idempotently, so existing ones no-op and the buyer
  // pays rent only for genuinely-missing ones. USDC is the classic SPL Token program.
  const preIxs: ReturnType<typeof getCreateAssociatedTokenIdempotentInstruction>[] = [];
  // Extra accounts merged into the purchase instruction only on the token path;
  // omitted (left null → the facade's "None" placeholder) for the SOL path.
  const tokenLeg: {
    priceMint?: Address;
    buyerTokenAccount?: Address;
    sellerTokenAccount?: Address;
    treasuryTokenAccount?: Address;
    operatorTokenAccount?: Address;
    tokenProgram?: Address;
  } = {};

  if (mint) {
    const ataOf = async (owner: Address) =>
      (await findAssociatedTokenPda({ owner, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint }))[0];
    const buyerAta = await ataOf(address(opts.buyerPubkey));
    const sellerAta = await ataOf(d.sellerAuthority);
    const treasuryAta = await ataOf(treasury);
    preIxs.push(
      getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, ata: buyerAta, owner: address(opts.buyerPubkey), mint }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, ata: sellerAta, owner: d.sellerAuthority, mint }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, ata: treasuryAta, owner: treasury, mint }),
    );
    tokenLeg.priceMint = mint;
    tokenLeg.buyerTokenAccount = buyerAta;
    tokenLeg.sellerTokenAccount = sellerAta;
    tokenLeg.treasuryTokenAccount = treasuryAta;
    tokenLeg.tokenProgram = TOKEN_PROGRAM_ADDRESS;
    if (operator) {
      const operatorAta = await ataOf(operator);
      preIxs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, ata: operatorAta, owner: operator, mint }));
      tokenLeg.operatorTokenAccount = operatorAta;
    }
  }

  const buyIx = await facade.purchaseGood({
    good,
    sellerAgent: d.seller,
    sellerWallet: d.sellerAuthority,
    authority: buyer,
    treasury,
    moderationBlock,
    expectedSerial: d.soldCount,
    expectedPrice: d.price,
    ...(operator ? { operatorWallet: operator } : {}),
    ...tokenLeg,
  });

  const buyTx = await buildUnsignedTx(rpc, buyer, [...preIxs, buyIx]);
  const { price, currency } = priceDisplay(d.price.toString(), mint ? String(mint) : null);

  return {
    buyTx,
    goodPda: String(good),
    serial: d.soldCount.toString(),
    price,
    currency,
  };
}
