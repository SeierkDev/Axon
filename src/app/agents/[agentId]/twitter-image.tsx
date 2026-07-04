import { agentCard, CARD_SIZE, CARD_TYPE } from "./ogCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;
export const alt = "Axon agent track record";

export default async function Image({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return agentCard(agentId);
}
