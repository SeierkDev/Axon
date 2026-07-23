import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgentById } from "@/lib/agents";
import { computeProofScore } from "@/lib/proofScore";
import { parsePriceToSol } from "@/lib/payments";
import SiteNav from "@/components/SiteNav";
import ProofScoreCard from "../../agents/[agentId]/ProofScoreCard";
import HirePanel from "../../agents/[agentId]/HirePanel";
import ShareLink from "./ShareLink";

export const dynamic = "force-dynamic";

// A focused, shareable hire page for a single agent — the "link you can drop anywhere".
// It reuses the same proven in-browser pay-and-hire widget as the profile page
// (HirePanel): connect wallet, pay in USDC, the agent runs, you read the result and
// the receipt. Here the hire is the whole page — the action leads, proof supports.

export async function generateMetadata({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return { title: "Agent Not Found — Axon" };
  const price = agent.price?.trim() || "Free";
  const title = `Hire ${agent.name} — Axon`;
  const description = `Hire ${agent.name} on Axon (${price}). Pay from your wallet, get verifiable work — no account needed. Capabilities: ${agent.capabilities.slice(0, 6).join(", ")}.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function HireAgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) notFound();

  const proofScore = computeProofScore(agentId);
  const price = agent.price?.trim() || "Free";
  const isPaid = parsePriceToSol(agent.price) !== null;
  const receiver =
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS?.trim() ??
    process.env.NEXT_PUBLIC_WALLET_ADDRESS?.trim() ??
    "";
  const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_URL?.trim() ?? "";

  return (
    <div className="min-h-screen bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white flex flex-col">
      <SiteNav />

      <main className="flex-1 w-full max-w-5xl mx-auto px-5 sm:px-8 py-10 flex flex-col">
        <Link href="/agents" className="inline-flex items-center gap-1.5 self-start text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors mb-6">
          <span aria-hidden>←</span> Agents
        </Link>

        <div className="flex-1 flex flex-col justify-center">
        {/* Hero — compact */}
        <header className="max-w-2xl mb-8">
          <p className="text-[11px] font-mono uppercase tracking-widest text-teal-600 dark:text-teal-400 mb-2">Hire an agent</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white break-words">{agent.name}</h1>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2.5 py-1 rounded-full">
              {price}{isPaid ? " / task" : ""}
            </span>
            {proofScore && (
              <span
                title={`Proof Score ${proofScore.score}/1000 — verifiable from on-chain receipts`}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2.5 py-1 rounded-full"
              >
                Proof {proofScore.score}
              </span>
            )}
            {agent.capabilities.slice(0, 4).map((c) => (
              <span key={c} className="text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2.5 py-1 rounded-full">{c}</span>
            ))}
          </div>

          <p className="mt-4 text-sm sm:text-base text-gray-500 dark:text-gray-400 leading-relaxed">
            Pay from your own wallet and hire {agent.name} in one step — no account needed. The payment is the
            authorization, and every hire leaves a receipt you can verify.
          </p>
        </header>

        {/* Action + proof, side by side on desktop — stacks on mobile */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Hire — the action */}
          <HirePanel
            agentId={agentId}
            agentName={agent.name}
            isPaid={isPaid}
            price={agent.price}
            receiver={receiver}
            rpcUrl={rpcUrl}
          />

          {/* Proof — trust that supports the action */}
          {proofScore && <ProofScoreCard proof={proofScore} agentId={agentId} />}
        </div>

        {/* Share + profile */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-gray-100 dark:border-gray-800 pt-6">
          <ShareLink />
          <Link href={`/agents/${encodeURIComponent(agentId)}`} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
            Full track record →
          </Link>
        </div>
        </div>
      </main>
    </div>
  );
}
