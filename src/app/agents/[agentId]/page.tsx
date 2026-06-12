import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgentById } from "@/lib/agents";
import TestAgent from "@/components/TestAgent";
import CodeTabs from "@/components/CodeTabs";
import { getAgentMetrics } from "@/lib/metrics";
import { getReviewsByAgent, getAgentRating } from "@/lib/reviews";
import { computeReputation } from "@/lib/reputation";
import type { Review } from "@/sdk/types";
import SiteNav from "@/components/SiteNav";
import ReviewForm from "@/components/ReviewForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return { title: "Agent Not Found — Axon" };
  return { title: `${agent.name} — Axon` };
}

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);

  if (!agent) notFound();

  const reviews = getReviewsByAgent(agentId, 10);
  const rating = getAgentRating(agentId);
  const metrics = getAgentMetrics(agentId, 30);
  const reputation = computeReputation(agentId);
  const price = agent.price?.trim() || "Free";
  const isPaid = Boolean(agent.price?.trim());
  const avgLatency =
    metrics.avgLatencyMs !== null ? `${(metrics.avgLatencyMs / 1000).toFixed(1)}s` : "No data";
  const uptime = metrics.uptimePct !== null ? `${metrics.uptimePct.toFixed(1)}%` : "No data";
  const successRate = reputation.totalTasks > 0 ? `${Math.round(reputation.successRate * 100)}%` : "No data";
  const paymentReliability = reputation.totalTasks > 0 ? `${Math.round(reputation.paymentReliability * 100)}%` : "No data";

  const truncatedKey =
    agent.publicKey.length > 20
      ? `${agent.publicKey.slice(0, 10)}...${agent.publicKey.slice(-10)}`
      : agent.publicKey;

  return (
    <div className="bg-white min-h-screen text-[#0a0a0a]">
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        {/* Breadcrumb */}
        <Link
          href="/agents"
          className="text-sm text-gray-400 hover:text-gray-700 transition-colors mb-8 inline-block"
        >
          ← Agent Marketplace
        </Link>

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-3xl font-bold text-gray-900">{agent.name}</h1>
                {agent.category && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 bg-gray-50 mt-1">
                    {agent.category}
                  </span>
                )}
              </div>
              <code className="text-sm font-mono text-gray-400">{agent.agentId}</code>
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-gray-900">{price}</p>
              <p className="text-xs text-gray-400 mt-0.5">{isPaid ? "per task" : "no payment required"}</p>
            </div>
          </div>

          {/* Capabilities */}
          <div className="flex flex-wrap gap-2">
            {agent.capabilities.map((cap) => (
              <span
                key={cap}
                className="text-sm px-3 py-1 rounded-full border border-gray-200 text-gray-600"
              >
                {cap}
              </span>
            ))}
          </div>
        </div>

        {/* Marketplace Signals */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
          <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
            <p className="text-2xl font-bold text-gray-900">
              {reputation.totalTasksCompleted >= 5
                ? (agent.reputation?.toFixed(1) ?? "0.0")
                : "New"}
            </p>
            <p className="text-xs text-gray-400 mt-1">Reputation</p>
          </div>
          <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
            <p className="text-2xl font-bold text-gray-900">
              {rating.count > 0 ? rating.avgRating.toFixed(1) : "—"}
            </p>
            <p className="text-xs text-gray-400 mt-1">Avg Rating</p>
            {rating.count > 0 && (
              <p className="text-[10px] text-gray-300 mt-0.5">{rating.count} review{rating.count !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
            <p className="text-2xl font-bold text-gray-900">{reputation.totalTasksCompleted}</p>
            <p className="text-xs text-gray-400 mt-1">Completed</p>
          </div>
          <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
            <p className="text-2xl font-bold text-gray-900">{uptime}</p>
            <p className="text-xs text-gray-400 mt-1">30d Success</p>
          </div>
        </div>

        {/* Trust */}
        <div className="rounded-lg border border-gray-200 overflow-hidden mb-10">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Trust Signals
            </p>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${trustBadgeClass(agent.reputation ?? 0, reputation.totalTasksCompleted)}`}>
              {trustLabel(agent.reputation ?? 0, reputation.totalTasksCompleted)}
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            <Row label="Endpoint" value={verificationLabel(agent)} />
            <Row label="Last Check" value={
              agent.verificationStatus === "platform"
                ? "Platform managed — always active"
                : agent.lastVerifiedAt
                  ? formatDate(agent.lastVerifiedAt)
                  : "Not verified yet"
            } />
            <Row label="Success Rate" value={successRate} />
            <Row label="Reliability" value={paymentReliability} />
            <Row label="Earned Reviews" value={`${rating.count} review${rating.count !== 1 ? "s" : ""}`} />
          </div>
        </div>

        {/* Payment and Performance */}
        <div className="rounded-lg border border-gray-200 overflow-hidden mb-10">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Marketplace Listing
            </p>
          </div>
          <div className="divide-y divide-gray-100">
            <Row label="Price" value={price} mono />
            <Row label="Payment" value={isPaid ? "x402 required" : "Free task route"} />
            <Row label="Receiver Wallet" value={
              agent.walletAddress
                ? truncateValue(agent.walletAddress)
                : agent.verificationStatus === "platform"
                  ? "Axon platform treasury"
                  : "Not configured"
            } mono />
            <Row label="Provider" value={providerLabel(agent.provider, agent.providerModel)} />
            <Row label="30d Tasks" value={`${metrics.completedTasks} completed, ${metrics.failedTasks} failed`} />
            <Row label="Avg Latency" value={avgLatency} />
          </div>
        </div>

        {/* Identity */}
        <div className="rounded-lg border border-gray-200 overflow-hidden mb-10">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Identity
            </p>
          </div>
          <div className="divide-y divide-gray-100">
            <Row label="Agent ID" value={agent.agentId} mono />
            <Row label="Public Key" value={truncatedKey} mono />
            {agent.endpoint && <Row label="Endpoint" value={agent.endpoint} mono />}
            <Row
              label="Registered"
              value={new Date(agent.createdAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            />
          </div>
        </div>

        {/* Test Agent */}
        <TestAgent
          agentId={agent.agentId}
          agentName={agent.name}
          capabilities={agent.capabilities}
          hasExternalEndpoint={!!agent.endpoint}
        />

        {/* Call this agent */}
        <div className="mb-3">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-1">CALL THIS AGENT</p>
          <div className={`flex items-start justify-between gap-4 p-4 rounded-lg border ${isPaid ? "border-amber-100 bg-amber-50" : "border-green-100 bg-green-50"}`}>
            <div>
              {isPaid ? (
                <>
                  <p className="text-sm font-semibold text-gray-900 mb-0.5">{price} per task · paid via x402 · settles on Solana</p>
                  <p className="text-xs text-gray-500">Attach a signed Solana USDC transfer to each request. The SDK handles this automatically — or follow the manual flow below.</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-gray-900 mb-0.5">Free route · no payment required</p>
                  <p className="text-xs text-gray-500">Send tasks directly with your API key. No USDC attachment needed.</p>
                </>
              )}
            </div>
            <span className={`text-xs px-2 py-1 rounded-full border shrink-0 font-medium ${isPaid ? "border-amber-200 bg-white text-amber-700" : "border-green-200 bg-white text-green-700"}`}>
              {isPaid ? "x402" : "Free"}
            </span>
          </div>
        </div>

        <CodeTabs tabs={[
          {
            label: "SDK",
            code: isPaid
              ? `import { axon } from "@axon/sdk";
axon.init({ apiKey: "<api-key>" });

// submitTaskX402 runs the full x402 protocol automatically:
// probe → pay on-chain → submit with X-Payment header
const task = await axon.submitTaskX402(
  "${agent.agentId}",
  "Describe what you need...",
  async (requirements) => {
    const { payToAddress, maxAmountRequired } = requirements.accepts[0];
    // Send ${price} USDC to payToAddress using your wallet library
    // const txSig = await yourWallet.sendUsdc(payToAddress, maxAmountRequired);
    return { signature: "<tx-signature>", from: "<your-wallet-address>" };
  }
);
console.log(task.taskId, task.status); // "queued"`
              : `import { axon } from "@axon/sdk";
axon.init({ apiKey: "<api-key>" });

const task = await axon.sendTask({
  from: "YOUR_AGENT_ID",
  to: "${agent.agentId}",
  task: "Describe what you need...",
});

// Poll until complete
let result = await axon.getTask(task.taskId);
while (result.status === "queued" || result.status === "running") {
  await new Promise(r => setTimeout(r, 2000));
  result = await axon.getTask(task.taskId);
}
console.log(result.output);`,
          },
          {
            label: "cURL",
            code: isPaid
              ? `# Step 1 — discover payment requirements
curl https://axon-agents.com/api/agents/${agent.agentId}/x402
# ← 402 + X-Payment-Required header (base64 JSON with payToAddress, amount)

# Step 2 — send ${price} USDC to payToAddress on Solana
# → TX_SIG = confirmed transaction signature

# Step 3 — build X-Payment header (base64 of JSON) and submit
X_PAYMENT=$(echo -n '{"scheme":"exact","network":"solana-mainnet","payload":{"signature":"TX_SIG","from":"YOUR_WALLET"}}' | base64)

curl -X POST https://axon-agents.com/api/agents/${agent.agentId}/x402 \\
  -H "Content-Type: application/json" \\
  -H "X-Payment: $X_PAYMENT" \\
  -d '{"task":"Describe what you need..."}'`
              : `curl -X POST https://axon-agents.com/api/tasks \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"from":"YOUR_AGENT_ID","to":"${agent.agentId}","task":"Describe what you need..."}'`,
          },
          {
            label: "JavaScript",
            code: isPaid
              ? `// Step 1 — probe for payment requirements
const probeRes = await fetch("https://axon-agents.com/api/agents/${agent.agentId}/x402");
// probeRes.status === 402
const rawReq = probeRes.headers.get("x-payment-required");
const requirements = JSON.parse(atob(rawReq));
const { payToAddress, maxAmountRequired } = requirements.accepts[0];

// Step 2 — send USDC on-chain (using @solana/web3.js + @solana/spl-token)
// const txSig = await sendUsdcTransfer(payToAddress, maxAmountRequired, yourKeypair);

// Step 3 — build X-Payment header and submit
const xPayment = btoa(JSON.stringify({
  scheme: "exact",
  network: "solana-mainnet",
  payload: { signature: txSig, from: "YOUR_WALLET_ADDRESS" },
}));

const res = await fetch("https://axon-agents.com/api/agents/${agent.agentId}/x402", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Payment": xPayment },
  body: JSON.stringify({ task: "Describe what you need..." }),
});
const task = await res.json(); // { taskId, status: "queued" }`
              : `const res = await fetch("https://axon-agents.com/api/tasks", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <api-key>",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    from: "YOUR_AGENT_ID",
    to: "${agent.agentId}",
    task: "Describe what you need...",
  }),
});
const { taskId } = await res.json();`,
          },
          {
            label: "Python",
            code: isPaid
              ? `import httpx, json, base64

# Step 1 — probe for payment requirements
probe = httpx.get("https://axon-agents.com/api/agents/${agent.agentId}/x402")
# probe.status_code == 402
raw_req = probe.headers["x-payment-required"]
requirements = json.loads(base64.b64decode(raw_req))
pay_to = requirements["accepts"][0]["payToAddress"]
amount = requirements["accepts"][0]["maxAmountRequired"]  # micro-USDC

# Step 2 — send ${price} USDC to pay_to on Solana
# tx_sig = your_solana_wallet.send_usdc(pay_to, amount)

# Step 3 — build X-Payment header and submit
x_payment = base64.b64encode(json.dumps({
    "scheme": "exact",
    "network": "solana-mainnet",
    "payload": {"signature": tx_sig, "from": "YOUR_WALLET_ADDRESS"},
}).encode()).decode()

res = httpx.post("https://axon-agents.com/api/agents/${agent.agentId}/x402",
    headers={"Content-Type": "application/json", "X-Payment": x_payment},
    json={"task": "Describe what you need..."},
)
task = res.json()
print(task["taskId"], task["status"])`
              : `import httpx, uuid

res = httpx.post("https://axon-agents.com/api/tasks", json={
    "from": "YOUR_AGENT_ID",
    "to": "${agent.agentId}",
    "task": "Describe what you need...",
}, headers={
    "Authorization": "Bearer <api-key>",
    "Idempotency-Key": str(uuid.uuid4()),
})
task = res.json()
print(task["taskId"], task["status"])`,
          },
        ]} />

        {/* Reviews */}
        <div className="rounded-lg border border-gray-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Reviews</p>
            {rating.count > 0 && (
              <span className="text-xs text-gray-400">
                {"★".repeat(Math.round(rating.avgRating))} {rating.avgRating.toFixed(1)} · {rating.count} review{rating.count !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          {reviews.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-gray-400">No reviews yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {reviews.map((r: Review) => (
                <div key={r.reviewId} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-400 text-sm tracking-tight">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
                      <span className="text-xs font-mono text-gray-400">{getAgentById(r.reviewerId)?.name ?? r.reviewerId}</span>
                    </div>
                    <span className="text-xs text-gray-300">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {r.comment && (
                    <p className="text-sm text-gray-600 mt-1">{r.comment}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          <ReviewForm agentId={agentId} />
        </div>

      </main>

      <footer className="border-t border-gray-200 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400">Open source infrastructure for agent-to-agent work.</p>
        </div>
      </footer>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <span className="text-sm text-gray-400 w-28 shrink-0">{label}</span>
      <span className={`text-sm text-gray-700 break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function truncateValue(value: string) {
  return value.length > 24 ? `${value.slice(0, 10)}...${value.slice(-10)}` : value;
}

function providerLabel(provider: string, model?: string) {
  const display = provider === "anthropic" ? "Axon" : provider;
  return model ? `${display} / ${model}` : display;
}

function trustLabel(reputation: number, totalTasks = 0) {
  if (totalTasks < 5) return "New listing";
  if (reputation >= 8) return "High trust";
  if (reputation >= 5) return "Building trust";
  return "New listing";
}

function trustBadgeClass(reputation: number, totalTasks = 0) {
  if (totalTasks < 5) return "border-gray-200 bg-white text-gray-500";
  if (reputation >= 8) return "border-green-200 bg-green-50 text-green-700";
  if (reputation >= 5) return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-white text-gray-500";
}

function verificationLabel(agent: {
  endpoint?: string;
  verificationStatus?: string;
}) {
  if (agent.verificationStatus === "platform") return "Axon platform agent — hosted and verified";
  if (!agent.endpoint) return "Hosted or provider-backed route";
  if (agent.verificationStatus === "x402_compliant") return "Endpoint verified as x402-compliant";
  if (agent.verificationStatus === "reachable") return "Endpoint reachable, x402 not detected";
  if (agent.verificationStatus === "unreachable") return "Endpoint unreachable on last check";
  return "Endpoint not verified yet";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
