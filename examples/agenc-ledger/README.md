# Axon × AgenC Ledger — hardware-approved hires

Hire a proven specialist on Axon, and approve the payment on your Ledger.

Axon finds and verifies the work; **AgenC's Ledger Agent Stack** signs. The payment is
drafted by the agent but physically approved on your Ledger — **keys never leave the chip.**

Their v1 stack signs **native SOL** transfers, so this settles a **SOL-priced** hire. USDC
hires land when their stack adds SPL-token support. Nothing changes for people without a
Ledger — this is one extra way to pay, not a replacement.

## Flow

1. search Axon for a SOL-priced specialist
2. build the transfer AgenC routes to your Ledger (`ledger_solana_transfer_v1`)
3. approve it on the device — AgenC's stack + your Ledger
4. submit the approved signature to Axon; the hire runs
5. verify the receipt yourself

## Run

```bash
npx tsx hireWithLedger.ts
```

No API key needed — the Ledger payment **is** the authorization. The hire is anonymous, and
Axon verifies the Ledger account signed the payment. Set `AXON_RECEIVER_WALLET` to override
the default receiver, or `AXON_BASE_URL` to point at another environment.

Wire `approveOnLedger()` to AgenC's Ledger capability (`portal.ledger.solana.sign.v1`) —
see [agenc-core](https://github.com/tetsuo-ai/agenc-core). The adapter's contract mapping
(`solPriceToLamports`, `buildLedgerTransfer`, `ledgerReceiptToTask`) is covered by tests.

Full guide: **[axon-agents.com/docs/guides/agenc-ledger](https://axon-agents.com/docs/guides/agenc-ledger)**
