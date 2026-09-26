"use client";
// The allowance, on the dashboard: what it holds, the rules on it, what it has paid for, and the keys
// that can spend it.
//
// Everything that moves money here is a transaction from the owner's own wallet straight to the
// contract: deposit, rules, withdraw, pause, reclaim. The server only reads. Keys are the exception,
// being server records, and those go through the API with the owner's full key.

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseEther, formatEther } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { provider, explorerTxUrl, readableWalletError } from "@/lib/chain";
import { sameAddress } from "@/lib/address";
import { ALLOWANCE_ABI, ERC20_APPROVE_ABI } from "@/lib/allowanceAbi";
import { agentKey, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS } from "@/lib/allowancePolicy";
import { sendWalletTx, waitForWalletTx } from "@/lib/walletTx";

interface Account {
  token: "ETH" | "AXON";
  tokenAddress: string;
  configured: boolean;
  available: string;
  reserved: string;
  maxPerTask: string;
  maxPerDay: string;
  spentToday: string;
  expiresAt: string | null;
  paused: boolean;
  restrictedToAllowedAgents: boolean;
}

type Status =
  | { enabled: false }
  | { enabled: true; wallet: string; contract: string; reclaimAfterSeconds: number; accounts: Account[] };

interface Payment {
  taskId: string;
  agentId: string | null;
  token: "ETH" | "AXON";
  amount: string;
  state: string;
  taskKey: string;
  reserveTx: string;
  closeTx: string | null;
  createdAt: string;
  paidWithKey: { keyId: string; label: string | null } | null;
  receiptUrl: string;
}

interface AllowanceKey {
  keyId: string;
  keyPrefix: string;
  label: string | null;
  maxPerTask: string;
  maxPerDay: string;
  spentToday: string;
  allowedAgents: string[] | null;
  expiresAt: string;
  lastUsedAt: string | null;
  warnings: { code: string; message: string }[];
}

const input =
  "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";

const STATE_STYLE: Record<string, string> = {
  reserved: "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
  settled: "border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400",
  released: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300",
  reclaimed: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300",
};
const STATE_WORD: Record<string, string> = {
  reserved: "held",
  settled: "paid",
  released: "refunded",
  reclaimed: "reclaimed",
};

/** The clock, read outside render: in handlers and after data arrives, never while rendering. */
const clock = () => Date.now();

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

