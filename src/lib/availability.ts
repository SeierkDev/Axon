// Whether an agent should be advertising itself.
//
// "Available for hire now" was the fallback. Not running a task and nothing finished lately meant
// available, and nothing in that decision ever looked at whether the agent still answers. The
// health cron has been pinging every registered endpoint every five minutes the whole time and
// writing the result to verification_status, and the storefront never read it.
//
// So an agent whose endpoint had been refusing connections for a fortnight went on telling every
// visitor it was ready to work. That is the one claim on the page a person acts on: they hire it,
// pay for it, and wait for an answer that is not coming.
//
// An agent that stopped answering now says so.

/** What the health cron last saw. "unreachable" is the one that matters here. */
export type VerificationStatus = "reachable" | "unreachable" | "unverified" | "platform" | string;

export interface AvailabilityInput {
  running: number;
  queued: number;
  lastCompletedAt: string | null;
  /** null for agents with no registered endpoint, which are not claimed to be reachable either way */
  verificationStatus?: VerificationStatus | null;
  /** when the endpoint last answered, for saying how long it has been quiet */
  lastVerifiedAt?: string | null;
  /** injectable so the tests are not at the mercy of the clock */
  now?: number;
}

export type AvailabilityTone = "working" | "queued" | "idle" | "available" | "down";

export interface Availability {
  tone: AvailabilityTone;
  text: string;
}

/** Fresh work is worth showing; silence older than this reads as a dead network, not as news. */
const IDLE_WINDOW_MS = 48 * 3_600_000;

/**
 * The single rule both the world storefront and the agent page ask.
 *
 * Order matters: what the agent is doing right now beats what it did lately, and being
 * unreachable beats everything except work already in flight. An agent with a task actually
 * running is demonstrably alive whatever the last ping said, so that case stays as it was.
 */
export function agentAvailability(a: AvailabilityInput): Availability {
  const now = a.now ?? Date.now();

  if (a.running > 0) {
    const q = a.queued > 0 ? ` · ${a.queued} in queue` : "";
    return {
      tone: "working",
      text: `Working on ${a.running > 1 ? `${a.running} tasks` : "a task"} right now${q}`,
    };
  }

  // Not working, and the last thing we know is that nobody could reach it.
  if (a.verificationStatus === "unreachable") {
    const since = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) : NaN;
    const ago = Number.isFinite(since) ? sinceWords(now - since) : null;
    return {
      tone: "down",
      text: ago ? `Not responding, last checked ${ago}` : "Not responding",
    };
  }

  if (a.queued > 0) {
    return { tone: "queued", text: `${a.queued} task${a.queued > 1 ? "s" : ""} waiting in queue` };
  }

  if (a.lastCompletedAt) {
    const done = Date.parse(a.lastCompletedAt);
    if (Number.isFinite(done) && now - done < IDLE_WINDOW_MS) {
      return { tone: "idle", text: `Idle, last job finished ${sinceWords(now - done)}` };
    }
  }

  return { tone: "available", text: "Available for hire now" };
}

function sinceWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
