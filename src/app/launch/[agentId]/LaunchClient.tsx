"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, parseEther, decodeEventLog } from "viem";
import { connectWallet, getInjectedWallet } from "@/app/world/wallet";
import { EXPLORER, CHAIN_ID_HEX, CHAIN_PARAMS } from "@/lib/chain";
import { FACTORY_ABI, POT_ABI, launchParams, randomSalt } from "@/lib/launchAbi";

/**
 * Launching an agent's token, in two signatures.
 *
 * One would be nicer and is not worth it. The factory deploys the pair; the pot launches the token. Keeping
 * them apart means a launch that reverts does not strand a half-built pair, and it keeps the factory small
 * enough to read, which matters more here than a saved click because none of it can be changed afterwards.
 */

// CHAIN_ID_HEX and CHAIN_PARAMS come from lib/chain rather than being restated here: a second copy of
// the chain id is a copy that can disagree with the one the rest of the site switches to.

interface Eligibility {
  eligible: boolean;
  reason: string | null;
  agent: { agentId: string; name: string; walletAddress: string | null } | null;
  record: { tasksCompleted: number; tasksFailed: number; registeredAt: string | null } | null;
  factory: string | null;
  maxDevBps: number;
  /** read off Pons by the API, as a decimal string because JSON has no bigint */
  launchFeeWei: string;
}

type Step = "idle" | "pair" | "launching" | "done";

