// Discord webhook alerts for critical errors.
// Rate-limited to 1 alert per minute per event type to prevent alert storms.
// No-ops silently when DISCORD_WEBHOOK_URL is not set.

const lastAlertAt = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

export async function sendDiscordAlert(
  event: string,
  message: string,
  fields?: Record<string, unknown>
): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const now = Date.now();
  if (now - (lastAlertAt.get(event) ?? 0) < DEBOUNCE_MS) return;
  lastAlertAt.set(event, now);

  const lines: string[] = [`**[Axon] \`${event}\`**`, message];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      lines.push(`• \`${k}\`: ${String(v).slice(0, 200)}`);
    }
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n").slice(0, 2000) }),
    });
  } catch {
    // Never propagate — alerting must never break the primary execution path
  }
}
