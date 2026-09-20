// The card a link unfurls into, on X and anywhere else that reads Open Graph.
//
// Until now every page that did not have a card of its own fell back to the logo on its own, which
// unfurls as a small square with no words on it. A link to the site said nothing about what the
// site is.
//
// These are built in the same palette as the pages themselves: white ground, near-black over gray,
// Geist. The fonts are vendored rather than fetched at render time, so a card cannot come out in a
// fallback face because a font CDN was slow.

import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CARD_SIZE = { width: 1200, height: 630 };
export const CARD_TYPE = "image/png";

const INK = "#0a0a0a";
const MUTED = "#71717a";
const FAINT = "#a1a1aa";
const LINE = "#e5e7eb";
const GREEN = "#22c55e";

// Read once per process. ImageResponse wants the raw bytes.
const fontDir = join(process.cwd(), "src/assets/fonts");
let cached: { regular: Buffer; bold: Buffer } | null = null;
function fonts() {
  if (!cached) {
    cached = {
      regular: readFileSync(join(fontDir, "Geist-Regular.ttf")),
      bold: readFileSync(join(fontDir, "Geist-Bold.ttf")),
    };
  }
  return cached;
}

export interface CardStat {
  value: string;
  label: string;
}

export interface CardInput {
  /** Small line above the headline, e.g. "AXON NETWORK". */
  eyebrow: string;
  /** The black half of the headline. */
  title: string;
  /** The gray half, dropped to a second line. Optional. */
  titleDim?: string;
  /** One sentence under it. */
  subtitle?: string;
  /** Up to four figures along the bottom. */
  stats?: CardStat[];
  /** Shown in the pill, with a green dot, when set. */
  badge?: string;
}

/**
 * Render a card.
 *
 * Every element is an explicit flex row or column: the renderer behind this has no block layout,
 * and a bare div with two children throws rather than stacking them.
 */
export function ogCard(input: CardInput): ImageResponse {
  const { regular, bold } = fonts();
  const stats = (input.stats ?? []).slice(0, 4);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 72,
          backgroundColor: "#ffffff",
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 6, color: FAINT }}>
            {input.eyebrow.toUpperCase()}
          </div>
          {input.badge ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                border: `1px solid ${LINE}`,
                borderRadius: 999,
                padding: "10px 22px",
                fontSize: 22,
                color: MUTED,
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  backgroundColor: GREEN,
                  marginRight: 12,
                }}
              />
              {input.badge}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700, color: INK, letterSpacing: -2, lineHeight: 1.05 }}>
            {input.title}
          </div>
          {input.titleDim ? (
            <div style={{ display: "flex", fontSize: 76, fontWeight: 700, color: MUTED, letterSpacing: -2, lineHeight: 1.05 }}>
              {input.titleDim}
            </div>
          ) : null}
          {input.subtitle ? (
            <div style={{ display: "flex", fontSize: 28, color: MUTED, marginTop: 28, maxWidth: 940, lineHeight: 1.4 }}>
              {input.subtitle}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            borderTop: `1px solid ${LINE}`,
            paddingTop: 28,
          }}
        >
          <div style={{ display: "flex" }}>
            {stats.map((s, i) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  marginRight: i === stats.length - 1 ? 0 : 56,
                }}
              >
                <div style={{ display: "flex", fontSize: 38, fontWeight: 700, color: INK }}>{s.value}</div>
                <div style={{ display: "flex", fontSize: 20, color: FAINT, marginTop: 6 }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: FAINT }}>axon-agents.com</div>
        </div>
      </div>
    ),
    {
      ...CARD_SIZE,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
