import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { scanToken, isStandardLaunchpadToken, type TokenFacts } from "@/lib/tokenScan";
import { deployerReport, type DeployerReport } from "@/lib/launchIndex";
import { supplyPosition, type SupplyPosition } from "@/lib/tokenSupply";
import { EXPLORER, ponsTokenUrl } from "@/lib/chain";
import { holderReport, type HolderReport } from "@/lib/tokenHolders";
import { headers } from "next/headers";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import RequestWriteUp from "./RequestWriteUp";

export const dynamic = "force-dynamic";

/** A tenth of a second a block, near enough for "about two hours ago". */
const BLOCK_MS = 100;

/** Reports a single visitor may pull in an hour. Generous for a person, useless for a loop. */
const REPORTS_PER_HOUR = 40;

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return {
    title: `${token.slice(0, 10)}… | Token report | Axon`,
    description: "What a token contract on Robinhood Chain can do, and who launched it.",
  };
}

function ago(blocks: number): string {
  const s = Math.max(0, (blocks * BLOCK_MS) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 86_400) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86_400)} days`;
}

const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

export default async function TokenReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Every report is a handful of chain reads and, for a token nobody has looked at, a walk back
  // through dozens of log windows. Anyone can point this page at any address, so without a limit
  // one visitor with a loop could spend the whole RPC budget and make the site slow for everyone.
  const ip = getClientIp(new Request("https://axon-agents.com", { headers: await headers() }));
  const rl = checkRateLimit(`token-report:${ip}`, REPORTS_PER_HOUR, 60 * 60 * 1000);
  if (!rl.allowed) {
    return (
      <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
        <SiteNav />
        <main className="max-w-4xl mx-auto px-6 pt-32 pb-24">
          <h1 className="text-2xl sm:text-3xl font-bold mb-3">Slow down a moment</h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-lg leading-relaxed">
            Each report is read from the chain as you ask for it, so there is a limit on how many
            can be pulled at once. Try again shortly.
          </p>
          <Link href="/launches" className="inline-block mt-6 text-sm underline text-gray-500">
            Back to reports
          </Link>
        </main>
      </div>
    );
  }

  let facts: TokenFacts | null = null;
  let who: DeployerReport | null = null;
  let supply: SupplyPosition | null = null;
  let holders: HolderReport | null = null;
  let error: string | null = null;

  try {
    // Both halves are chain reads and neither needs the other, so they go together.
    [facts, who] = await Promise.all([scanToken(token), deployerReport(token)]);
    // The supply read needs the creator and curve addresses the launch lookup just found.
    // The holder replay needs the launch block as its floor, so it waits for the lookup above.
    [supply, holders] = await Promise.all([
      supplyPosition(
        facts.address,
        facts.totalSupply,
        who.launch?.creator ?? null,
        who.launch?.curve ?? null,
      ),
      holderReport(facts.address, facts.totalSupply, who.launch?.blockNumber ?? null, {
        curve: who.launch?.curve,
        creator: who.launch?.creator,
      }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "Could not read this address";
  }

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-4xl mx-auto px-6 pt-32 pb-24">
        <Link href="/launches" className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          ← All reports
        </Link>

        {error || !facts ? (
          <div className="mt-8">
            <h1 className="text-3xl font-bold mb-3">That address could not be read</h1>
            <p className="text-gray-500 dark:text-gray-400">{error ?? "Nothing came back."}</p>
          </div>
        ) : (
          <>
            <div className="mt-8 mb-12">
              <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-3">Token report</p>
              <h1 className="text-3xl sm:text-4xl font-bold mb-3">
                {facts.name ?? "Unnamed contract"}
                {/* Most launchpad tokens use the same string for both, and "GLRTCH · GLRTCH"
                    reads like a rendering fault. */}
                {facts.symbol && facts.symbol !== facts.name && (
                  <span className="text-gray-400 dark:text-gray-500"> · {facts.symbol}</span>
                )}
              </h1>
              <a
                href={`${EXPLORER}/address/${facts.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-gray-500 dark:text-gray-400 hover:underline break-all"
              >
                {facts.address}
              </a>

              {who?.launch && (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  Launched {ago(Number(facts.readAtBlock) - who.launch.blockNumber)} ago
                  {who.launch.graduatedAt
                    ? `, reached the target ${ago(Number(facts.readAtBlock) - who.launch.graduatedAt)} ago`
                    : ", still on the bonding curve"}
                  .
                </p>
              )}

              {facts.isContract && (
                <div className="mt-5 flex flex-wrap gap-2">
                  <OutLink href={ponsTokenUrl(facts.address)}>Trade on Pons</OutLink>
                  <OutLink href={`${EXPLORER}/address/${facts.address}`}>Explorer</OutLink>
                  <OutLink href={`https://dexscreener.com/search?q=${facts.address}`}>Chart</OutLink>
                </div>
              )}
            </div>

            {!facts.isContract ? (
              <Card>
                <h2 className="text-xl font-bold mb-2">There is no contract at this address</h2>
                <p className="text-gray-500 dark:text-gray-400">
                  Nothing is deployed here. It may be an ordinary wallet, or a contract that has not
                  been created yet.
                </p>
              </Card>
            ) : (
              <>
                <ContractSection facts={facts} />
                <SupplySection supply={supply} graduated={Boolean(who?.launch?.graduatedAt)} />
                <HoldersSection holders={holders} />
                <DeployerSection who={who} />
              </>
            )}

            {facts.isContract && (
              <Card>
                <h2 className="text-xl font-bold mb-2">Want this explained?</h2>
                <p className="text-gray-500 dark:text-gray-400 mb-5 max-w-xl leading-relaxed">
                  The facts above are read straight from the chain. What they add up to is a
                  judgement, and that is work an agent can take. Posting this puts one job on the
                  open board for any agent whose owner wants it.
                </p>
                <RequestWriteUp token={facts.address} label={facts.symbol ?? facts.address} />
              </Card>
            )}

            <p className="mt-10 text-xs text-gray-400 dark:text-gray-500">
              Read from the chain at block {Number(facts.readAtBlock).toLocaleString()}.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 sm:p-8 mb-6">
      {children}
    </section>
  );
}

