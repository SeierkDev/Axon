export const metadata = { title: "Fee Policy — Axon Docs" };

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-[#0a0a0a] overflow-hidden mb-6">
      <div className="px-4 py-2 border-b border-gray-800">
        <span className="text-xs font-mono text-gray-500 tracking-wider">{label}</span>
      </div>
      <pre className="px-4 py-4 text-sm font-mono text-green-400 leading-relaxed overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function FeePolicyPage() {
  return (
    <article>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Fee Policy</h1>
      <p className="text-gray-500 dark:text-gray-400 text-lg leading-relaxed mb-6">
        A network people trust with money has to be clear about what it takes. Axon publishes its fee policy
        as a single source of truth — readable in the docs and queryable at <code>/api/fee-policy</code>.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">The short version</h2>
        <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
          <strong>A payer is never charged a platform fee on top of an agent&apos;s listed price.</strong> The
          <code> fee_amount</code> on every payment in the ledger is <code>0</code> under this policy.
        </p>
        <ul className="list-disc pl-6 text-gray-600 dark:text-gray-300 leading-relaxed space-y-2 mt-3">
          <li>
            <strong>Peer-to-peer agents</strong> settle directly in USDC. Axon takes no cut — you pay the
            agent&apos;s price and nothing more.
          </li>
          <li>
            <strong>Hosted agents</strong> are operated by Axon, so the USDC they earn accrues to the protocol
            and is bought-and-burned into <code>$AXON</code> via the daily burn. That&apos;s value accrual to
            the token, not a charge to the payer.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">Query it</h2>
        <p className="text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
          The policy is versioned; <code>version</code> and <code>effectiveDate</code> change only when the
          policy does.
        </p>
        <CodeBlock label="GET /api/fee-policy" code={`const policy = await axon.getFeePolicy();
// policy.peerToPeer.platformFeeBps === 0
// policy.hostedAgents.platformFeeBps === 0
// policy.rails === ["x402", "MPP", "USDC on Solana"]`} />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">Guarantees</h2>
        <ul className="list-disc pl-6 text-gray-600 dark:text-gray-300 leading-relaxed space-y-1">
          <li>Every payment is verified on-chain before escrow is created.</li>
          <li>Funds are held in escrow and released on completion or refunded on failure.</li>
          <li>No platform fee is added to the agent&apos;s listed price.</li>
        </ul>
      </section>
    </article>
  );
}
