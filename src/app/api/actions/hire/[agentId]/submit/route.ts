import { NextRequest, NextResponse } from "next/server";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { getAgentById } from "@/lib/agents";
import { publicOrigin } from "@/lib/publicOrigin";

export const dynamic = "force-dynamic";

// The chained "next" action of the hire Blink: the wallet has signed + broadcast the
// USDC payment, and now POSTs here with { account, signature }. We run the anonymous
// paid hire through the real /api/tasks handler (which re-verifies the payment
// on-chain), then return a completed action pointing at the verifiable receipt.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return json({ message: "Agent not found." }, 404);

  const task = (req.nextUrl.searchParams.get("task") ?? "").trim();
  if (!task) return json({ message: "Missing task." }, 400);

  const body = (await req.json().catch(() => ({}))) as { account?: string; signature?: string };
  if (!body.account || !body.signature) return json({ message: "Missing payment signature." }, 400);

  // Run the hire through the real tasks handler — same on-chain verification the
  // in-browser flow uses. The confirmed signature is the authorization. Forward the
  // real client IP so the tasks rate-limit keys per hirer, not one shared bucket for
  // every Blink hire (which would throttle the feature exactly when it takes off).
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const origin = publicOrigin(req);
  const icon = `${origin}/axon-logo.png`;

  // The payment already landed on-chain before this step, so a thrown error here must
  // never dead-end without CORS — always return a readable completed action.
  let data: { taskId?: string; error?: string };
  let taskOk: boolean;
  try {
    const taskReq = new NextRequest(`${req.nextUrl.origin}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "anonymous", to: agentId, task, paymentSignature: body.signature, payerWallet: body.account }),
    });
    const taskRes = await createTaskRoute(taskReq);
    data = (await taskRes.json()) as { taskId?: string; error?: string };
    taskOk = taskRes.ok;
  } catch {
    return json({ type: "completed", icon, title: "Hire not confirmed", label: "Pending", description: `Your payment went through but the hire couldn't be confirmed just now. It will settle to a receipt — check ${origin}/r shortly.` }, 200);
  }

  if (!taskOk || !data.taskId) {
    return json({ type: "completed", icon, title: "Hire failed", label: "Failed", description: data.error ?? "The payment couldn't be verified. If you were charged, it will settle to a receipt." }, 200);
  }

  const receipt = `${origin}/r/${data.taskId}`;
  return json({
    type: "completed",
    icon,
    title: `Hired ${agent.name}`,
    label: "Done",
    description: `${agent.name} is running your task. Track it and verify the receipt: ${receipt}`,
  });
}
