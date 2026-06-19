// POST /api/build
// Verifies the USDC payment, then runs the 6-agent Axon Build pipeline IN THE
// BACKGROUND (decoupled from this request) and returns a buildId immediately.
// The client polls GET /api/build/status/<buildId> for progress + the result.
// Decoupling avoids Railway's HTTP/2 proxy resetting a ~5-minute SSE stream.
//
// Body: { prompt: string, paymentSignature: string, payer?: string }
// Response: { buildId } on success, { error, code } on payment/validation failure.

import { NextRequest } from "next/server";
import { getAgentById } from "@/lib/agents";
import { getBuiltinAgent } from "@/lib/agentSeed";
import {
  saveBuildGame,
  reserveBuildPayment,
  releaseBuildPayment,
  getGameForPayment,
  linkPaymentToBuild,
  ensureBuildTables,
} from "@/lib/buildStore";
import {
  createBuildJob,
  getBuildJobBySignature,
  setBuildStep,
  finishBuildJob,
  failBuildJob,
} from "@/lib/buildJobs";
import { parseWorldDesign, parseLayoutBlocks, validateLayout } from "@/lib/buildLevelValidator";
import { checkIncomingPayment, parsePaymentAmount } from "@/lib/solana";
import { getProvider, getAgentSystem, getAgentMaxTokens } from "@/lib/providers";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

// Payment gate: each generation requires a verified USDC payment to the treasury.
// Keep BUILD_PRICE in sync with BUILD_PRICE_USDC on the client (BuildClient.tsx).
const BUILD_PRICE = "5 USDC";
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // anti-abuse cap (payment is the real gate)
const MAX_QA_RETRIES = 2;
const MAX_PROMPT_CHARS = 300;
// Map-validation re-rolls. World is cheap (~2k tokens) so it gets more tries;
// the Coder is expensive (~28k) so it only gets one corrective re-roll.
const MAX_WORLD_REROLLS = 3;
const MAX_CODER_REROLLS = 2;

