import { receiptCard, CARD_SIZE, CARD_TYPE } from "./ogCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;
export const alt = "Axon verifiable work receipt";

export default async function Image({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return receiptCard(taskId);
}