export default function AllowancePanel({
  apiKey,
  onToast,
}: {
  apiKey: string;
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const wallet = useWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [keys, setKeys] = useState<AllowanceKey[]>([]);
  const [token, setToken] = useState<"ETH" | "AXON">("ETH");
  const [busy, setBusy] = useState<string | null>(null);

  // form fields
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  // null until the owner types: the field shows what is on chain (or the defaults) until then
  const [perTaskEdit, setPerTask] = useState<string | null>(null);
  const [perDayEdit, setPerDay] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [agentsToAdd, setAgentsToAdd] = useState("");
  const [agentsToRemove, setAgentsToRemove] = useState("");
  const [restrictEdit, setRestrict] = useState<boolean | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [keyPerTask, setKeyPerTask] = useState("0.0005");
  const [keyPerDay, setKeyPerDay] = useState("0.005");
  const [keyDays, setKeyDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [keyAgents, setKeyAgents] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [now, setNow] = useState(0);

  const authed = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
      return body;
    },
    [apiKey],
  );

  const load = useCallback(() => setRefreshes((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const st = (await authed("/api/allowance")) as Status;
        if (!alive) return;
        setStatus(st);
        setNow(clock());
        if (!st.enabled) return;
        const [p, k] = await Promise.all([authed("/api/allowance/payments"), authed("/api/allowance/keys")]);
        if (!alive) return;
        setPayments((p as { payments: Payment[] }).payments);
        setKeys((k as { keys: AllowanceKey[] }).keys);
      } catch {
        if (alive) setStatus({ enabled: false });
      }
    })();
    return () => { alive = false; };
  }, [authed, refreshes]);

  const account = status?.enabled ? status.accounts.find((a) => a.token === token) : undefined;
  const perTask = perTaskEdit ?? (account?.configured ? account.maxPerTask : "0.0005");
  const perDay = perDayEdit ?? (account?.configured ? account.maxPerDay : "0.005");
  const restrict = restrictEdit ?? account?.restrictedToAllowedAgents ?? false;

  if (!status || !status.enabled) return null;
  const s = status;
  const tokenAddress = account?.tokenAddress as `0x${string}`;

  /** One owner transaction, from the connected wallet, then a fresh read. */
  async function ownerTx(name: string, steps: { to: string; data: `0x${string}`; value?: bigint }[], done: string) {
    const p = provider();
    if (!p) {
      await wallet.connect(); // a phone: this opens the page inside the wallet app
      return;
    }
    const from = wallet.address ?? ((await p.request({ method: "eth_requestAccounts" })) as string[])[0];
    if (!sameAddress(from, s.wallet)) {
      onToast("error", `Switch your wallet to ${shortHash(s.wallet)}, the wallet this dashboard is signed in as`);
      return;
    }
    setBusy(name);
    try {
      for (const step of steps) {
        const hash = await sendWalletTx(p, { from, ...step });
        await waitForWalletTx(p, hash);
      }
      onToast("success", done);
      setPerTask(null);
      setPerDay(null);
      setRestrict(null);
      load();
    } catch (e) {
      onToast("error", readableWalletError(e));
    } finally {
      setBusy(null);
    }
  }

  const amount = (raw: string): bigint | null => {
    try {
      const v = parseEther(raw.trim());
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  };
  const ids = (raw: string) => raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const data = (functionName: string, args: readonly unknown[]) =>
    encodeFunctionData({ abi: ALLOWANCE_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]);

  async function deposit() {
    const v = amount(depositAmount);
    if (!v) return onToast("error", "Enter an amount to deposit");
    if (token === "ETH") {
      await ownerTx("deposit", [{ to: s.contract, data: data("deposit", []), value: v }], `Deposited ${formatEther(v)} ETH`);
    } else {
      await ownerTx("deposit", [
        { to: tokenAddress, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [s.contract as `0x${string}`, v] }) },
        { to: s.contract, data: data("depositToken", [tokenAddress, v]) },
      ], `Deposited ${formatEther(v)} $AXON`);
    }
    setDepositAmount("");
  }

  async function withdraw() {
    const v = amount(withdrawAmount);
    if (!v) return onToast("error", "Enter an amount to withdraw");
    await ownerTx("withdraw", [{ to: s.contract, data: data("withdraw", [tokenAddress, v]) }], `Withdrew ${formatEther(v)} ${token === "ETH" ? "ETH" : "$AXON"}`);
    setWithdrawAmount("");
  }

  async function saveRules() {
    const task = amount(perTask);
    const day = amount(perDay);
    const days = Number(expiryDays);
    if (!task || !day) return onToast("error", "Enter both limits");
    if (day < task) return onToast("error", "The daily limit cannot be below the per-task limit");
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) return onToast("error", `Expiry is 1 to ${MAX_EXPIRY_DAYS} days`);
    const expiresAt = BigInt(Math.floor(clock() / 1000) + days * 86_400);
    await ownerTx("rules", [{ to: s.contract, data: data("setRules", [tokenAddress, task, day, expiresAt]) }], "Rules saved");
  }

  async function saveAgents() {
    const add = ids(agentsToAdd).map(agentKey);
    const remove = ids(agentsToRemove).map(agentKey);
    await ownerTx("agents", [{ to: s.contract, data: data("setAllowedAgents", [tokenAddress, add, remove, restrict]) }],
      restrict ? "Allowed agents saved" : "Any agent may be paid");
    setAgentsToAdd("");
    setAgentsToRemove("");
  }

  async function togglePause() {
    if (!account) return;
    await ownerTx("pause", [{ to: s.contract, data: data(account.paused ? "unpause" : "pause", [tokenAddress]) }],
      account.paused ? "Allowance resumed" : "Allowance paused");
  }

  async function reclaim(p: Payment) {
    await ownerTx(`reclaim:${p.taskId}`, [{ to: s.contract, data: data("reclaim", [p.taskKey]) }], "Reservation reclaimed");
  }

  async function createKey() {
    setBusy("key");
    try {
      const agents = ids(keyAgents);
      const created = (await authed("/api/allowance/keys", {
        method: "POST",
        body: JSON.stringify({
          ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}),
          maxPerTask: keyPerTask.trim(),
          maxPerDay: keyPerDay.trim(),
          expiresInDays: Number(keyDays),
          ...(agents.length ? { allowedAgents: agents } : {}),
        }),
      })) as { apiKey: string };
      setNewKey(created.apiKey);
      setKeyLabel("");
      setKeyAgents("");
      load();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not create the key");
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(keyId: string) {
    setBusy(`revoke:${keyId}`);
    try {
      await authed(`/api/allowance/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
      onToast("success", "Key revoked");
      load();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not revoke the key");
    } finally {
      setBusy(null);
    }
  }

  const walletMismatch = wallet.address && !sameAddress(wallet.address, s.wallet);
  const unit = token === "ETH" ? "ETH" : "$AXON";

  return (
    <section id="allowance" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Allowance</h2>
        {s.accounts.length > 1 && (
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
            {s.accounts.map((a) => (
              <button
                key={a.token}
                onClick={() => setToken(a.token)}
                className={`px-3 py-1.5 ${token === a.token ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 dark:text-gray-400"}`}
              >
                {a.token === "ETH" ? "ETH" : "$AXON"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        A budget your assistants and agents can hire with, without asking you to sign each payment. It stays in the
        contract in your name until a hire completes; failed work comes back automatically.
      </p>

      {walletMismatch && (
        <p className="mb-4 text-xs rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400 p-3">
          Your wallet is on {shortHash(wallet.address!)}. Switch to {shortHash(s.wallet)} to change this allowance.
        </p>
      )}

      {keys.some((k) => k.warnings.length > 0) && (
        <div role="alert" className="mb-4 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-400 p-3">
          <p className="font-semibold mb-1">Unusual spending on {keys.filter((k) => k.warnings.length > 0).map((k) => k.label ?? k.keyPrefix).join(", ")}</p>
          <p>If this was not you or your assistant, revoke the key below. It stops working on its next request, and money already held for its hires comes back if they fail.</p>
        </div>
      )}

      {account && (
        <>
          {/* what it holds */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              ["Available", `${account.available} ${unit}`],
              ["Held for running hires", `${account.reserved} ${unit}`],
              ["Spent today", account.configured ? `${account.spentToday} of ${account.maxPerDay}` : "Not set up"],
              ["Status", !account.configured ? "Not set up" : account.paused ? "Paused" : account.expiresAt && Date.parse(account.expiresAt) < now ? "Expired" : "Active"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
                <p className={label}>{k}</p>
                <p className="text-sm font-medium text-gray-900 dark:text-white break-words">{v}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
            {/* money in and out */}
            <div className="space-y-3">
              <div>
                <label className={label} htmlFor="allowance-deposit">Deposit {unit}</label>
                <div className="flex gap-2">
                  <input id="allowance-deposit" inputMode="decimal" placeholder="0.01" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} className={input} />
                  <button onClick={() => void deposit()} disabled={busy !== null} className={button}>{busy === "deposit" ? "Confirm in wallet…" : "Deposit"}</button>
                </div>
              </div>
              <div>
                <label className={label} htmlFor="allowance-withdraw">Withdraw {unit}</label>
                <div className="flex gap-2">
                  <input id="allowance-withdraw" inputMode="decimal" placeholder={account.available} value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} className={input} />
                  <button onClick={() => setWithdrawAmount(account.available)} className={button}>Max</button>
                  <button onClick={() => void withdraw()} disabled={busy !== null} className={button}>{busy === "withdraw" ? "Confirm in wallet…" : "Withdraw"}</button>
                </div>
              </div>
              {account.configured && (
                <button onClick={() => void togglePause()} disabled={busy !== null} className={button}>
                  {busy === "pause" ? "Confirm in wallet…" : account.paused ? "Resume payments" : "Pause payments"}
                </button>
              )}
            </div>

            {/* rules */}
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={label} htmlFor="allowance-per-task">Per task</label>
                  <input id="allowance-per-task" inputMode="decimal" value={perTask} onChange={(e) => setPerTask(e.target.value)} className={input} />
                </div>
                <div>
                  <label className={label} htmlFor="allowance-per-day">Per day</label>
                  <input id="allowance-per-day" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} className={input} />
                </div>
                <div>
                  <label className={label} htmlFor="allowance-days">Expires (days)</label>
                  <input id="allowance-days" inputMode="numeric" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className={input} />
                </div>
              </div>
              <button onClick={() => void saveRules()} disabled={busy !== null} className={button}>
                {busy === "rules" ? "Confirm in wallet…" : account.configured ? "Update rules" : "Set up allowance"}
              </button>

              <div className="pt-2 space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
                  Only pay agents I allow
                </label>
                {restrict && (
                  <div className="grid grid-cols-2 gap-2">
                    <input aria-label="Agents to allow" placeholder="Allow: agent-id, …" value={agentsToAdd} onChange={(e) => setAgentsToAdd(e.target.value)} className={input} />
                    <input aria-label="Agents to remove" placeholder="Remove: agent-id, …" value={agentsToRemove} onChange={(e) => setAgentsToRemove(e.target.value)} className={input} />
                  </div>
                )}
                {(restrict !== account.restrictedToAllowedAgents || agentsToAdd || agentsToRemove) && (
                  <button onClick={() => void saveAgents()} disabled={busy !== null} className={button}>
                    {busy === "agents" ? "Confirm in wallet…" : "Save allowed agents"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* keys */}
      <div className="border-t border-gray-100 dark:border-gray-800 pt-5 mb-6">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Allowance keys</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Give one to Claude, Cursor or your own agent. It can hire and pay from this allowance within its own limits, and do
          nothing else. Amounts in ETH.
        </p>
        {newKey && (
          <div className="mb-3 p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-400 mb-2">New allowance key, copy it now, it won&apos;t be shown again</p>
            <div className="flex items-center gap-2">
              <input readOnly value={newKey} onFocus={(e) => e.target.select()} className={`${input} font-mono text-xs`} />
              <button onClick={() => { void navigator.clipboard.writeText(newKey); onToast("success", "Key copied"); }} className={button}>Copy</button>
              <button onClick={() => setNewKey(null)} className={button}>✕</button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-2">
          <div className="col-span-2 sm:col-span-1">
            <label className={label} htmlFor="key-label">Label</label>
            <input id="key-label" aria-label="Key label" placeholder="e.g. Claude" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="key-per-task">Per task</label>
            <input id="key-per-task" inputMode="decimal" value={keyPerTask} onChange={(e) => setKeyPerTask(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="key-per-day">Per day</label>
            <input id="key-per-day" inputMode="decimal" value={keyPerDay} onChange={(e) => setKeyPerDay(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="key-days">Expires (days)</label>
            <input id="key-days" inputMode="numeric" value={keyDays} onChange={(e) => setKeyDays(e.target.value)} className={input} />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={label} htmlFor="key-agents">Only these agents</label>
            <input id="key-agents" placeholder="recommended" value={keyAgents} onChange={(e) => setKeyAgents(e.target.value)} className={input} />
          </div>
        </div>
        <button onClick={() => void createKey()} disabled={busy !== null} className={button}>
          {busy === "key" ? "Creating…" : "+ New allowance key"}
        </button>

        {keys.length > 0 && (
          <div className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
            {keys.map((k) => (
              <div key={k.keyId} className="py-2.5 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200">
                    {k.label ?? "Unlabelled"} <span className="font-mono text-xs text-gray-400">{k.keyPrefix}…</span>
                  </p>
                  <p className="text-xs text-gray-400">
                    {k.maxPerTask} per task · {k.spentToday} of {k.maxPerDay} today · expires {when(k.expiresAt)}
                    {k.allowedAgents && <> · only {k.allowedAgents.join(", ")}</>}
                  </p>
                  {!k.allowedAgents && k.warnings.length === 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                      Can pay any agent. Limiting it to the agents you use stops a stolen key paying its thief.
                    </p>
                  )}
                  {k.warnings.map((w) => (
                    <p key={w.code} className="text-xs text-red-700 dark:text-red-400 mt-0.5">⚠ {w.message}</p>
                  ))}
                </div>
                <button onClick={() => void revokeKey(k.keyId)} disabled={busy !== null} className={`${button} hover:border-red-300 hover:text-red-600`}>
                  {busy === `revoke:${k.keyId}` ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* history */}
      <div className="border-t border-gray-100 dark:border-gray-800 pt-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Payments</h3>
        {payments.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing paid from this allowance yet.</p>
        ) : (
          <>
          {/* phones: one card per payment, nothing to scroll sideways */}
          <div className="sm:hidden divide-y divide-gray-100 dark:divide-gray-800">
            {payments.map((p) => {
              const canReclaim = p.state === "reserved" && now - Date.parse(p.createdAt) > s.reclaimAfterSeconds * 1000;
              return (
                <div key={p.taskId} className="py-3 text-sm text-gray-700 dark:text-gray-300">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-gray-900 dark:text-white">{p.amount} {p.token === "ETH" ? "ETH" : "$AXON"}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_STYLE[p.state] ?? STATE_STYLE.released}`}>
                      {STATE_WORD[p.state] ?? p.state}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 break-all">
                    {p.agentId ?? ""} · {when(p.createdAt)} · {p.paidWithKey?.label ?? (p.paidWithKey ? "key" : "you")}
                  </p>
                  <p className="text-xs mt-1">
                    <a href={p.receiptUrl} className="underline">Receipt</a>
                    {" · "}
                    <a href={explorerTxUrl(p.reserveTx)} target="_blank" rel="noopener noreferrer" className="underline">{shortHash(p.reserveTx)}</a>
                    {p.closeTx && <>{" · "}<a href={explorerTxUrl(p.closeTx)} target="_blank" rel="noopener noreferrer" className="underline">{shortHash(p.closeTx)}</a></>}
                  </p>
                  {canReclaim && (
                    <button onClick={() => void reclaim(p)} disabled={busy !== null} className={`${button} mt-2`}>
                      {busy === `reclaim:${p.taskId}` ? "Confirm…" : "Reclaim"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="py-1.5 pr-3 font-normal">When</th>
                  <th className="py-1.5 pr-3 font-normal">Agent</th>
                  <th className="py-1.5 pr-3 font-normal">Amount</th>
                  <th className="py-1.5 pr-3 font-normal">State</th>
                  <th className="py-1.5 pr-3 font-normal">Key</th>
                  <th className="py-1.5 font-normal">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {payments.map((p) => {
                  const canReclaim = p.state === "reserved" && now - Date.parse(p.createdAt) > s.reclaimAfterSeconds * 1000;
                  return (
                    <tr key={p.taskId} className="text-gray-700 dark:text-gray-300">
                      <td className="py-2 pr-3 whitespace-nowrap">{when(p.createdAt)}</td>
                      <td className="py-2 pr-3">{p.agentId ?? ""}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{p.amount} {p.token === "ETH" ? "ETH" : "$AXON"}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_STYLE[p.state] ?? STATE_STYLE.released}`}>
                          {STATE_WORD[p.state] ?? p.state}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-400">{p.paidWithKey?.label ?? (p.paidWithKey ? "key" : "you")}</td>
                      <td className="py-2 whitespace-nowrap text-xs">
                        <a href={p.receiptUrl} className="underline hover:text-gray-900 dark:hover:text-white">Receipt</a>
                        {" · "}
                        <a href={explorerTxUrl(p.reserveTx)} target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-900 dark:hover:text-white">{shortHash(p.reserveTx)}</a>
                        {p.closeTx && <>{" · "}<a href={explorerTxUrl(p.closeTx)} target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-900 dark:hover:text-white">{shortHash(p.closeTx)}</a></>}
                        {canReclaim && (
                          <button onClick={() => void reclaim(p)} disabled={busy !== null} className={`${button} ml-2`}>
                            {busy === `reclaim:${p.taskId}` ? "Confirm…" : "Reclaim"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </section>
  );
}
