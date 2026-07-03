import { ImageResponse } from "next/og";
import { getPublicReceipt } from "@/lib/receipts";

// The social-share card for a public receipt — rendered when a /r/<taskId>
// link is unfurled on Twitter, Discord, etc. Metadata only, same privacy rule
// as the page: parties, status, verdict, settlement — never task content.

export const CARD_SIZE = { width: 1200, height: 630 };
export const CARD_TYPE = "image/png";

const TEAL = "#2dd4bf";
const GREEN = "#34d399";
const RED = "#f87171";

// ASCII-only ellipsis: the OG renderer's default font can't be trusted to
// carry every Unicode glyph, and a missing one renders as a tofu box.
function clip(s: string, max = 26): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export async function receiptCard(taskId: string): Promise<ImageResponse> {
  const r = getPublicReceipt(taskId);

  const from = clip(r ? (r.fromName ?? r.fromAgent) : "Axon");
  const to = clip(r ? (r.toName ?? r.toAgent) : "Agent Network");
  const status = (r?.status ?? "receipt").toUpperCase();
  const verified = r?.specVerified;
  const amount =
    r?.settlement != null
      ? `${Number(r.settlement.amount.toFixed(6))} ${r.settlement.currency}`
      : (r?.payment ?? "Free-route");
  const proofColor = verified === false ? RED : GREEN;
  const proofText = verified === false ? "SPEC MISMATCH" : verified ? "SPEC VERIFIED" : "TAMPER-EVIDENT";

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
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 10, color: TEAL, fontWeight: 700 }}>
            AXON RECEIPT
          </div>
          <div style={{ display: "flex", fontSize: 24, letterSpacing: 3, color: "#9fb4c4" }}>{status}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 3, color: "#6b7c8c", marginBottom: 10 }}>
            REQUESTED BY
          </div>
          <div style={{ display: "flex", fontSize: 56, color: "#ffffff", fontWeight: 700 }}>{from}</div>
          {/* glyph-free flow connector (a drawn arrow char can tofu) */}
          <div style={{ display: "flex", width: 4, height: 34, borderRadius: 2, backgroundColor: TEAL, marginTop: 14, marginBottom: 14, marginLeft: 6 }} />
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 3, color: "#6b7c8c", marginBottom: 10 }}>
            PERFORMED BY
          </div>
          <div style={{ display: "flex", fontSize: 56, color: "#ffffff", fontWeight: 700 }}>{to}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", width: 18, height: 18, borderRadius: 9, backgroundColor: proofColor, marginRight: 16 }} />
            <div style={{ display: "flex", fontSize: 30, color: proofColor, fontWeight: 700, letterSpacing: 2 }}>
              {proofText}
            </div>
          </div>
          <div style={{ display: "flex", fontSize: 44, color: "#ffffff", fontWeight: 700 }}>{amount}</div>
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
          <div style={{ display: "flex", fontSize: 22, color: "#6b7c8c" }}>
            Independently verifiable. No login required.
          </div>
          <div style={{ display: "flex", fontSize: 22, color: TEAL, fontFamily: "monospace" }}>
            axon-agents.com/r/{taskId.slice(0, 8)}
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE },
  );
}
