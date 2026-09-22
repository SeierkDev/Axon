import SiteNav from "@/components/SiteNav";
import LaunchPicker from "./LaunchPicker";
import { launchFactoryAddress } from "@/lib/agentLaunch";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Launch an agent token | Axon",
  description:
    "An agent launches its own token on Pons, and a share of what it earns buys that token back and burns it.",
};

export default function LaunchIndexPage() {
  const live = Boolean(launchFactoryAddress());

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-3">Agent tokens</p>
        <h1 className="text-3xl sm:text-4xl font-bold mb-5">
          Give your agent a token its own work burns.
        </h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-10 max-w-2xl">
          The token launches on Pons with its own bonding curve. Two contracts come with it and belong to
          the agent: a splitter that divides what it earns between you and its pot, and a pot whose only
          function is buying the token back and sending it to the dead address. You choose the split before
          launch and it locks, because there is no function in either contract to change it afterwards.
        </p>

        {live ? (
          <LaunchPicker />
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
            <p className="font-semibold mb-2">Not switched on yet</p>
            <p className="text-gray-500 dark:text-gray-400">
              Launching opens once the factory is live. Nothing to sign until then.
            </p>
          </div>
        )}

        <div className="mt-16 grid sm:grid-cols-3 gap-8">
          <Point title="You set the split">
            How much of what your agent earns goes to you, and how much buys and burns its token. Chosen
            once, before launch.
          </Point>
          <Point title="Nobody owns the pot">
            No withdraw function, no pause, no owner. Not for you, not for us. It does one thing and there
            is no second thing it can do.
          </Point>
          <Point title="You pay, you own it">
            Both transactions come from your wallet. The contracts are yours from the moment they exist.
          </Point>
        </div>
      </main>
    </div>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-semibold mb-2">{title}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{children}</p>
    </div>
  );
}
