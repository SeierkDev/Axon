interface ErrorBody {
  error?: string;
  code?: string;
}

interface ContractCase {
  label: string;
  path: string;
  expectedStatus: number;
  expectedCode: string;
  init?: RequestInit;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonBody(value: unknown): RequestInit {
  return {
    headers: JSON_HEADERS,
    body: JSON.stringify(value),
  };
}

async function checkCase(endpoint: string, testCase: ContractCase): Promise<void> {
  const res = await fetch(`${endpoint}${testCase.path}`, testCase.init);
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (res.status !== testCase.expectedStatus) {
    throw new Error(`${testCase.label}: expected HTTP ${testCase.expectedStatus}, got ${res.status}`);
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`${testCase.label}: expected JSON response, got '${contentType || "unknown"}'`);
  }

  let body: ErrorBody;
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    throw new Error(`${testCase.label}: response body is not valid JSON`);
  }

  if (typeof body.error !== "string" || !body.error) {
    throw new Error(`${testCase.label}: missing human-readable error`);
  }
  if (body.code !== testCase.expectedCode) {
    throw new Error(`${testCase.label}: expected code ${testCase.expectedCode}, got ${String(body.code)}`);
  }
}

async function main() {
  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";
  const missing = `missing-${Date.now()}`;

  const cases: ContractCase[] = [
    {
      label: "audit validation",
      path: "/api/audit",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
    },
    {
      label: "auth challenge validation",
      path: "/api/auth/challenge",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "auth logout requires key",
      path: "/api/auth/logout",
      expectedStatus: 401,
      expectedCode: "AUTH_REQUIRED",
      init: { method: "DELETE" },
    },
    {
      label: "agent read not found",
      path: `/api/agents/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent registration requires auth",
      path: "/api/agents",
      expectedStatus: 401,
      expectedCode: "AUTH_REQUIRED",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "agent signature verify validation",
      path: "/api/agents/verify",
      expectedStatus: 400,
      expectedCode: "INVALID_JSON",
      init: { method: "POST", headers: JSON_HEADERS, body: "not-json" },
    },
    {
      label: "agent endpoint verify not found",
      path: `/api/agents/${missing}/verify`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent challenge not found",
      path: `/api/agents/${missing}/challenge`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent budget not found",
      path: `/api/agents/${missing}/budget`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent metrics not found",
      path: `/api/agents/${missing}/metrics`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent reviews not found",
      path: `/api/agents/${missing}/reviews`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent x402 not found",
      path: `/api/agents/${missing}/x402`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "agent stream not found",
      path: `/api/agents/${missing}/stream`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "task create validation",
      path: "/api/tasks",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "task read not found",
      path: `/api/tasks/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "task lifecycle not found",
      path: `/api/tasks/${missing}/start`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "delegation validation",
      path: "/api/tasks/delegate",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "workflow not found",
      path: `/api/workflows/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "receipt not found",
      path: `/api/receipts/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "gateway provider not found",
      path: `/api/gateway/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "gateway registration validation",
      path: "/api/gateway",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "gateway call not found",
      path: `/api/gateway/${missing}/call`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "mcp server registration validation",
      path: "/api/mcp/servers",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "mcp server not found",
      path: `/api/mcp/servers/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "mcp sync not found",
      path: `/api/mcp/servers/${missing}/sync`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "mcp tool not found",
      path: `/api/mcp/tools/${missing}/call`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "mpp open validation",
      path: "/api/mpp/channels",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "mpp list validation",
      path: "/api/mpp/channels?owner=not-a-wallet",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
    },
    {
      label: "mpp channel not found",
      path: `/api/mpp/channels/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "mpp topup not found",
      path: `/api/mpp/channels/${missing}/topup`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "webhook list validation",
      path: "/api/webhooks",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
    },
    {
      label: "webhook registration validation",
      path: "/api/webhooks",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "webhook not found",
      path: `/api/webhooks/${missing}`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
    },
    {
      label: "webhook failed validation",
      path: "/api/webhooks/failed",
      expectedStatus: 400,
      expectedCode: "VALIDATION_ERROR",
    },
    {
      label: "webhook retry not found",
      path: `/api/webhooks/deliveries/${missing}/retry`,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND",
      init: { method: "POST", ...jsonBody({}) },
    },
    {
      label: "seed auth required",
      path: "/api/seed/daily",
      expectedStatus: 401,
      expectedCode: "AUTH_REQUIRED",
      init: { method: "POST", ...jsonBody({}) },
    },
  ];

  const results: string[] = [];
  for (const testCase of cases) {
    await checkCase(endpoint, testCase);
    results.push(testCase.label);
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    checked: results.length,
    cases: results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
