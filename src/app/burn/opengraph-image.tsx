import { pageCard } from "./ogCard";
import { CARD_SIZE, CARD_TYPE } from "@/lib/ogCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;
export const alt = 'The Axon burn';

export default async function Image() {
  return pageCard();
}