function jsonError(error: string, code: string, status: number): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Strip markdown code fences if the model wrapped its HTML output despite being told not to.
function extractHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*\n?([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

// Force the game HTML to plain ASCII. The model sometimes uses unicode (dpad
// arrows, middots, em-dashes, smart quotes) despite being told not to, and those
// bytes get mangled into garbage ("â²", "Â·") downstream. Mapping the common ones
// to ASCII and stripping the rest guarantees the file never renders mojibake.
function toAscii(html: string): string {
  return html
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/[·•]/g, "-")
    .replace(/[▲↑⬆▴]/g, "^")
    .replace(/[▼↓⬇▾]/g, "v")
    .replace(/[◀←⬅◂]/g, "<")
    .replace(/[▶→⮕▸]/g, ">")
    .replace(/ /g, " ")
    .replace(/[^\x00-\x7F]/g, ""); // strip anything else non-ASCII
}

// The validator walks the map as a box this wide; default to the common 24px.
function parsePlayerSize(gameDesign: string): number {
  const m = gameDesign.match(/Player Size:\s*(\d+)/i);
  const n = m ? Number(m[1]) : 24;
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 24;
}

async function callAgent(agentId: string, message: string): Promise<string> {
  // Prefer the DB row, but fall back to the static built-in definition so the
  // Build pipeline works even if the platform agents are not currently seeded.
  const agent = getAgentById(agentId) ?? getBuiltinAgent(agentId);
  if (!agent) throw new Error(`Build agent '${agentId}' not registered`);
  return getProvider(agent).complete(getAgentSystem(agent), message, getAgentMaxTokens(agentId));
}

// Runs the full pipeline in the background, writing progress to the job store.
// Must never throw (it isn't awaited) — all failure paths funnel to failBuildJob.
async function runBuildPipeline(buildId: string, prompt: string, paymentSignature: string): Promise<void> {
  try {
    // 1 — Orchestrator: plain prompt → GAME_BRIEF
    setBuildStep(buildId, "build-orchestrator", "running", 1);
    const gameBrief = await callAgent("build-orchestrator", prompt);
    setBuildStep(buildId, "build-orchestrator", "done", 1);

    // 2 — Designer: GAME_BRIEF → GAME_DESIGN
    setBuildStep(buildId, "build-designer", "running", 1);
    const gameDesign = await callAgent("build-designer", gameBrief);
    setBuildStep(buildId, "build-designer", "done", 1);

    // 3 — World: GAME_BRIEF + GAME_DESIGN → WORLD_DESIGN, then validate that the
    // level is actually beatable (flood-fill from spawn). Re-roll just the cheap
    // World step with the specific reachability errors until it passes.
    const playerSize = parsePlayerSize(gameDesign);
    setBuildStep(buildId, "build-world", "running", 1);
    let worldDesign = await callAgent("build-world", `${gameBrief}\n\n${gameDesign}`);
    for (let attempt = 1; attempt <= MAX_WORLD_REROLLS; attempt++) {
      const parsed = parseWorldDesign(worldDesign);
      if (!parsed) break; // unparseable layout — skip validation, don't block the build
      const check = validateLayout(parsed, playerSize);
      if (check.ok || attempt === MAX_WORLD_REROLLS) break;
      setBuildStep(buildId, "build-world", "running", attempt + 1);
      worldDesign = await callAgent(
        "build-world",
        `${gameBrief}\n\n${gameDesign}\n\nYour previous WORLD_DESIGN is UNBEATABLE — a player walking from Player Start cannot reach:\n- ${check.errors.join("\n- ")}\nRedraw the WORLD_DESIGN in the same exact format so the player can walk from Player Start to EVERY item spawn and to the Exit. Widen any passage to at least 60px and remove walls that seal off a key or the exit.`,
      );
    }
    setBuildStep(buildId, "build-world", "done", 1);

    // 4 — Coder: all blocks → raw HTML game, then re-check the BUILT geometry via
    // the LAYOUT block the coder embeds. Re-roll once if it drifted into an
    // unbeatable map despite a valid design.
    setBuildStep(buildId, "build-coder", "running", 1);
    let html = extractHtml(await callAgent("build-coder", `${gameBrief}\n\n${gameDesign}\n\n${worldDesign}`));
    for (let attempt = 1; attempt <= MAX_CODER_REROLLS; attempt++) {
      const levels = parseLayoutBlocks(html);
      if (levels.length === 0) break; // no embedded layout — rely on the validated design above
      const levelErrors: string[] = [];
      levels.forEach((lvl, i) => {
        const check = validateLayout(lvl, playerSize);
        if (!check.ok) levelErrors.push(`level ${i + 1}: ${check.errors.join("; ")}`);
      });
      if (levelErrors.length === 0 || attempt === MAX_CODER_REROLLS) break;
      setBuildStep(buildId, "build-coder", "running", attempt + 1);
      html = extractHtml(
        await callAgent(
          "build-coder",
          `${gameBrief}\n\n${gameDesign}\n\n${worldDesign}\n\nThe game you built has UNBEATABLE level(s): ${levelErrors.join(" | ")}. Rebuild the COMPLETE game so EVERY level is beatable — in each level the player can reach every key and the exit from the spawn. Keep each level's embedded LAYOUT entry accurate.`,
        ),
      );
    }
    setBuildStep(buildId, "build-coder", "done", 1);

    // 5 — Artist: GAME_BRIEF + HTML → visually styled HTML
    setBuildStep(buildId, "build-artist", "running", 1);
    let styledHtml = extractHtml(await callAgent("build-artist", `${gameBrief}\n\n${html}`));
    setBuildStep(buildId, "build-artist", "done", 1);

    // 6 — QA loop: verify, and retry coder+artist if issues found
    let attempt = 1;
    let passed = false;

    while (true) {
      setBuildStep(buildId, "build-qa", "running", attempt);
      const qaResult = await callAgent("build-qa", `${gameDesign}\n\n${styledHtml}`);
      passed = qaResult.includes("QA_RESULT: PASS");
      setBuildStep(buildId, "build-qa", "done", attempt, passed);

      if (passed || attempt > MAX_QA_RETRIES) break;

      attempt++;

      const fixMessage = [
        gameBrief,
        gameDesign,
        worldDesign,
        `Current HTML:\n${styledHtml}`,
        `QA Report:\n${qaResult}`,
        "Fix every issue listed in the QA Report. Output the complete corrected HTML file.",
      ].join("\n\n");

      setBuildStep(buildId, "build-coder", "running", attempt);
      html = extractHtml(await callAgent("build-coder", fixMessage));
      setBuildStep(buildId, "build-coder", "done", attempt);

      setBuildStep(buildId, "build-artist", "running", attempt);
      styledHtml = extractHtml(await callAgent("build-artist", `${gameBrief}\n\n${html}`));
      setBuildStep(buildId, "build-artist", "done", attempt);
    }

    // Force ASCII so the game can never render mojibake (garbled unicode).
    const finalHtml = toAscii(styledHtml);

    // Persist so the game can be served from a real URL and recovered by a poll
    // that missed the in-memory job (process restart / TTL prune).
    try {
      saveBuildGame({ buildId, prompt, html: finalHtml, qaPassed: passed });
    } catch {
      /* persistence is best-effort */
    }

    finishBuildJob(buildId, finalHtml, passed);
  } catch (err) {
    // The build failed after payment — free the signature so the user can retry
    // with the same payment instead of losing it.
    releaseBuildPayment(paymentSignature);
    const msg = err instanceof Error ? err.message : "Build pipeline failed";
    failBuildJob(buildId, msg);
  }
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

  // Resume/reconnect: if this payment already produced a game, or a build for it
  // is still running in this process, return THAT build instead of starting a
  // duplicate. The client just polls its status.
  const existingGame = getGameForPayment(paymentSignature);
  if (existingGame) {
    return Response.json({ buildId: existingGame.buildId });
  }
  const runningJob = getBuildJobBySignature(paymentSignature);
  if (runningJob && !runningJob.error) {
    return Response.json({ buildId: runningJob.buildId });
  }

  const expected = parsePaymentAmount(BUILD_PRICE);
  if (!expected) {
    return jsonError("Build price is misconfigured.", "INTERNAL_ERROR", 500);
  }

  // Reserve the signature so concurrent/replayed requests can't double-spend it.
  const freshlyReserved = reserveBuildPayment(paymentSignature, payer, buildId);
  if (!freshlyReserved) {
    // Reserved before but no game/job survived (e.g. a process restart) — re-point
    // the reservation at this attempt and continue.
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

  // Start the build in the background and return immediately.
  createBuildJob(buildId, paymentSignature);
  void runBuildPipeline(buildId, prompt, paymentSignature);

  return Response.json({ buildId }, { headers: { "X-Build-Id": buildId } });
}
