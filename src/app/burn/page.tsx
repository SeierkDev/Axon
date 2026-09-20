import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { getBurnLive, BURN_RULES } from "@/lib/burnLive";
import { ponsTokenUrl } from "@/lib/chain";
import { getBurnStats } from "@/lib/burn";
import BurnClient, { type BurnPayload } from "./BurnClient";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Burn | Axon",
  description:
    "Trading fees feed the burn pot. Every 30 minutes anyone can fire it, and the pot buys $AXON and sends it to the dead address.",
};

export default async function BurnPage() {
  const [live, ledger] = await Promise.all([getBurnLive(), getBurnStats()]);
  const data: BurnPayload = {
    ...live,
    forwarded: { totalEth: ledger.totalForwardedEth, pendingEth: ledger.pendingEth },
  };

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <main className="max-w-5xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-12">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">
            $AXON BURN
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-4">
            Every thirty minutes, the pot buys and burns.
          </h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-2xl leading-relaxed">
            Trading fees feed the burn pot. Anyone can fire it. The ETH inside has one exit: buy
            $AXON on the market and send it to the dead address. There is no withdraw function.
          </p>
        </div>

        <BurnClient initial={data} />

        {/* Every number above is read from the chain, so every number gets a link to where it came from. */}
        <section className="mt-14">
          <h2 className="text-lg font-semibold mb-4">Check it yourself</h2>
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
            <AddressRow
              label="Burn pot"
              address={data.potAddress}
              href={data.explorer.pot}
              pending="Deployed at launch"
            />
            <AddressRow
              label="$AXON token"
              address={data.tokenAddress}
              href={data.explorer.token}
              pending="Not launched yet"
            />
            <AddressRow
              label="Dead address"
              address={BURN_RULES.deadAddress}
              href={data.explorer.dead}
              pending=""
            />
          </div>
          <p className="mt-4 text-sm text-gray-400 dark:text-gray-500">
            Figures on this page are read from the pot on Robinhood Chain each time it loads.
          </p>
        </section>

        <section className="mt-14 flex flex-wrap gap-3">
          <Link
            href="/litepaper"
            className="inline-flex items-center px-4 py-2 text-sm font-medium border border-gray-200 dark:border-gray-800 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            Litepaper
          </Link>
          {data.tokenAddress ? (
            <a
              href={ponsTokenUrl(data.tokenAddress)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center px-4 py-2 text-sm font-medium border border-gray-900 dark:border-white rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
            >
              $AXON on Pons
            </a>
          ) : null}
          <Link
            href="/explorer"
            className="inline-flex items-center px-4 py-2 text-sm font-medium border border-gray-200 dark:border-gray-800 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            Network explorer
          </Link>
        </section>
      </main>
    </div>
  );
}

function AddressRow({
  label,
  address,
  href,
  pending,
}: {
  label: string;
  address: string | null;
  href: string | null;
  pending: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <span className="text-sm text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      {address && href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs sm:text-sm text-gray-900 dark:text-white hover:underline break-all text-right"
        >
          {address}
        </a>
      ) : (
        <span className="text-sm text-gray-400 dark:text-gray-500">{pending}</span>
      )}
    </div>
  );
}
