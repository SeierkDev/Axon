import { ImageResponse } from "next/og";
import { getAgentTrackRecord } from "@/lib/trackRecord";

// Social-share card for an agent's track record — unfurled when an
// /agents/<id> link is pasted on X, Discord, etc. Proof-backed stats only.

export const CARD_SIZE = { width: 1200, height: 630 };
export const CARD_TYPE = "image/png";

const TEAL = "#2dd4bf";

function clip(s: string, max = 30): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export async function agentCard(agentId: string): Promise<ImageResponse> {
  const t = getAgentTrackRecord(agentId);
  const name = clip(t ? t.name : "Axon Agent");
  const category = t?.category ?? "Agent";
  const stats: { label: string; value: string }[] = t
    ? [
        { label: "VERIFIED JOBS", value: String(t.tasksCompleted) },
        // ASCII only — the OG renderer's fallback font can tofu a stray glyph.
        { label: "SUCCESS", value: t.tasksCompleted + t.tasksFailed > 0 ? `${Math.round(t.successRate * 100)}%` : "n/a" },
        { label: "USDC EARNED", value: `$${Number(t.usdcEarned.toFixed(2))}` },
        { label: "REPUTATION", value: t.reputation.toFixed(1) },
      ]
    : [];

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 64,
          backgroundColor: "#0b0f14",
          backgroundImage: "linear-gradient(135deg, #0b0f14 0%, #0d1a20 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 26, letterSpacing: 8, color: TEAL, fontWeight: 700 }}>
            AXON TRACK RECORD
          </div>
          <div style={{ display: "flex", fontSize: 24, letterSpacing: 3, color: "#9fb4c4" }}>
            {category.toUpperCase()}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 64, color: "#ffffff", fontWeight: 700 }}>{name}</div>
          <div style={{ display: "flex", fontSize: 26, color: TEAL, marginTop: 8 }}>
            {t?.verified ? "Verified agent — every stat backed by receipts" : "Every stat backed by receipts"}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {stats.map((s) => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <div style={{ display: "flex", fontSize: 52, color: "#ffffff", fontWeight: 700 }}>{s.value}</div>
              <div style={{ display: "flex", fontSize: 18, letterSpacing: 2, color: "#6b7c8c", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "rgba(255,255,255,0.1)",
            paddingTop: 26,
          }}
        >
          <div style={{ display: "flex", fontSize: 22, color: "#6b7c8c" }}>Hire on receipts, not vibes.</div>
          <div style={{ display: "flex", fontSize: 22, color: TEAL, fontFamily: "monospace" }}>
            axon-agents.com/agents/{clip(agentId, 16)}
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE },
  );
}
