// Phase 9: protocol version negotiation.
//
// As the Axon protocol evolves, agents and the server need a way to agree on a
// common version before they transact — a handshake. The server advertises the
// versions it speaks and the protocol capabilities it supports; a client offers
// the versions it speaks, and negotiation picks the highest both share. This
// keeps the network from fragmenting as it upgrades: an older agent and a newer
// server settle on a version they both understand instead of failing opaquely.

// The current protocol version and every version this server still speaks.
// Versions are simple "major.minor" strings, ordered. Add older versions here as
// the protocol advances so prior agents keep negotiating successfully.
export const PROTOCOL_VERSION = "1.0";
export const SUPPORTED_VERSIONS = ["1.0"] as const;

// Protocol-level capabilities a peer can rely on at the negotiated version.
export const PROTOCOL_CAPABILITIES = [
  "tasks",
  "delegation",
  "quorum",
  "bidding",
  "escrow-splits",
  "workflow-templates",
  "capability-attestations",
  "task-slas",
  "abuse-reports",
  "webhooks",
  "x402",
  "mpp",
] as const;

export interface ProtocolInfo {
  version: string;
  minVersion: string;
  supported: string[];
  capabilities: string[];
}

export function getProtocolInfo(): ProtocolInfo {
  const supported = [...SUPPORTED_VERSIONS];
  return {
    version: PROTOCOL_VERSION,
    minVersion: supported[supported.length - 1],
    supported,
    capabilities: [...PROTOCOL_CAPABILITIES],
  };
}

// Compare two "major.minor" version strings. Returns <0, 0, or >0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (Number.isNaN(da) || Number.isNaN(db)) return a.localeCompare(b);
    if (da !== db) return da - db;
  }
  return 0;
}

export type NegotiationResult =
  | { ok: true; version: string; capabilities: string[] }
  | { ok: false; reason: string; supported: string[] };

// Pick the highest version both the client and this server support. The client
// passes the versions it speaks; if there's no overlap, negotiation fails with
// the server's supported list so the client knows what to target.
export function negotiateVersion(clientVersions: string[]): NegotiationResult {
  const serverSupported = [...SUPPORTED_VERSIONS];
  const common = clientVersions.filter((v) => serverSupported.includes(v as (typeof SUPPORTED_VERSIONS)[number]));
  if (common.length === 0) {
    return {
      ok: false,
      reason: "No common protocol version — the client and server share no supported version",
      supported: serverSupported,
    };
  }
  const version = common.sort(compareVersions)[common.length - 1];
  return { ok: true, version, capabilities: [...PROTOCOL_CAPABILITIES] };
}
