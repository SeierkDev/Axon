# Changelog

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