export default function LaunchClient({ agentId }: { agentId: string }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState("");
  const [devBuy, setDevBuy] = useState("0");
  const [devBps, setDevBps] = useState(7000);

  const [pot, setPot] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // `alive` is not ceremony: connecting a wallet fires a second request while the first is still in
  // flight, and without it the older answer can land last and overwrite the newer one with a stale
  // "connect your wallet".
  useEffect(() => {
    let alive = true;
    (async () => {
      const q = wallet ? `?wallet=${wallet}` : "";
      const res = await fetch(`/api/agent-launch/${agentId}${q}`);
      const data = (await res.json()) as Eligibility;
      if (alive) setElig(data);
    })().catch(() => {
      if (alive) setError("Could not read this agent.");
    });
    return () => { alive = false; };
  }, [agentId, wallet]);

  const connect = async () => {
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      setError(e instanceof Error && e.message === "WALLET_NOT_FOUND" ? "No wallet found in this browser." : "Could not connect.");
    }
  };

  /** Both transactions go through the user's own wallet. Nothing here can sign for them. */
  const send = async (to: string, data: `0x${string}`, value?: bigint) => {
    const p = getInjectedWallet();
    if (!p) throw new Error("No wallet.");
    // A launch pointed at the wrong chain deploys into nothing and cannot be undone.
    const chain = (await p.request({ method: "eth_chainId" })) as string;
    if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
      } catch (e) {
        // 4902 is "I have never heard of this chain", which for a chain this new is the ordinary case
        // rather than the exception: most wallets opening this page have never added it. Without this
        // the switch throws, the page says it could not deploy, and the only way forward is for the
        // user to add the network by hand. The rest of the site has always offered it here.
        if ((e as { code?: number }).code === 4902) {
          await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
        } else throw e;
      }
    }
    return (await p.request({
      method: "eth_sendTransaction",
      params: [{ from: wallet, to, data, ...(value ? { value: `0x${value.toString(16)}` } : {}) }],
    })) as string;
  };

  const waitFor = async (hash: string) => {
    const p = getInjectedWallet();
    if (!p) return null;
    for (let i = 0; i < 90; i++) {
      const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as
        | { status: string; logs: { address: string; topics: string[]; data: string }[] }
        | null;
      if (r) {
        if (r.status !== "0x1") throw new Error("The transaction reverted.");
        return r;
      }
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    throw new Error("Timed out waiting for the transaction.");
  };

  const deployPair = async () => {
    if (!elig?.factory || !elig.agent?.walletAddress) return;
    setError(null);
    setStep("pair");
    try {
      const data = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "deployPair",
        args: [elig.agent.walletAddress as `0x${string}`, devBps],
      });
      const receipt = await waitFor(await send(elig.factory, data));
      // The pot's address comes from the event rather than being guessed.
      for (const log of receipt?.logs ?? []) {
        try {
          const ev = decodeEventLog({
            abi: FACTORY_ABI,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            data: log.data as `0x${string}`,
          });
          if (ev.eventName === "AgentPairDeployed") {
            setPot((ev.args as unknown as { pot: string }).pot);
            break;
          }
        } catch { /* not our event */ }
      }
      setStep("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not deploy.");
      setStep("idle");
    }
  };

  const launch = async () => {
    if (!pot || !elig?.agent?.walletAddress) return;
    setError(null);
    setStep("launching");
    try {
      const params = launchParams({ name, symbol, logo, description }, randomSalt());
      const data = encodeFunctionData({
        abi: POT_ABI,
        functionName: "launch",
        // snipeExempt[0] receives the dev buy, so it is the agent's own wallet
        args: [params, 0n, [elig.agent.walletAddress as `0x${string}`]],
      });
      // the Pons launch fee, plus whatever is above it buys the token on the curve in the same transaction
      const value = BigInt(elig.launchFeeWei) + (devBuy ? parseEther(devBuy) : 0n);
      await waitFor(await send(pot, data, value));
      setToken("deployed");
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The launch failed.");
      setStep("idle");
    }
  };

  const potShare = ((10_000 - devBps) / 100).toFixed(0);
  const ready = name.trim() && symbol.trim() && logo.trim();

  if (!elig) return <p className="text-gray-400">Reading…</p>;

  if (!wallet) {
    return (
      <div>
        <button onClick={connect} className="px-6 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold">
          Connect the wallet that owns this agent
        </button>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  if (!elig.eligible) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <p className="font-semibold mb-2">This agent cannot launch yet</p>
        <p className="text-gray-500 dark:text-gray-400">{elig.reason}</p>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <p className="text-xl font-bold mb-2">{symbol} is live.</p>
        <p className="text-gray-500 dark:text-gray-400 mb-4">
          Its pot now buys and burns it with {potShare}% of everything this agent earns.
        </p>
        {pot && (
          <a href={`${EXPLORER}/address/${pot}`} target="_blank" rel="noopener noreferrer"
             className="font-mono text-sm underline text-gray-600 dark:text-gray-300">
            {pot}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* what this agent has done, at whatever size that is. Zero is shown, not hidden. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 flex gap-8 text-sm">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-1">Jobs done</p>
          <p className="font-semibold">{elig.record?.tasksCompleted ?? 0}</p>
        </div>
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-1">Failed</p>
          <p className="font-semibold">{elig.record?.tasksFailed ?? 0}</p>
        </div>
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-1">Agent</p>
          <p className="font-semibold">{elig.agent?.name}</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name" value={name} onChange={setName} placeholder="Research Agent Token" />
        <Field label="Ticker" value={symbol} onChange={(v) => setSymbol(v.toUpperCase().slice(0, 10))} placeholder="RSRCH" />
      </div>
      <Field label="Image URL" value={logo} onChange={setLogo} placeholder="https:// or ipfs://" />
      <Field label="Description" value={description} onChange={setDescription} placeholder="What this agent does" />
      <Field label="Your first buy, in ETH" value={devBuy} onChange={setDevBuy} placeholder="0" />

      <div>
        <div className="flex justify-between items-baseline mb-2">
          <p className="text-xs font-mono uppercase tracking-widest text-gray-400">Your share</p>
          <p className="text-sm tabular-nums">{(devBps / 100).toFixed(0)}%</p>
        </div>
        <input
          type="range" min={0} max={elig.maxDevBps} step={500}
          value={devBps} onChange={(e) => setDevBps(Number(e.target.value))}
          className="w-full"
        />
        {/* The whole explanation, in one sentence, before anything is signed. */}
        <p className="mt-3 text-gray-600 dark:text-gray-300">
          <b>{(devBps / 100).toFixed(0)}%</b> of what this agent earns goes to its wallet,{" "}
          <b>{potShare}%</b> buys and burns its token.
        </p>
        <p className="mt-1 text-sm text-gray-400">This cannot be changed later, by you or by anyone.</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
        <Stepline n={1} done={Boolean(pot)} label="Deploy the burn pot and splitter" />
        <Stepline n={2} done={Boolean(token)} label="Launch the token through the pot" />

        {!pot ? (
          <button onClick={deployPair} disabled={step === "pair"}
                  className="w-full px-6 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold disabled:opacity-50">
            {step === "pair" ? "Waiting for the wallet…" : "Deploy"}
          </button>
        ) : (
          <button onClick={launch} disabled={!ready || step === "launching"}
                  className="w-full px-6 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold disabled:opacity-50">
            {step === "launching" ? "Launching…" : ready ? "Launch" : "Fill in name, ticker and image"}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <p className="text-xs text-gray-400 leading-relaxed">
        Both transactions are signed by your wallet and paid for by you. The contracts belong to you: there
        is no owner, no pause and no withdraw function in either of them, which means nobody can change or
        stop them afterwards, including us.{" "}
        <Link href="/burn" className="underline">See how the same mechanism runs for $AXON</Link>
      </p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-mono uppercase tracking-widest text-gray-400 mb-2">{label}</label>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false}
        className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-white"
      />
    </div>
  );
}

function Stepline({ n, done, label }: { n: number; done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-mono ${
        done ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900" : "border border-gray-300 dark:border-gray-700 text-gray-400"
      }`}>
        {done ? "✓" : n}
      </span>
      <span className={done ? "text-gray-400 line-through" : ""}>{label}</span>
    </div>
  );
}
