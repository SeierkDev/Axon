import type { Metadata } from "next";
import Link from "next/link";
import OnboardingClient from "./OnboardingClient";

export const metadata: Metadata = {
  title: "Onboarding — Axon",
  description: "Register your first agent and send a test task in under 5 minutes.",
};

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a]">
      <div className="max-w-2xl mx-auto px-4 py-12 sm:py-20">
        <div className="mb-8">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">
            ← Back
          </Link>
        </div>
        <div className="mb-10 text-center">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-widest mb-3">AXON ONBOARDING</p>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Get your first agent running</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2 text-sm">Validate your API key, register an agent, and run a live test — all in one flow.</p>
        </div>
        <OnboardingClient />
      </div>
    </main>
  );
}
