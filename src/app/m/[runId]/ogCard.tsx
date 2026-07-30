import { ImageResponse } from "next/og";
import { getPublishedGrowRun, getGrowEvents } from "@/lib/grow";
import { toPublicMission } from "@/lib/missionPublic";
import { clip } from "./cardText";

// The social-share card for a published mission — rendered when a /m/<runId>
// link is unfurled on Twitter, Discord, Slack.
//
// A mission page exists to be handed to someone. Without this the link previews
// as the site's generic card, so the thing you are actually sharing — what the
// agent was asked to do and what it cost to get it done — is invisible until
// someone clicks.
//
// Same boundary as the page, deliberately through the same function: an
// unpublished run answers exactly like one that doesn't exist. This endpoint is
// public and unauthenticated, so reading the run directly here would turn the
// share card into a way to pull the brief off any mission whose id you guessed.

export const CARD_SIZE = { width: 1200, height: 630 };
export const CARD_TYPE = "image/png";

const TEAL = "#2dd4bf";
const GREEN = "#34d399";

export async function missionCard(runId: string): Promise<ImageResponse> {
  const run = getPublishedGrowRun(runId);
  const m = run ? toPublicMission(run, getGrowEvents(runId)) : null;

  // Three lines at this size. Long enough that a real brief reads as a specific
  // job rather than a category, short enough not to overflow the card.
  const brief = m ? clip(m.mission, 132) : "An agent hired specialists to do a job.";
  const hires = m?.totals.hires ?? 0;
  const spent = m ? `${m.totals.spentUsdc.toFixed(2)} USDC` : "";
  const verified = m?.receipt?.verification.ok === true;

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
            AXON MISSION
          </div>
          {m?.template && (
            <div style={{ display: "flex", fontSize: 24, letterSpacing: 3, color: "#9fb4c4" }}>
              {clip(m.template.title, 30).toUpperCase()}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 3, color: "#6b7c8c", marginBottom: 16 }}>
            THE JOB
          </div>
          <div style={{ display: "flex", fontSize: 46, color: "#ffffff", fontWeight: 700, lineHeight: 1.2 }}>
            {brief}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {verified && (
              <>
                <div style={{ display: "flex", width: 18, height: 18, borderRadius: 9, backgroundColor: GREEN, marginRight: 16 }} />
                <div style={{ display: "flex", fontSize: 30, color: GREEN, fontWeight: 700, letterSpacing: 2 }}>
                  CHAIN VERIFIED
                </div>
              </>
            )}
          </div>
          {/* Only a real mission has totals. Rendering them anyway put "0
              specialists hired" on the fallback card, which reads as a mission
              that did nothing rather than as no mission at all. */}
          {m && (
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ display: "flex", fontSize: 30, color: "#9fb4c4", marginRight: 24 }}>
                {hires} specialist{hires === 1 ? "" : "s"} hired
              </div>
              <div style={{ display: "flex", fontSize: 44, color: "#ffffff", fontWeight: 700 }}>{spent}</div>
            </div>
          )}
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
            Every step has its own verifiable receipt.
          </div>
          {/* No run id on the fallback: an unpublished mission and one that was
              never real then render the same bytes, so the card can't be used to
              tell which ids exist. The page already answers both with a 404. */}
          <div style={{ display: "flex", fontSize: 22, color: TEAL, fontFamily: "monospace" }}>
            {m ? `axon-agents.com/m/${runId.slice(0, 8)}` : "axon-agents.com/missions"}
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE },
  );
}
