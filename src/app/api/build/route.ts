// POST /api/build
// Verifies the USDC payment, then runs the 6-agent Axon Build pipeline IN THE
// BACKGROUND (decoupled from this request) and returns a buildId immediately.
// The client polls GET /api/build/status/<buildId> for progress + the result.
// Decoupling avoids Railway's HTTP/2 proxy resetting a ~5-minute SSE stream.
// The pipeline itself lives in lib/buildPipeline so server boot can auto-resume
// builds interrupted by a restart.
//
// Body: { prompt: string, paymentSignature: string, payer?: string }
// Response: { buildId } on success, { error, code } on payment/validation failure.

import { NextRequest } from "next/server";
import {
  reserveBuildPayment,
  releaseBuildPayment,
  getGameForPayment,
  linkPaymentToBuild,
  ensureBuildTables,
} from "@/lib/buildStore";
import { createBuildJob, getBuildJobBySignature } from "@/lib/buildJobs";
import { runBuildPipeline, isBuildRunning } from "@/lib/buildPipeline";
import { checkIncomingPayment, parsePaymentAmount } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

// Payment gate: each generation requires a verified USDC payment to the treasury.
// Keep BUILD_PRICE in sync with BUILD_PRICE_USDC on the client (BuildClient.tsx).
const BUILD_PRICE = "5 USDC";
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // anti-abuse cap (payment is the real gate)
const MAX_PROMPT_CHARS = 300;

function jsonError(error: string, code: string, status: number): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`build:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = (await req.json().catch(() => null)) as
    | { prompt?: string; paymentSignature?: string; payer?: string }
    | null;
  if (!body?.prompt?.trim()) {
    return jsonError("prompt is required", "VALIDATION_ERROR", 400);
  }

  const prompt = body.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const buildId = randomUUID();

  // Self-heal the Build tables in case migrations didn't apply on the host.
  ensureBuildTables();

  // ── Payment gate ──────────────────────────────────────────────────────────
  const paymentSignature = typeof body.paymentSignature === "string" ? body.paymentSignature.trim() : "";
  const payer = typeof body.payer === "string" ? body.payer.trim() : undefined;
  if (!paymentSignature) {
    return jsonError("Payment required — pay with your wallet before generating.", "PAYMENT_REQUIRED", 402);
  }
  // Payer is required so the on-chain signer check actually runs. Without it,
  // checkIncomingPayment skips signer verification (expectedSigner undefined),
  // letting anyone replay a public treasury payment signature to claim a build.
  if (!payer) {
    return jsonError("Payer wallet address is required.", "PAYMENT_REQUIRED", 402);
  }

  // Resume/reconnect: if this payment already produced a game, or a build for it
  // is unfinished, return THAT build instead of starting a duplicate. Jobs are
  // durable now, so an unfinished job can predate this process — restart its
  // pipeline if it isn't actually running here (runBuildPipeline dedupes).
  const existingGame = getGameForPayment(paymentSignature);
  if (existingGame) {
    return Response.json({ buildId: existingGame.buildId });
  }
  const runningJob = getBuildJobBySignature(paymentSignature);
  if (runningJob && !runningJob.error) {
    // Unfinished and not running here (a restart interrupted it and boot
    // resume hasn't fired, or it ran in a previous process) — restart it.
    // Finished-clean jobs are returned as-is: the status poll serves their
    // html even if the separate game persistence failed.
    if (!runningJob.done && !isBuildRunning(runningJob.buildId)) {
      void runBuildPipeline(runningJob.buildId, runningJob.prompt || prompt, paymentSignature);
    }
    return Response.json({ buildId: runningJob.buildId });
  }

  const expected = parsePaymentAmount(BUILD_PRICE);
  if (!expected) {
    return jsonError("Build price is misconfigured.", "INTERNAL_ERROR", 500);
  }

  // Reserve the signature so concurrent/replayed requests can't double-spend it.
  const freshlyReserved = reserveBuildPayment(paymentSignature, payer, buildId);
  if (!freshlyReserved) {
    // Reserved before but no game/live job survived (e.g. a failed attempt) —
    // re-point the reservation at this attempt and continue.
    linkPaymentToBuild(paymentSignature, buildId);
  }

  let paid = false;
  let payReason = "verification error";
  try {
    const result = await checkIncomingPayment(paymentSignature, expected, payer);
    paid = result.ok;
    payReason = result.reason;
  } catch (err) {
    paid = false;
    payReason = err instanceof Error ? err.message : "verification error";
  }
  if (!paid) {
    if (freshlyReserved) releaseBuildPayment(paymentSignature);
    return jsonError(
      `Payment not confirmed: ${payReason}. If you just paid, wait a few seconds and try again.`,
      "PAYMENT_NOT_CONFIRMED",
      402,
    );
  }

  // A concurrent request with the same signature may have created its build
  // while this one was verifying on-chain — join that build instead of
  // starting a token-burning duplicate, and point the payment back at it.
  const concurrent = getBuildJobBySignature(paymentSignature);
  if (concurrent && !concurrent.error && concurrent.buildId !== buildId) {
    linkPaymentToBuild(paymentSignature, concurrent.buildId);
    if (!concurrent.done && !isBuildRunning(concurrent.buildId)) {
      void runBuildPipeline(concurrent.buildId, concurrent.prompt || prompt, paymentSignature);
    }
    return Response.json({ buildId: concurrent.buildId });
  }

  // Start the build in the background and return immediately.
  createBuildJob(buildId, paymentSignature, prompt);
  void runBuildPipeline(buildId, prompt, paymentSignature);

  return Response.json({ buildId }, { headers: { "X-Build-Id": buildId } });
}
