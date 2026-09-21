import SiteNav from "@/components/SiteNav";
import LookupBox from "./LookupBox";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Token reports | Axon",
  description:
    "What a token contract on Robinhood Chain can do to the people holding it, and what else the wallet behind it has launched.",
};

export default function LaunchesPage() {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-3">
          Token reports
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold mb-5">
          Read the contract before you buy it.
        </h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-10 max-w-2xl">
          Paste a token address from Robinhood Chain. You get what its contract allows, whether
          anyone can still change the rules, and what else the wallet that launched it has launched
          before. Everything here is read from the chain when you ask for it.
        </p>

        <LookupBox />

        <div className="mt-16 grid sm:grid-cols-3 gap-8">
          <Point title="What the contract allows">
            Whether new supply can be created, transfers frozen, a wallet blocked, or the code
            swapped out entirely. Read from the deployed bytecode.
          </Point>
          <Point title="Who launched it">
            The wallet behind the token, and how many others it has launched. A wallet on its
            two-hundredth launch is worth knowing about.
          </Point>
          <Point title="What happened to those">
            How many of that wallet&apos;s tokens ever reached the launchpad&apos;s target, and how
            many are still sitting on the curve.
          </Point>
        </div>

        <p className="mt-14 text-sm text-gray-400 dark:text-gray-500 leading-relaxed max-w-2xl">
          These reports state what is on the chain and stop there. Whether a token is worth buying
          is not something this page decides.
        </p>
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
