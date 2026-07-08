import { NextRequest, NextResponse } from "next/server";
import { finalizeHire } from "@/lib/integrations/agencHire";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// POST /api/agenc/hire/finalize — phase 2 of the non-custodial hire, after the
// user's wallet has signed+sent the register+hire tx. Attests the now-existing
// task (server) and returns an UNSIGNED setTaskJobSpec transaction for the user to
// sign. No Axon SOL spent; public + rate-limited.
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`agenc-hire-finalize:${getClientIp(req)}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const taskPda = s("taskPda"), buyerPubkey = s("buyerPubkey"), providerAgent = s("providerAgent");
  const task = s("task"), jobSpecHashHex = s("jobSpecHashHex"), jobSpecUri = s("jobSpecUri");
  if (!taskPda || !buyerPubkey || !providerAgent || !task || !jobSpecHashHex || !jobSpecUri) {
    return apiError("VALIDATION_ERROR", "taskPda, buyerPubkey, providerAgent, task, jobSpecHashHex, jobSpecUri are required", 400);
  }

  try {
    return NextResponse.json(await finalizeHire({ taskPda, buyerPubkey, providerAgent, task, jobSpecHashHex, jobSpecUri }));
  } catch (e) {
    return apiError("UPSTREAM_ERROR", e instanceof Error ? e.message : "finalize failed", 502);
  }
}
