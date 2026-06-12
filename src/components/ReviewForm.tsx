"use client";

import { useState } from "react";

interface Props {
  agentId: string;
}

type Step = "idle" | "connecting" | "signing" | "submitting" | "done" | "error";

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      connect: () => Promise<{ publicKey: { toString: () => string } }>;
      signMessage: (msg: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }>;
    };
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export default function ReviewForm({ agentId }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (rating === 0) { setError("Please select a star rating."); return; }
    setError(null);
    setStep("connecting");

    try {
      const phantom = window.solana;
      if (!phantom?.isPhantom) {
        setError("Phantom wallet not found. Install it at phantom.app.");
        setStep("error");
        return;
      }

      const { publicKey } = await phantom.connect();
      const walletAddress = publicKey.toString();
      setStep("signing");

      // Get challenge
      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const { challenge } = await challengeRes.json() as { challenge: string };

      // Sign
      const message = new TextEncoder().encode(challenge);
      const { signature } = await phantom.signMessage(message, "utf8");

      // Verify → get API key
      setStep("submitting");
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, challenge, signature: encodeBase64(signature) }),
      });
      const { apiKey } = await verifyRes.json() as { apiKey: string };
      if (!apiKey) throw new Error("Authentication failed.");

      // Post review
      const reviewRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      if (!reviewRes.ok) {
        const data = await reviewRes.json() as { message?: string };
        throw new Error(data.message ?? "Failed to submit review.");
      }

      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    }
  }

  if (step === "done") {
    return (
      <div className="px-5 py-6 text-center">
        <p className="text-sm font-medium text-gray-900">Review submitted</p>
        <p className="text-xs text-gray-400 mt-1">Thanks — it will appear once the page refreshes.</p>
      </div>
    );
  }

  const isLoading = step === "connecting" || step === "signing" || step === "submitting";
  const loadingLabel = step === "connecting" ? "Connecting…" : step === "signing" ? "Sign in Phantom…" : "Submitting…";

  return (
    <div className="px-5 py-4 border-t border-gray-100">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Leave a review</p>
      <div className="flex items-center gap-1 mb-3">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            onClick={() => setRating(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            className="text-2xl leading-none transition-colors"
          >
            <span className={(hovered || rating) >= star ? "text-yellow-400" : "text-gray-200"}>★</span>
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Share your experience (optional)"
        rows={3}
        maxLength={500}
        className="w-full text-sm border border-gray-200 rounded-lg p-3 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-gray-400 placeholder:text-gray-300 mb-3"
      />
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={isLoading}
        className="text-sm px-4 py-2 bg-[#0a0a0a] hover:bg-[#222] text-white rounded-lg font-medium transition-colors disabled:opacity-50"
      >
        {isLoading ? loadingLabel : "Connect Phantom & Submit"}
      </button>
      <p className="text-[11px] text-gray-300 mt-2">Requires Phantom wallet to prevent spam.</p>
    </div>
  );
}
