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
