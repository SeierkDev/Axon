import { ogCard, CARD_SIZE, CARD_TYPE } from "@/lib/ogCard";
import { scanToken } from "@/lib/tokenScan";
import { findLaunch } from "@/lib/launchIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;
export const alt = "Token report on Axon";

/**
 * The card someone sees when a report is posted somewhere.
 *
 * Reports exist to be shared, so the preview has to carry the finding rather than the brand: what
 * this token is, whether the wallet behind it has done this before, and how it is doing. A link
 * that previews as nothing is a link nobody clicks.
 *
 * Falls back to a plain card on any failure. A missing preview is a small loss; a page that will
 * not render because its image threw is a large one.
 */
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  try {
    const [facts, { launch }] = await Promise.all([scanToken(token), findLaunch(token)]);

    if (!facts.isContract) {
      return ogCard({
        eyebrow: "TOKEN REPORT",
        title: "No contract",
        titleDim: "at this address.",
        subtitle: "Nothing is deployed here.",
      });
    }

    const name = facts.name ?? facts.symbol ?? "Unnamed contract";
    const supply =
      facts.totalSupply && facts.decimals !== null
        ? (Number(facts.totalSupply) / 10 ** facts.decimals).toLocaleString("en-US", {
            maximumFractionDigits: 0,
          })
        : "unknown";

    return ogCard({
      eyebrow: "TOKEN REPORT",
      title: name,
      subtitle: launch
        ? "What the contract allows, where the supply sits, and who launched it."
        : "What the contract allows and where the supply sits.",
      badge: launch?.graduatedAt ? "Graduated" : launch ? "On the curve" : undefined,
      stats: [
        { value: facts.ownership.hasOwner ? "Has owner" : "No owner", label: "CONTROL" },
        { value: facts.proxy.isProxy ? "Upgradeable" : "Fixed code", label: "CODE" },
        { value: supply, label: "SUPPLY" },
      ],
    });
  } catch {
    return ogCard({
      eyebrow: "TOKEN REPORT",
      title: "Read a token",
      titleDim: "before you buy it.",
      subtitle: "What the contract allows, where the supply sits, and who launched it.",
    });
  }
}
