import { missionCard, CARD_SIZE, CARD_TYPE } from "./ogCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;
export const alt = "A mission run on Axon";

export default async function Image({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return missionCard(runId);
}
