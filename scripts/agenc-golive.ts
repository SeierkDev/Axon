/**
 * Register an Axon node as an agent + service listing on AgenC's on-chain
 * marketplace — the first third-party node on their protocol.
 *
 * SAFE BY DEFAULT: runs on devnet with a throwaway airdropped key.
 *   npx tsx scripts/agenc-golive.ts
 *
 * Mainnet (real SOL — reads YOUR keypair locally, never leaves your machine):
 *   CLUSTER=mainnet KEYPAIR=/path/to/id.json npx tsx scripts/agenc-golive.ts
 *
 * It only ever builds AgenC instructions (registerAgent, createServiceListing).
 * There is no SystemProgram.transfer to any address — it cannot move funds
 * anywhere except the protocol's own stake/rent accounts.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { createInterface } from "readline";
import { createMarketplaceClient, findAgentPda, facade } from "@tetsuo-ai/marketplace-sdk";
import { generateKeyPairSigner, createKeyPairSignerFromBytes, createSolanaRpc, lamports, getBase58Encoder } from "@solana/kit";

// Type a literal "yes" to proceed on mainnet — no accidental spends.
function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim().toLowerCase() === "yes"); }));
}

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC_URL = process.env.RPC_URL ?? (CLUSTER === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const STAKE = BigInt(process.env.STAKE ?? "10000000"); // 0.01 SOL min stake
const LISTING_PRICE = BigInt(process.env.PRICE ?? "10000000"); // 0.01 SOL listed price

const sha32 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest()).slice(0, 32);
function fixed(s: string, n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode(s).slice(0, n));
  return b;
}

async function loadSigner() {
  if (CLUSTER === "mainnet") {
    // Key source, in order: SECRET_KEY (base58 string, e.g. Phantom export) or
    // KEYPAIR file (a Solana CLI JSON array, OR a file containing a base58 key).
    // The key is only ever read locally here — it never leaves this machine.
    let secret: Uint8Array;
    const b58 = process.env.SECRET_KEY?.trim();
    if (b58) {
      secret = new Uint8Array(getBase58Encoder().encode(b58));
    } else if (process.env.KEYPAIR) {
      const raw = readFileSync(process.env.KEYPAIR, "utf8").trim();
      secret = raw.startsWith("[")
        ? Uint8Array.from(JSON.parse(raw))
        : new Uint8Array(getBase58Encoder().encode(raw));
    } else {
      throw new Error("mainnet requires SECRET_KEY=<base58> or KEYPAIR=/path/to/id.json");
    }
    if (secret.length !== 64) throw new Error(`expected a 64-byte secret key, got ${secret.length} bytes`);
    return createKeyPairSignerFromBytes(secret);
  }
  // devnet: throwaway key + free airdrop (public faucet is flaky — retry small)
  const s = await generateKeyPairSigner();
  const rpc = createSolanaRpc(RPC_URL);
  console.log("devnet throwaway signer:", s.address);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rpc.requestAirdrop(s.address, lamports(1_000_000_000n)).send();
      break;
    } catch (e) {
      console.log(`  airdrop attempt ${attempt + 1} failed (${e instanceof Error ? e.message.slice(0, 40) : e}), retrying...`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getBalance(s.address).send();
    if (value > 0n) { console.log("airdrop funded:", Number(value) / 1e9, "SOL"); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return s;
}

async function main() {
  console.log(`\n=== AgenC go-live · cluster=${CLUSTER} · rpc=${RPC_URL} ===`);
  const signer = await loadSigner();
  console.log("authority:", signer.address);

  const rpc = createSolanaRpc(RPC_URL);
  const { value: bal } = await rpc.getBalance(signer.address).send();
  console.log("balance:", Number(bal) / 1e9, "SOL");
  if (bal < STAKE + 20_000_000n) throw new Error(`insufficient balance (need ~${Number(STAKE + 20_000_000n) / 1e9} SOL for stake + rent + fees)`);

  if (CLUSTER === "mainnet") {
    console.log(`\n⚠️  MAINNET — this will spend REAL SOL: ~${Number(STAKE) / 1e9} stake + ~0.01 rent/fees.`);
    console.log(`   Wallet: ${signer.address} (balance ${Number(bal) / 1e9} SOL)`);
    if (!(await confirm('   Type "yes" to register Axon on AgenC mainnet: '))) {
      console.log("aborted."); process.exit(0);
    }
  }

  const client = createMarketplaceClient({ rpcUrl: RPC_URL, signer });

  const agentId = sha32("axon-network-node-v1");
  const listingId = sha32("axon-network-node-v1:listing");
  const specHash = sha32("axon:node:capabilities:v1");

  console.log("\n[1/2] registerAgent (stake", Number(STAKE) / 1e9, "SOL) ...");
  const reg = await client.registerAgent({
    authority: signer,
    agentId,
    capabilities: 1n,
    endpoint: "https://axon-agents.com",
    metadataUri: null,
    stakeAmount: STAKE,
  });
  console.log("  registerAgent =>", reg);
  const [agentPda] = await findAgentPda({ agentId });
  console.log("  agent PDA:", agentPda);

  console.log("\n[2/2] createServiceListing (price", Number(LISTING_PRICE) / 1e9, "SOL) ...");
  const list = await client.createServiceListing({
    providerAgent: agentPda,
    authority: signer,
    listingId,
    name: fixed("Axon Network", 32),
    category: fixed("agent-network", 32),
    tags: fixed("axon,cross-listed,third-party-node", 64),
    specHash,
    specUri: `agenc://job-spec/sha256/${Buffer.from(specHash).toString("hex")}`,
    price: LISTING_PRICE,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  console.log("  createServiceListing =>", list);
  const [listingPda] = await facade.findListingPda({ providerAgent: agentPda, listingId });
  console.log("  listing PDA:", listingPda);

  console.log("\n=== DONE ===");
  console.log("agent:  ", agentPda);
  console.log("listing:", listingPda);
  const scan = CLUSTER === "mainnet" ? "" : "?cluster=devnet";
  console.log(`explorer: https://solscan.io/account/${agentPda}${scan}`);
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
