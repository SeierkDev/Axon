import { notFound } from "next/navigation";
import { getBuildGame } from "@/lib/buildStore";

export const dynamic = "force-dynamic";

// Full-page view of a generated game, served from a real URL so "open in new
// tab" and shared links work everywhere (mobile included) — unlike client-side
// blob: URLs. The game runs in a sandboxed iframe (opaque origin, no same-origin
// access) so its AI-generated code can't touch the parent page.
export default async function PlayPage({
  params,
}: {
  params: Promise<{ buildId: string }>;
}) {
  const { buildId } = await params;
  const game = getBuildGame(buildId);
  if (!game) notFound();

  return (
    <main style={{ position: "fixed", inset: 0, background: "#000" }}>
      <iframe
        srcDoc={game.html}
        sandbox="allow-scripts"
        allow="autoplay"
        title={game.prompt}
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
    </main>
  );
}
