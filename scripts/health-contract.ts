interface HealthBody {
  ok?: boolean;
  status?: string;
  service?: string;
  checks?: Array<{ name?: string; status?: string }>;
}

export {};

async function readJson(endpoint: string, path: string): Promise<{ status: number; body: HealthBody; cacheControl: string }> {
  const res = await fetch(`${endpoint}${path}`);
  const cacheControl = res.headers.get("cache-control") ?? "";
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${path}: expected JSON response, got '${contentType || "unknown"}'`);
  }

  const body = await res.json() as HealthBody;
  return { status: res.status, body, cacheControl };
}

function requireCheck(body: HealthBody, name: string): void {
  const check = body.checks?.find((entry) => entry.name === name);
  if (!check) throw new Error(`Missing readiness check '${name}'`);
  if (check.status !== "ok" && check.status !== "warn") {
    throw new Error(`Readiness check '${name}' is ${String(check.status)}`);
  }
}

async function main() {
  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";

  const health = await readJson(endpoint, "/api/health");
  if (health.status !== 200) throw new Error(`/api/health expected HTTP 200, got ${health.status}`);
  if (health.body.ok !== true || health.body.status !== "live" || health.body.service !== "axon") {
    throw new Error("/api/health returned an invalid health payload");
  }
  if (!health.cacheControl.includes("no-store")) {
    throw new Error("/api/health must set Cache-Control: no-store");
  }

  const ready = await readJson(endpoint, "/api/ready");
  if (ready.status !== 200) throw new Error(`/api/ready expected HTTP 200, got ${ready.status}`);
  if (ready.body.ok !== true || ready.body.status !== "ready" || ready.body.service !== "axon") {
    throw new Error("/api/ready returned an invalid readiness payload");
  }
  if (!ready.cacheControl.includes("no-store")) {
    throw new Error("/api/ready must set Cache-Control: no-store");
  }

  for (const name of ["runtime", "database", "migrations", "production_config"]) {
    requireCheck(ready.body, name);
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    checked: ["/api/health", "/api/ready"],
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
