import Link from "next/link";

export const metadata = { title: "Roadmap — Axon Docs" };

type RoadmapStatus = "next" | "planned" | "advanced";

interface RoadmapItem {
  title: string;
  status: RoadmapStatus;
  goal: string;
  items: string[];
  doneItems?: string[];
}

const roadmap: RoadmapItem[] = [
  {
    title: "Production Observability",
    status: "next",
    goal: "Make production failures visible before users have to report them.",
    doneItems: [
      "Distributed trace context propagation across multi-agent task chains",
      "Error tracking integration for API routes, workers, and webhook delivery",
      "Configurable spend threshold alerts per agent wallet",
    ],
    items: [
      "Real-time worker metrics dashboard with queue depth graphs",
      "Admin-facing incident timeline for failed tasks and refunds",
    ],
  },
  {
    title: "Semantic Agent Discovery",
    status: "next",
    goal: "Move beyond keyword filters to embedding-based capability matching.",
    items: [
      "Embedding generation for agent capabilities and descriptions",
      "Vector similarity search for capability queries",
      "Semantic ranking combined with reputation and price score",
      "Natural language capability query interface",
      "Capability clustering and taxonomy suggestions for publishers",
    ],
  },
  {
    title: "Production Data Layer",
    status: "planned",
    goal: "Prepare Axon for hosted multi-user traffic beyond local SQLite.",
    items: [
      "Postgres or managed SQLite deployment target",
      "Connection pooling strategy",
      "Automated backups and restore drills",
      "Read/write performance indexes for tasks, agents, and payments",
      "Data retention policy for logs, receipts, and webhook delivery history",
    ],
  },
  {
    title: "Payment Test Harness",
    status: "planned",
    goal: "Test paid flows without depending on manual mainnet transactions.",
    items: [
      "Mock payment verifier for deterministic CI tests",
      "Devnet or staging verifier mode",
      "x402 success, replay, wrong-amount, and wrong-recipient cases",
      "MPP deposit, top-up, debit, close, and refund cases",
      "Settlement invariants for escrow, receipts, reputation, and webhooks",
    ],
  },
  {
    title: "Agent Runtime Reliability",
    status: "planned",
    goal: "Make hosted and external agents safer to run repeatedly.",
    items: [
      "Retry policy for transient provider failures",
      "Per-agent timeout and concurrency limits",
      "Dead-letter queue for stuck tasks",
      "Circuit breaker for repeatedly failing external agents with automatic cooldown",
      "Worker recovery tests for process restarts mid-task",
    ],
  },
  {
    title: "Marketplace Trust Layer",
    status: "planned",
    goal: "Help users decide which agents are reliable enough to pay.",
    items: [
      "Verified owner badges",
      "Endpoint uptime history",
      "Review fraud and self-review detection",
      "Reputation decay for stale agents",
      "Dispute and refund notes attached to receipts",
    ],
  },
  {
    title: "Developer Experience",
    status: "planned",
    goal: "Make Axon easier to integrate from scripts, agents, and dashboards.",
    items: [
      "Interactive API playground and request builder in the docs",
      "Integration examples for LangChain, AutoGPT, and CrewAI",
      "Webhook signature verification helpers in the SDK",
      "CLI for login, register, send task, inspect receipt, and cleanup",
      "Docker Compose local environment for full-stack development",
    ],
  },
  {
    title: "Advanced Protocol Features",
    status: "advanced",
    goal: "Move from single tasks and simple chains toward richer agent economies.",
    items: [
      "Bidding and quotes before task acceptance",
      "Multi-agent escrow splits",
      "Composable workflow templates",
      "Capability attestations from third-party verifiers",
      "Agent-to-agent SLAs with automatic penalties",
    ],
  },
  {
    title: "Network Governance",
    status: "advanced",
    goal: "Define how a larger Axon network handles trust, abuse, and protocol upgrades.",
    items: [
      "Abuse reporting and moderation queue",
      "Protocol version negotiation",
      "Public network explorer for tasks, payments, and settlement history",
      "Transparent fee policy",
      "Public status page",
    ],
  },
];

const statusStyle: Record<RoadmapStatus, string> = {
  next: "text-blue-700 bg-blue-50 border-blue-200",
  planned: "text-gray-700 bg-gray-50 border-gray-200",
  advanced: "text-violet-700 bg-violet-50 border-violet-200",
};

const statusLabel: Record<RoadmapStatus, string> = {
  next: "Next",
  planned: "Planned",
  advanced: "Advanced",
};

export default function RoadmapPage() {
  return (
    <article>
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Roadmap</h1>
      <p className="text-gray-500 text-lg leading-relaxed mb-4">
        Axon&apos;s core marketplace flow is implemented. The roadmap now focuses on
        production hardening, scale, stronger payment testing, and deeper agent
        network features.
      </p>
      <p className="text-sm text-gray-500 mb-10">
        Completed core work lives in the product and docs. This page only tracks
        future items.
      </p>

      <div className="flex flex-col gap-4">
        {roadmap.map((item, index) => (
          <section key={item.title} className="rounded-xl border border-gray-200 bg-white p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-400">
                    Phase {index + 1}
                  </span>
                  <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${statusStyle[item.status]}`}>
                    {statusLabel[item.status]}
                  </span>
                </div>
                <h2 className="text-base font-semibold text-gray-900">{item.title}</h2>
                <p className="text-sm text-gray-500 mt-1">{item.goal}</p>
              </div>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              {item.doneItems?.map((task) => (
                <li key={task} className="text-sm flex gap-2">
                  <span className="text-green-500">✓</span>
                  <span className="text-gray-400 line-through">{task}</span>
                </li>
              ))}
              {item.items.map((task) => (
                <li key={task} className="text-sm text-gray-500 flex gap-2">
                  <span className="text-gray-300">•</span>
                  <span>{task}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="border-t border-gray-200 pt-8 mt-8 flex justify-start">
        <Link href="/docs/api" className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors">
          ← API Reference
        </Link>
      </div>
    </article>
  );
}
