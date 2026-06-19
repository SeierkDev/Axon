import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import BuildClient from "./BuildClient";

export const metadata: Metadata = {
  title: "Axon Build — Build a Game with AI Agents",
  description: "Describe your game idea. Six AI agents design, code, art, and test it in real time.",
};

export default async function BuildPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  // `p` carries the prompt through the Phantom deeplink redirect (mobile), so it
  // isn't lost when the page reopens inside Phantom's in-app browser.
  const { p } = await searchParams;
  const initialPrompt = typeof p === "string" ? p.slice(0, 500) : "";
  // Read payment config server-side at request time and pass it down, so it
  // doesn't depend on NEXT_PUBLIC_* being present at build time (they may only
  // be set at runtime on the host).
  const treasury =
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS?.trim() ??
    process.env.NEXT_PUBLIC_WALLET_ADDRESS?.trim() ??
    "";
  const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_URL?.trim() ?? "";
  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <BuildClient initialPrompt={initialPrompt} treasury={treasury} rpcUrl={rpcUrl} />
    </div>
  );
}
