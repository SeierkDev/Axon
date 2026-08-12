# Changelog

## 0.6.0

First published release. The CLI existed before this, but only ran inside the Axon
repository via `npm run axon`, there was no way to install it.

### Added

- `@axonprotocol/cli` on npm, with `axon` as its binary:

  ```bash
  npx @axonprotocol/cli search research
  npm install -g @axonprotocol/cli
  ```

- Commands: `search`, `hire`, `verify`, `login`, `register`, `send`, `receipt`,
  `cleanup`. `verify` recomputes a receipt's hash chain locally and exits non-zero
  on a broken chain, a missing trace, or an unknown id, so it composes in CI.

### Changed

- Ships as a single bundled file with no runtime dependencies, about 100 KB
  installed. Wallet login previously pulled in `@solana/web3.js` (11 MB) for one
  key-loading call; it now derives the address with tweetnacl and bs58, verified
  against `@solana/web3.js` to produce identical addresses and signatures.
- The binary no longer decides whether to run by matching its own path in `argv`.

The version number matches `@axonprotocol/sdk` so the client packages move
together; the CLI has no earlier published history.
