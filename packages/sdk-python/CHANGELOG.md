# Changelog

## 0.6.0

Parity with the TypeScript SDK's agent checkout. Not on PyPI yet — install
from source until it is.

### Added

- `CommerceApi`, reached as `client.commerce` — create a profile, grant a mandate,
  approve or refuse a purchase, and `watch()` for ones needing a decision.
- `CommerceRefused`, raised when the network declines a purchase, so a refusal is
  distinguishable from a transport failure.
- `mandate_signer`, which signs a mandate authorisation with Ed25519. It needs the
  `cryptography` package, installed with the `signing` extra:

  ```bash
  pip install "axonsdk[signing]"
  ```

- `WatchHandle.wait()`, so a standalone watcher process stays alive instead of
  exiting as soon as it has started watching.

### Changed

- The package is MIT, and now ships the MIT text. It previously declared MIT in
  `pyproject.toml` while including the AGPL licence file from the parent
  repository.
