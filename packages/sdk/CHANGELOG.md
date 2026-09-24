# Changelog

## 1.0.0

Axon settles on Robinhood Chain now, so the SDK does too. Everything about talking
to the network is unchanged; everything about paying for it has moved chain.

### Breaking

- The `./solana` subpath is gone. Payment helpers live on `./evm`:
  `solanaPayer` → `privateKeyPayer`, and `walletPayer` now takes any EIP-1193
  wallet rather than a Solana wallet adapter.
- The `./node` subpath is gone. It existed only because a browser-safe payer could
  not import Node's `crypto`; viem signs in both, so `mandateSigner` is replaced by
  `keyMandateSigner` on `./evm`.
- A mandate signature is an EIP-191 `personal_sign` hex string, not base64 Ed25519.
  Axon recovers the signer from it and matches the address, so an old signature
  recovers to nobody.
- Amounts are ETH, in wei. `maxAmountUsdc` → `maxAmountEth`. An x402 listing's
  `maxAmountRequired` is already exact units and must not be parsed as a decimal.
- `@solana/web3.js` and `@solana/spl-token` are no longer peer dependencies. `viem`
  is, and it is optional: only the `./evm` subpath needs it.
- Proof Score evidence reads `settledEth`, not `settledUsdc`.

### Paying in $AXON

- An agent can be paid in `$AXON` instead of ETH, at whatever discount its owner
  set. Choose with `payWith: "axon"` on the client, on `hire`/`run`, or per call.
  ETH stays the default: paying in a token means sending an ERC-20 rather than
  native value, and that is not a switch to flip under someone's wallet. Asking
  for the token from an agent that does not take it pays in ETH rather than
  failing.
- `selectPaymentOption(requirements, prefer)` is exported, for callers that want
  to look at both options before deciding.
- `privateKeyPayer` and `walletPayer` send an ERC-20 transfer when the chosen
  option is a token, and native value otherwise. They could only ever send native
  value before.
- `AxonQuoteExpiredError` is thrown when a token quote has lapsed. A quote pins a
  moving rate and lasts minutes; the error says to fetch the price again, rather
  than reporting a bare payment failure that reads like money went missing.

### Fixed

- **Payments from the SDK never worked.** The `X-Payment` header named its scheme
  `"x402"`, which is the protocol, where the server checks for `"exact"`. Every
  payment came back "X-Payment header is malformed or invalid", in both lanes.
  Every test that covered paying used a stub that accepted whatever the SDK sent,
  so it survived until the suite was pointed at a real server.
- The payment header now carries `quoteId`, without which the server cannot tell
  which quote a token transfer was settling and refuses it.
- The payer no longer reads `accepts[0]` regardless of what was asked for, which
  is why the token option was invisible.
- `X402PaymentOption["extra"]` declared `name`, `symbol` and `contractAddress` as
  required. The server sends them optionally and adds `quoteId`, so the type
  described a response that never arrives.
- `Reputation` gained `decayFactor` and `staleDays`, which the server had been
  sending all along. `SystemStatus` gained `jobs`, the scheduled-job ledger.
  `WorkerMetrics` is typed to its real shape rather than an index signature.

### Added

- `updateAgent(agentId, updates)`: change an agent you own after registration —
  name, capabilities, price, endpoint, tools, and whether it takes `$AXON` and at
  what discount. That last pair had no route out of the database before, so an
  agent could be offered the token and have no way to say yes.
- Missions: `startMission`, `listMissions`, `getMission`, `cancelMission`,
  `resumeMission`, `publishMission`, `getMissionReceipt`. Say what you want and
  what you will spend, and the agent plans it and hires who it needs.
- Payment channels: `openPaymentChannel`, `listPaymentChannels`,
  `getPaymentChannel`, `topUpPaymentChannel`, `closePaymentChannel`. Deposit once
  and spend it down, for agents making many cheap calls where a transfer each time
  would cost more in gas than the work. Reading or closing a channel takes the
  channel key, not the account key.
- Reproducibility: `getReproduction(taskId)` and `reproduce(taskId)`, to check a
  receipt's claimed output hash by running the task again.
- `getWorkerMetrics()`: throughput, latency, queue depth and per-agent detail.
- `npm run test:live` boots a server on a scratch database and runs the SDK
  against it. Skipped in a normal test run, which stays fast and offline.

### Changed

- The default x402 network is `eip155:4663`.
- The payer checks the wallet's balance before asking anyone to sign, so a short
  wallet fails at the door rather than after approval.
- A payment that cannot be confirmed in time still returns its hash. Axon
  re-verifies on-chain and the same hash is retryable, so a slow-but-successful
  payment is never thrown away.

### Removed

- `@axonprotocol/agenc-marketplace` and `@axonprotocol/solana-agent-kit-axon` are
  discontinued. Both were built on Solana-only foundations that have no equivalent
  here.

## 0.6.0

Agent checkout, an agent can be given a budget and a mandate, and buy real things
under it.

### Added

- `CommerceApi`, reached as `axon.commerce`, profiles, mandates, approvals, and
  watching for purchases that need a decision.
- `CommerceRefusedError`, thrown when the network declines a purchase, so a refusal
  is distinguishable from a transport failure.
- `parseAuthorisation` and `assertAuthorisationMatches`, read a mandate
  authorisation and check it against what is actually being bought before signing.
- A new `./node` subpath exporting `mandateSigner`, which signs an authorisation
  with Ed25519 using Node's `crypto`.
- `walletMandateSigner` on `./solana`, the same thing through a connected browser
  wallet.

### Changed

- `./solana` stays bundleable for the browser. The signer that needs Node's
  `crypto` lives in `./node` instead, so importing `./solana` in a web app does not
  drag a Node built-in into the bundle.
- `@solana/web3.js` and `@solana/spl-token` are now declared **optional** peer
  dependencies. Nothing about that changed at runtime, npm has never installed
  them for you, but the metadata now says so, and the README documents that
  `./solana` needs them:

  ```bash
  npm install @solana/web3.js @solana/spl-token
  ```

- The package is MIT, and now ships the MIT text. Earlier releases declared MIT in
  `package.json` while including the AGPL licence file from the parent repository.

## 0.5.0

Earlier releases are not documented here; this file starts at 0.6.0.
