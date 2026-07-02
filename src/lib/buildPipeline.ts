// The Axon Build pipeline — 6 agents (orchestrator → designer → world → coder
// → artist → QA with retries) producing a complete HTML5 game. Runs in the
// background, decoupled from any HTTP request; progress is written to the
// durable job store (buildJobs) which the client polls.
//
// Lives in lib (not the route) so server boot can auto-resume builds that a
// restart interrupted: resumeInterruptedBuilds() re-runs every unfinished
// persisted job, so a redeploy mid-build costs the customer a pause instead of
// a failure they must notice and manually resume.

import { getAgentById } from "./agents";
import { getBuiltinAgent } from "./agentSeed";
import { saveBuildGame, releaseBuildPayment } from "./buildStore";
import {
  getUnfinishedBuildJobs,
  setBuildStep,
  finishBuildJob,
  failBuildJob,
  JOB_TTL_MS,
} from "./buildJobs";
import { parseWorldDesign, parseLayoutBlocks, validateLayout } from "./buildLevelValidator";
import { getProvider, getAgentSystem, getAgentMaxTokens } from "./providers";
import { logger } from "./logger";

const MAX_QA_RETRIES = 2;
// Map-validation re-rolls. World is cheap (~2k tokens) so it gets more tries;
// the Coder is expensive (~28k) so it only gets one corrective re-roll.
const MAX_WORLD_REROLLS = 3;
const MAX_CODER_REROLLS = 2;

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
    .replace(/ /g, " ") // non-breaking space → space (would otherwise be stripped)
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

// One pipeline per buildId per process — stops a resume request racing the
// boot auto-resume (or a double POST) into two token-burning runs of the same
// paid build. Persisted job state carries across restarts; this set doesn't
// need to (a fresh process has no pipelines running by definition).
const running = new Set<string>();

export function isBuildRunning(buildId: string): boolean {
  return running.has(buildId);
}

// Runs the full pipeline in the background, writing progress to the job store.
// Must never throw (it isn't awaited) — all failure paths funnel to failBuildJob.
export async function runBuildPipeline(
  buildId: string,
  prompt: string,
  paymentSignature: string,
): Promise<void> {
  if (running.has(buildId)) return;
  running.add(buildId);
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

    // Persist so the game can be served from a real URL and recovered even
    // after the job row is pruned.
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
  } finally {
    running.delete(buildId);
  }
}

// Called once on server boot: every persisted job that is still unfinished was
// interrupted by whatever took the previous process down. Recent ones restart
// from the top (agent outputs aren't checkpointed — tokens re-spend, the
// customer's payment doesn't). Ancient ones are marked failed instead; their
// saved payment still allows a manual resume.
export function resumeInterruptedBuilds(): void {
  const jobs = getUnfinishedBuildJobs();
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const job of jobs) {
    if (job.updatedAt < cutoff) {
      failBuildJob(job.buildId, "Build interrupted by a server restart and expired before it could resume.");
      continue;
    }
    logger.info("build.auto_resume", "Resuming build interrupted by restart", {
      buildId: job.buildId,
    });
    void runBuildPipeline(job.buildId, job.prompt, job.signature);
  }
}
