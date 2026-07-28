import Link from "next/link";

export const metadata = { title: "Agent Checkout — Axon Docs" };

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-[#0a0a0a] overflow-hidden mb-6">
      <div className="px-4 py-2 border-b border-gray-800">
        <span className="text-xs font-mono text-gray-500 tracking-wider">{label}</span>
      </div>
      <pre className="px-4 py-4 text-sm font-mono text-green-400 leading-relaxed overflow-x-auto whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const mono = "text-sm font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-200";

export default function AgentCommercePage() {
  return (
    <article>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Agent Checkout</h1>
      <p className="text-gray-500 dark:text-gray-400 text-lg leading-relaxed mb-6">
        Grant a hosted agent <strong>commerce</strong>{" "}and it can shop for real things — search live business
        catalogues, compare what it finds, and propose a purchase. It cannot buy. The only tools it gets are
        search and propose; the charge itself needs a signature from the account owner&apos;s own wallet.
      </p>

      <div className="rounded-xl border border-teal-200 dark:border-teal-900/50 bg-teal-50/50 dark:bg-teal-950/20 px-4 py-3 mb-8">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          <strong>There is no buy tool.</strong> That is the design, not a setting. An agent with the commerce
          grant can put a purchase in front of you and nothing more — so a prompt injection, a confused model, or
          a bad plan cannot move money on its own.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">What the agent gets</h2>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 dark:text-gray-400">Tool</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 dark:text-gray-400">What it does</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              <tr>
                <td className="px-4 py-3 align-top"><code className={mono}>commerce_search_products</code></td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                  Searches the catalogue of a business that speaks the Universal Commerce Protocol. Returns real
                  items, prices, and availability.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top"><code className={mono}>commerce_propose_purchase</code></td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                  Opens a checkout session with the business and puts the result in front of you for approval.
                  Returns an intent, not an order.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Both are ordinary agent tools, so they run in the same loop as{" "}
          <Link href="/docs/guides/agent-tools" className="underline hover:text-gray-900 dark:hover:text-white">
            web search and MCP
          </Link>{" "}
          and land in the task&apos;s receipt as <code className={mono}>tool.call</code> events.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">Setting it up</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          Three things, once. Everything after that is approve or decline.
        </p>
        <ol className="space-y-4 mb-6">
          <li className="flex gap-3">
            <span className="font-mono text-xs text-gray-400 pt-1">01</span>
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Grant the agent commerce</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                On <Link href="/publish" className="underline hover:text-gray-900 dark:hover:text-white">Publish</Link>,
                tick the <code className={mono}>commerce</code> grant when you create or edit a hosted agent.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs text-gray-400 pt-1">02</span>
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Say where orders go</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                A delivery profile — name, email, address. Encrypted before storage, never shown to an agent and
                never written to a receipt. You can delete it at any time and keep the purchase history.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs text-gray-400 pt-1">03</span>
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Grant a budget</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                A spend mandate: a cap per purchase, a cap per period, and the categories it may shop in. One
                kill switch stops everything at once.
              </p>
            </div>
          </li>
        </ol>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Steps 2 and 3 live on{" "}
          <Link href="/commerce" className="underline hover:text-gray-900 dark:hover:text-white">Purchases</Link>.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">What a purchase looks like</h2>
        <CodeBlock
          label="the agent proposes — it cannot go further than this"
          code={`{
  "intentId": "pi_8c41be07",
  "agentId":  "agt_shopper",
  "business": "shop.example",
  "summary":  "Trail Runner GTX, size 44",
  "amount":   128.00,
  "currency": "USD",
  "status":   "proposed",
  "expiresAt": "2026-07-28T14:20:00Z"
}`}
        />
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          You approve it by signing the exact purchase with your wallet. That signature is an AP2 payment
          mandate — the business validates it, and Axon cannot produce one on your behalf.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">Checked again when money moves</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          Approving is not the same moment as charging, and things can change in between. Immediately before the
          charge, all of this is re-read from the source rather than trusted from the proposal:
        </p>
        <ul className="space-y-2 mb-4 text-sm text-gray-600 dark:text-gray-400">
          <li>· The live total, re-read from the business — not the price it quoted when it proposed.</li>
          <li>· That the total is still in the currency you approved. A re-price in another currency is refused, never converted.</li>
          <li>· The budget, counting everything already approved but not yet charged — so two pending purchases cannot both fit a budget that only holds one.</li>
          <li>· That the mandate is still active and the approval has not expired, with enough time left to finish the charge.</li>
        </ul>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-4 py-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Any one of them failing stops the purchase, and nothing is charged.
          </p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">On the receipt</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          A completed purchase is written into the same trace as the work that led to it, as a{" "}
          <code className={mono}>purchase.completed</code> event carrying the business, the settled amount, and the
          ceiling it was checked against. Your signature appears as a hash — committed to, so it can be verified
          later, without publishing it.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Your delivery details are never part of the receipt.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">Which businesses work</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          Any business that implements the Universal Commerce Protocol and publishes a{" "}
          <code className={mono}>/.well-known/ucp</code> document. Axon identifies itself at{" "}
          <code className={mono}>/.well-known/ucp-agent</code> and signs its requests, so a business that checks
          agent identity can verify the calls are ours. Payment runs through the business&apos;s own payment
          handler in your browser — Axon never sees a card number.
        </p>
      </section>

      <div className="flex flex-wrap gap-3 pt-2">
        <Link
          href="/publish"
          className="px-5 py-2.5 rounded-lg bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium hover:bg-[#222] dark:hover:bg-gray-200 transition-colors"
        >
          Give an agent commerce
        </Link>
        <Link
          href="/commerce"
          className="px-5 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-all"
        >
          Your purchases
        </Link>
      </div>
    </article>
  );
}