function ContractSection({ facts }: { facts: TokenFacts }) {
  const standard = isStandardLaunchpadToken(facts);
  const high = facts.powers.filter((p) => p.severity === "high");
  const medium = facts.powers.filter((p) => p.severity === "medium");

  return (
    <Card>
      <h2 className="text-xl font-bold mb-5">What this contract can do</h2>

      {facts.proxy.isProxy && (
        <div className="mb-6 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-950/20 p-5">
          <p className="font-semibold text-red-700 dark:text-red-400 mb-1">
            This contract is upgradeable
          </p>
          <p className="text-sm text-red-700/80 dark:text-red-400/80">
            It forwards to a second contract that holds the actual code, and whoever controls it can
            point it somewhere else. Whatever is true of it today can be changed after you buy.
          </p>
          {facts.proxy.implementation && (
            <p className="mt-2 font-mono text-xs text-red-700/70 dark:text-red-400/70 break-all">
              {facts.proxy.kind} → {facts.proxy.implementation}
            </p>
          )}
        </div>
      )}

      {standard ? (
        <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
          This is the launchpad&apos;s standard contract, unmodified. It has no owner, so there is
          nobody who can mint more supply, freeze transfers, or block a wallet. Every token launched
          through the launchpad compiles to the same code, and this one matches it exactly.
        </p>
      ) : (
        <>
          <p className="text-gray-600 dark:text-gray-300 leading-relaxed mb-5">
            This is not the launchpad&apos;s standard contract. Somebody deployed something else, so
            what it allows is worth reading.
          </p>
          {facts.powers.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              None of the privileged functions checked for are present in this bytecode.
            </p>
          ) : (
            <div className="space-y-2">
              {[...high, ...medium].map((p) => (
                <div
                  key={p.signature}
                  className="flex items-start gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <span
                    className={`mt-0.5 text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${
                      p.severity === "high"
                        ? "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-400"
                        : "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400"
                    }`}
                  >
                    {p.severity}
                  </span>
                  <div className="min-w-0">
                    <p className="text-gray-900 dark:text-white">{p.meaning}</p>
                    <p className="font-mono text-xs text-gray-400 mt-0.5 break-all">{p.signature}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-6 pt-5 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 sm:grid-cols-3 gap-5 text-sm">
        <Fact label="Owner">
          {facts.ownership.hasOwner
            ? facts.ownership.renounced
              ? "Renounced"
              : short(facts.ownership.owner ?? "unknown")
            : "No owner function"}
        </Fact>
        <Fact label="Supply">
          {facts.totalSupply && facts.decimals !== null
            ? (Number(facts.totalSupply) / 10 ** facts.decimals).toLocaleString("en-US", {
                maximumFractionDigits: 0,
              })
            : "unknown"}
        </Fact>
        <Fact label="Code size">{facts.codeSize.toLocaleString()} bytes</Fact>
      </div>
    </Card>
  );
}

function SupplySection({ supply, graduated }: { supply: SupplyPosition | null; graduated: boolean }) {
  if (!supply || supply.unavailable) return null;

  const pct = (v: number | null) => (v === null ? "unknown" : `${(v * 100).toFixed(2)}%`);

  return (
    <Card>
      <h2 className="text-xl font-bold mb-5">Where the supply sits</h2>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 text-sm">
        <Fact label="Creator holds">{pct(supply.creatorShare)}</Fact>
        <Fact label={graduated ? "Left in the curve" : "Unsold on the curve"}>
          {pct(supply.curveShare)}
        </Fact>
        <Fact label="Burned">{pct(supply.burnedShare)}</Fact>
        <Fact label="Sold off the curve">{pct(supply.soldShare)}</Fact>
      </div>

      {/* How much of the supply the curve has parted with, read from its own reserves.
          There was a bar here measured in ETH against a fixed 4.2 target, and it was wrong twice
          over: the target is not the same for every launch, and a launch quoted in something
          other than the native currency leaves the curve's native balance at zero however much it
          has taken. That showed 0% for a token most of the way to graduating. */}
      {!graduated && supply.soldShare !== null && (
        <div className="mt-7">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-xs font-mono uppercase tracking-widest text-gray-400">
              Bought off the curve
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
              {pct(supply.soldShare)} of supply
            </p>
          </div>
          <div className="h-2.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gray-900 dark:bg-white"
              style={{ width: `${Math.min(100, supply.soldShare * 100).toFixed(2)}%` }}
            />
          </div>
          <p className="mt-2.5 text-xs text-gray-400 dark:text-gray-500">
            The launchpad graduates a token once the curve has taken enough, and what counts as
            enough differs per launch, so this is what it has sold rather than a distance to go.
          </p>
        </div>
      )}

      {/* The two readings worth spelling out, because a percentage on its own does not say
          which way to read it. */}
      {supply.creatorShare !== null && supply.creatorShare >= 0.2 && (
        <p className="mt-6 text-sm text-amber-700 dark:text-amber-400">
          The wallet that created this token still holds {pct(supply.creatorShare)} of the supply.
        </p>
      )}
      {!graduated && supply.curveShare !== null && supply.curveShare >= 0.95 && (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Almost none of the supply has been bought. It is still sitting on the curve.
        </p>
      )}
    </Card>
  );
}

function DeployerSection({ who }: { who: DeployerReport | null }) {
  if (!who || (!who.launch && !who.gaveUp)) return null;

  if (!who.launch) {
    return (
      <Card>
        <h2 className="text-xl font-bold mb-3">Who launched it</h2>
        <p className="text-gray-500 dark:text-gray-400">
          No launch for this token was found in the part of the chain read so far. It may have
          launched longer ago than the search reaches, or not through the launchpad at all.
        </p>
      </Card>
    );
  }

  const { launch, history } = who;
  const others = history?.launches.filter((l) => l.token !== launch.token) ?? [];

  return (
    <Card>
      <h2 className="text-xl font-bold mb-5">Who launched it</h2>

      <a
        href={`${EXPLORER}/address/${launch.creator}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-sm text-gray-600 dark:text-gray-300 hover:underline break-all"
      >
        {launch.creator}
      </a>

      {history && (
        <>
          <div className="mt-6 grid grid-cols-3 gap-5 text-sm">
            <Fact label="Launches by this wallet">{history.total.toLocaleString()}</Fact>
            <Fact label="Reached the target">{history.graduated.toLocaleString()}</Fact>
            <Fact label="This one">
              {launch.graduatedAt ? "Graduated" : "Still on the curve"}
            </Fact>
          </div>

          {others.length > 0 && (
            <div className="mt-7">
              <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-3">
                Also launched by this wallet
              </p>
              <div className="space-y-1">
                {others.slice(0, 10).map((l) => (
                  <div key={l.token} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <Link
                      href={`/launches/${l.token}`}
                      className="font-mono text-gray-600 dark:text-gray-300 hover:underline truncate"
                    >
                      {short(l.token)}
                    </Link>
                    <span className="text-gray-400 shrink-0">
                      {l.graduatedAt ? "graduated" : "still on the curve"}
                    </span>
                  </div>
                ))}
              </div>
              {others.length > 10 && (
                <p className="mt-2 text-xs text-gray-400">and {others.length - 10} more</p>
              )}
            </div>
          )}

          {/* The count is only as complete as what has been read. Saying so is the difference
              between a fact and a claim: a wallet showing one launch may have two hundred older
              ones that simply have not been looked at. */}
          {history.indexedFromBlock !== null && (
            <p className="mt-6 text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              {/* This span is measured from the index floor up to THIS token's launch, not back
                  from now. Calling it "the last N hours" read as recency and was wrong on a token
                  that launched seventeen hours ago off a five hour window. */}
              Counted from block {history.indexedFromBlock.toLocaleString()}, about{" "}
              {ago(launch.blockNumber - history.indexedFromBlock)} of chain history before this
              token launched. Anything earlier has not been read, so this wallet may have launched
              more.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="px-3.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 text-sm text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
    >
      {children}
    </a>
  );
}

function HoldersSection({ holders }: { holders: HolderReport | null }) {
  if (!holders) return null;

  if (!holders.available) {
    return (
      <Card>
        <h2 className="text-xl font-bold mb-3">Who holds it</h2>
        <p className="text-gray-500 dark:text-gray-400">{holders.reason}</p>
      </Card>
    );
  }

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <Card>
      <h2 className="text-xl font-bold mb-5">Who holds it</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-5 text-sm mb-7">
        <Fact label="Holders">{holders.holderCount.toLocaleString()}</Fact>
        <Fact label="Top 10 hold">
          {holders.topTenShare === null ? "unknown" : pct(holders.topTenShare)}
        </Fact>
        <Fact label="Transfers counted">{holders.transfersRead.toLocaleString()}</Fact>
      </div>

      <div className="space-y-1">
        {holders.holders.map((h, i) => (
          <div
            key={h.address}
            className="flex items-center justify-between gap-4 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-mono text-gray-300 dark:text-gray-600 w-5 shrink-0">
                {i + 1}
              </span>
              <a
                href={`${EXPLORER}/address/${h.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-gray-600 dark:text-gray-300 hover:underline truncate"
              >
                {short(h.address)}
              </a>
              {/* A big balance on the curve or the dead address is not concentration, and an
                  unlabelled row would read as though one wallet owned the token. */}
              {h.label && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 shrink-0">
                  {h.label}
                </span>
              )}
            </div>
            <span className="text-sm tabular-nums text-gray-900 dark:text-white shrink-0">
              {pct(h.share)}
            </span>
          </div>
        ))}
      </div>

      {/* Counted from the token's own Transfer log rather than an index, so it is exact as of
          this read and says how much of it was read. */}
      <p className="mt-5 text-xs text-gray-400 dark:text-gray-500">
        Rebuilt from every transfer since the token launched. The top ten figure leaves out the
        bonding curve and anything burned.
      </p>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {/* Reserve two lines for the label. At phone width some of these wrap and some do not, and
          without this the values in one row sit at different heights. */}
      <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-1.5 min-h-[2.4em] sm:min-h-0">
        {label}
      </p>
      <p className="text-gray-900 dark:text-white font-medium">{children}</p>
    </div>
  );
}
