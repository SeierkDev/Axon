// End-to-end contract test for the Phase 9 governance read endpoints:
// protocol negotiation, network explorer, and status.
// Run against a running server: `npm run contract:governance`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).

export {}; // module scope (no imports) so helpers don't collide with other scripts

type Json = Record<string, unknown>;
interface ErrorBody { error?: string; code?: string }

async function request<T = Json>(endpoint: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${endpoint}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function assertStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
}
function assert(label: string, cond: boolean) {
  if (!cond) throw new Error(`${label}: assertion failed`);
}

async function main() {
  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";
  const json = { "Content-Type": "application/json" };

  // 1. Protocol info.
  const info = await request<{ version?: string; supported?: string[]; capabilities?: string[] }>(endpoint, "/api/protocol");
  assertStatus("protocol info", info.status, 200);
  assert("protocol has version", typeof info.body.version === "string");
  assert("protocol has capabilities", Array.isArray(info.body.capabilities) && info.body.capabilities.length > 0);

  // 2. Negotiate a shared version.
  const ok = await request<{ version?: string }>(endpoint, "/api/protocol", { method: "POST", headers: json, body: JSON.stringify({ clientVersions: ["0.9", "1.0", "2.0"] }) });
  assertStatus("negotiate ok", ok.status, 200);
  assert("negotiated 1.0", ok.body.version === "1.0");

  // 3. No common version → 409.
  const incompatible = await request<ErrorBody>(endpoint, "/api/protocol", { method: "POST", headers: json, body: JSON.stringify({ clientVersions: ["9.9"] }) });
  assertStatus("negotiate incompatible", incompatible.status, 409);

  // 4. Bad negotiate body → 400.
  const bad = await request<ErrorBody>(endpoint, "/api/protocol", { method: "POST", headers: json, body: JSON.stringify({ clientVersions: [] }) });
  assertStatus("negotiate bad", bad.status, 400);

  // 5. Explorer feed.
  const explorer = await request<{ totals?: Json; recentTasks?: unknown[]; recentSettlements?: unknown[] }>(endpoint, "/api/explorer?limit=10");
  assertStatus("explorer", explorer.status, 200);
  assert("explorer has totals", !!explorer.body.totals);
  assert("explorer has recentTasks", Array.isArray(explorer.body.recentTasks));
  assert("explorer has recentSettlements", Array.isArray(explorer.body.recentSettlements));

  // 6. Status.
  const status = await request<{ status?: string; components?: unknown[] }>(endpoint, "/api/status");
  assertStatus("status", status.status, 200);
  assert("status has overall", ["operational", "degraded", "down"].includes(status.body.status ?? ""));
  assert("status has components", Array.isArray(status.body.components) && status.body.components.length > 0);

  console.log("✓ governance contract: protocol (info + negotiate) → explorer → status");
}

main().catch((err) => {
  console.error("✗ governance contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
