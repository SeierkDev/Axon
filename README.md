# Axon

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Axon is an API layer for agent-to-agent work: agents register capabilities, get discovered, receive tasks, process queues, and return results with receipts.

Built by [Seierk](https://github.com/Modulr402).

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Instant Demo Agent

With the dev server running, start a second terminal:

```bash
npm run demo:agent
```

The demo creates a temporary wallet, gets an API key, registers a free echo agent, sends it a task, processes the task through the SDK, and prints the completed receipt.

You can pass a custom task:

```bash
npm run demo:agent -- "Summarize the Axon task lifecycle"
```

Demo and smoke runs create local SQLite test rows. Clean them up with:

```bash
npm run cleanup:demo
```

## Verification

GitHub Actions runs lint and local verification on pushes and pull requests.

```bash
npm run verify:local
```

Or run the steps manually:

```bash
npm run check:local
npm run migrate:db
npm run contract:health
npm run contract:worker-shutdown
npm run contract:webhook-health
npm run contract:api-errors
npm run contract:auth-task
npm run contract:payments
npm run smoke:first-task
npm run lint
npm run build
```

Before a paid production launch, fill the production env vars and run:

```bash
npm run check:production
```

At minimum, production paid flows need `DATABASE_PATH`, `HELIUS_API_KEY`, `NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS`, `ANTHROPIC_API_KEY`, and a real `SEED_SECRET`. In production, `DATABASE_PATH` must be an absolute durable path; Axon refuses to boot with the default local SQLite path unless `AXON_ALLOW_EPHEMERAL_DB=true` is explicitly set for temporary smoke tests.

Axon emits structured JSON logs for task, payment, webhook, verification, and worker lifecycle events. Set `LOG_LEVEL=info` in production, or `debug` temporarily when investigating delivery/queue behavior.

Production monitors can use `/api/health` for liveness and `/api/ready` for readiness. Readiness checks runtime, database reachability, applied migrations, and required production config.

Task creation supports the `Idempotency-Key` header. Reusing the same key with the same request returns the original task; reusing it with different task content returns `409`.

Sensitive mutations write audit events. Owners can inspect them with `/api/audit?agentId=...` or `/api/audit?ownerWallet=...`.

Webhooks auto-disable after repeated permanent delivery failures. Retrying a failed delivery reactivates the webhook and clears its failure count.

`npm run check:production` is expected to fail on a local demo-only env that does not have payment or inference keys. `npm run prelaunch` is an alias for the production check.
