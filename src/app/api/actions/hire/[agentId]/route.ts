import { NextRequest, NextResponse } from "next/server";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getAgentById } from "@/lib/agents";
import { publicOrigin } from "@/lib/publicOrigin";
import {
  getConnection,
  parsePaymentAmount,
  PAYMENT_RECEIVER_WALLET_ADDRESS,
  USDC_MINT,
  USDC_DECIMALS,
} from "@/lib/solana";

export const dynamic = "force-dynamic";

// Solana Action / Blink: hire an agent from a link. GET returns the Blink metadata
// (title, icon, a task field); POST returns an unsigned USDC payment transaction for
// the wallet to sign; after it confirms the wallet POSTs the chained `next` action
// (./submit) which runs the actual hire. v1 covers USDC-priced agents (the common
// case) — the same lane the in-browser HirePanel uses.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "X-Action-Version": "2.4",
  // CAIP-2 id for Solana mainnet (not "solana:mainnet" — that's rejected by clients that validate).
  "X-Blockchain-Ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: CORS });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return json({ message: "Agent not found." }, 404);

  // Blink icon + hrefs must be the PUBLIC origin of THIS deployment (so the private
  // and prod deploys each point at themselves). Prefer an explicit override, else
  // build https + the forwarded host — never hardcode one env, never emit http.
  const origin = publicOrigin(req);
  const icon = `${origin}/axon-logo.png`;
  const parsed = agent.price ? parsePaymentAmount(agent.price) : null;

  // v1 Blink settles a USDC payment. Non-USDC/free agents point at the web hire page.
  if (!parsed || parsed.currency !== "USDC") {
    return json({
      type: "action",
      icon,
      title: `Hire ${agent.name} on Axon`,
      description: `${agent.capabilities.slice(0, 4).join(", ")}. Open the hire page to continue.`,
      label: "Open",
      links: { actions: [{ type: "external-link", label: "Hire on Axon", href: `${origin}/hire/${encodeURIComponent(agentId)}` }] },
    });
  }

  return json({
    type: "action",
    icon,
    title: `Hire ${agent.name} on Axon`,
    description: `${agent.price} per task · ${agent.capabilities.slice(0, 4).join(", ")}. Pay from your wallet, get verifiable work — the payment is the authorization.`,
    label: `Pay ${agent.price} & Hire`,
    links: {
      actions: [
        {
          type: "transaction",
          label: `Pay ${agent.price} & Hire`,
          href: `${origin}/api/actions/hire/${encodeURIComponent(agentId)}?task={task}`,
          parameters: [{ name: "task", label: `What should ${agent.name} do?`, required: true }],
        },
      ],
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return json({ message: "Agent not found." }, 404);

  const parsed = agent.price ? parsePaymentAmount(agent.price) : null;
  if (!parsed || parsed.currency !== "USDC") return json({ message: "This agent isn't hireable via Blink yet." }, 422);
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) return json({ message: "Payments not configured." }, 500);

  const task = (req.nextUrl.searchParams.get("task") ?? "").trim();
  if (!task) return json({ message: "Enter a task for the agent." }, 400);
  // The task rides in the chained next-action URL — cap it so paying can't lead to a
  // chaining failure on URL length. Longer tasks belong on the web hire page.
  if (task.length > 1500) return json({ message: "That task is too long to hire via Blink — use the hire page for it." }, 400);

  const body = (await req.json().catch(() => ({}))) as { account?: string };
  if (!body.account) return json({ message: "Missing account." }, 400);

  let account: PublicKey;
  try {
    account = new PublicKey(body.account);
  } catch {
    return json({ message: "Invalid account." }, 400);
  }

  // Build the unsigned USDC transfer to Axon's receiver — the wallet signs it. Any
  // failure here (RPC, serialization) must still return a CORS'd JSON so the Blink
  // client can read it — an uncaught throw would 500 without CORS headers.
  let transaction: string;
  try {
    const conn = getConnection();
    const mint = new PublicKey(USDC_MINT);
    const receiver = new PublicKey(PAYMENT_RECEIVER_WALLET_ADDRESS);
    const fromAta = getAssociatedTokenAddressSync(mint, account, true);
    const toAta = getAssociatedTokenAddressSync(mint, receiver, true);

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: account, recentBlockhash: blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(account, toAta, receiver, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, account, parsed.units, USDC_DECIMALS),
    );
    transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch {
    return json({ message: "Couldn't build the payment right now — try again in a moment." }, 503);
  }

  const origin = publicOrigin(req);
  return json({
    type: "transaction",
    transaction,
    message: `Pay ${agent.price} to hire ${agent.name}`,
    links: {
      // After the payment confirms, the wallet POSTs here to run the hire.
      next: { type: "post", href: `${origin}/api/actions/hire/${encodeURIComponent(agentId)}/submit?task=${encodeURIComponent(task)}` },
    },
  });
}
