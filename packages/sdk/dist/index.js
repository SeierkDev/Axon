'use strict';

// src/client.ts
function pathPart(value) {
  return encodeURIComponent(value);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function toBase64(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
  return btoa(str);
}
function fromBase64(b64) {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  return atob(b64);
}
function buildPaymentHeader(signature, from, network) {
  return toBase64(JSON.stringify({ scheme: "x402", network, payload: { signature, from } }));
}
function decodeRequirements(raw) {
  try {
    const parsed = JSON.parse(fromBase64(raw));
    if (parsed.version !== "x402/1" || !Array.isArray(parsed.accepts) || !parsed.accepts.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
var AxonApiError = class extends Error {
  constructor(options) {
    super(options.message);
    this.name = "AxonApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.code = options.code;
    this.details = options.details;
    this.body = options.body;
  }
};
var AxonClient = class {
  constructor() {
    this.config = {};
    this.taskHandler = null;
  }
  init(config) {
    this.config = config;
  }
  // Identity
  async createAuthChallenge(walletAddress) {
    return this.post("/api/auth/challenge", { walletAddress });
  }
  async verifyAuthChallenge(options) {
    return this.post("/api/auth/login", options);
  }
  async logout() {
    return this.delete("/api/auth/logout");
  }
  async register(options) {
    return this.post("/api/agents", options);
  }
  async verify(options) {
    const { challenge } = await this.get(
      `/api/agents/${encodeURIComponent(options.agentId)}/challenge`
    );
    const signature = await options.sign(challenge);
    const res = await this.post("/api/agents/verify", {
      agentId: options.agentId,
      challenge,
      signature
    });
    return res.verified;
  }
  // Discovery
  async findAgents(query) {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.capabilities) params.set("capabilities", query.capabilities.join(","));
    if (query.minReputation !== void 0) params.set("minReputation", String(query.minReputation));
    if (query.maxPrice) params.set("maxPrice", query.maxPrice);
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== void 0) params.set("limit", String(query.limit));
    const res = await this.get(`/api/agents?${params.toString()}`);
    return res.agents;
  }
  async getAgent(agentId) {
    return this.get(`/api/agents/${pathPart(agentId)}`);
  }
  async getCapabilities() {
    const res = await this.get("/api/capabilities");
    return res.capabilities;
  }
  // Messaging
  async sendTask(options) {
    const { idempotencyKey, ...body } = options;
    return this.post(
      "/api/tasks",
      body,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : void 0
    );
  }
  async getTask(taskId) {
    return this.get(`/api/tasks/${pathPart(taskId)}`);
  }
  async startTask(taskId) {
    return this.post(`/api/tasks/${pathPart(taskId)}/start`, {});
  }
  async completeTask(taskId, output) {
    return this.post(`/api/tasks/${pathPart(taskId)}/complete`, { output });
  }
  async failTask(taskId, error) {
    return this.post(`/api/tasks/${pathPart(taskId)}/fail`, { error });
  }
  onTask(handler) {
    this.taskHandler = handler;
  }
  async handleIncoming(task) {
    if (!this.taskHandler) {
      return { taskId: task.taskId, success: false, output: "", error: "No handler registered", completedAt: (/* @__PURE__ */ new Date()).toISOString() };
    }
    try {
      const result = await this.taskHandler(task);
      return { taskId: task.taskId, ...result, completedAt: (/* @__PURE__ */ new Date()).toISOString() };
    } catch (err) {
      return { taskId: task.taskId, success: false, output: "", error: String(err), completedAt: (/* @__PURE__ */ new Date()).toISOString() };
    }
  }
  async processNextTask(agentId) {
    const [queued] = await this.getTaskHistory({
      agentId,
      role: "recipient",
      status: "queued",
      limit: 1
    });
    if (!queued) return null;
    const started = await this.startTask(queued.taskId);
    const result = await this.handleIncoming(started);
    if (result.success) {
      await this.completeTask(started.taskId, result.output);
    } else {
      await this.failTask(started.taskId, result.error ?? "Task failed");
    }
    return result;
  }
  // Delegation
  async delegate(options) {
    return this.post("/api/tasks/delegate", options);
  }
  async getWorkflow(workflowId) {
    return this.get(`/api/workflows/${pathPart(workflowId)}`);
  }
  async getWorkflows(agentId, limit) {
    const params = new URLSearchParams();
    if (limit !== void 0) params.set("limit", String(limit));
    const res = await this.get(`/api/agents/${pathPart(agentId)}/workflows?${params.toString()}`);
    return res.workflows;
  }
  // Payments
  async getTransactions(options) {
    const params = new URLSearchParams();
    if (options.limit !== void 0) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/transactions?${params.toString()}`);
    return res.transactions;
  }
  async getBalance(agentId) {
    return this.get(`/api/agents/${pathPart(agentId)}/balance`);
  }
  // Reputation
  async getReputation(agentId) {
    return this.get(`/api/agents/${pathPart(agentId)}/reputation`);
  }
  async getAgentMetrics(agentId, days = 30) {
    return this.get(`/api/agents/${pathPart(agentId)}/metrics?days=${encodeURIComponent(String(days))}`);
  }
  async getBudget(agentId) {
    return this.get(`/api/agents/${pathPart(agentId)}/budget`);
  }
  async createBudget(agentId, opts) {
    return this.post(`/api/agents/${pathPart(agentId)}/budget`, opts);
  }
  async getReceipt(taskId) {
    return this.get(`/api/receipts/${pathPart(taskId)}`);
  }
  async verifyEndpoint(agentId) {
    return this.get(`/api/agents/${pathPart(agentId)}/verify`);
  }
  // Task history
  async getTaskHistory(options) {
    const params = new URLSearchParams();
    if (options.role) params.set("role", options.role);
    if (options.status) params.set("status", options.status);
    if (options.limit !== void 0) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/tasks?${params.toString()}`);
    return res.tasks;
  }
  // Gateway
  async registerGatewayProvider(options) {
    const res = await this.post("/api/gateway", options);
    return res.provider;
  }
  async listGatewayProviders() {
    const res = await this.get("/api/gateway");
    return res.providers;
  }
  async getGatewayProvider(providerId) {
    const res = await this.get(`/api/gateway/${pathPart(providerId)}`);
    return res.provider;
  }
  async deleteGatewayProvider(providerId) {
    return this.delete(`/api/gateway/${pathPart(providerId)}`);
  }
  async callGatewayProvider(options) {
    const body = { ...options.body ?? {} };
    if (options.from) body.from = options.from;
    if (options.paymentSignature) body.paymentSignature = options.paymentSignature;
    const res = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(options.providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const responseBody = await res.text();
    const responseHeaders = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    return {
      status: res.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10)
    };
  }
  async callGatewayProviderX402(providerId, body, pay, opts) {
    const probeRes = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (probeRes.status !== 402) {
      const responseBody2 = await probeRes.text();
      const responseHeaders2 = {};
      probeRes.headers.forEach((v, k) => {
        responseHeaders2[k] = v;
      });
      return {
        status: probeRes.status,
        body: responseBody2,
        headers: responseHeaders2,
        taskId: responseHeaders2["x-axon-task-id"] ?? "",
        durationMs: parseInt(responseHeaders2["x-axon-duration-ms"] ?? "0", 10)
      };
    }
    const rawReq = probeRes.headers.get("x-payment-required");
    if (!rawReq) throw new Error("Axon gateway x402: missing X-Payment-Required header");
    const requirements = decodeRequirements(rawReq);
    if (!requirements) throw new Error("Axon gateway x402: could not decode X-Payment-Required header");
    const { signature, from } = await pay(requirements);
    const network = requirements.accepts[0]?.network ?? "solana-mainnet";
    const paymentHeader = buildPaymentHeader(signature, from, network);
    const paidRes = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment": paymentHeader },
      body: JSON.stringify({ ...body, from: opts?.from ?? from })
    });
    const responseBody = await paidRes.text();
    const responseHeaders = {};
    paidRes.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    if (!paidRes.ok) {
      throw this.apiErrorFromText(paidRes.status, "POST", `/api/gateway/${pathPart(providerId)}/call`, responseBody);
    }
    return {
      status: paidRes.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10)
    };
  }
  // Webhooks
  async registerWebhook(options) {
    return this.post("/api/webhooks", options);
  }
  async listWebhooks(agentId) {
    const res = await this.get(`/api/webhooks?agentId=${encodeURIComponent(agentId)}`);
    return res.webhooks;
  }
  async getWebhook(webhookId) {
    return this.get(`/api/webhooks/${pathPart(webhookId)}`);
  }
  async deleteWebhook(webhookId) {
    return this.delete(`/api/webhooks/${pathPart(webhookId)}`);
  }
  async getFailedDeliveries(agentId, limit) {
    const params = new URLSearchParams({ agentId });
    if (limit !== void 0) params.set("limit", String(limit));
    const res = await this.get(`/api/webhooks/failed?${params.toString()}`);
    return res.deliveries;
  }
  async retryWebhookDelivery(deliveryId) {
    return this.post(`/api/webhooks/deliveries/${pathPart(deliveryId)}/retry`, {});
  }
  // x402
  async getX402Requirements(agentId) {
    const res = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`);
    if (res.status === 200) return null;
    if (res.status !== 402) {
      throw await this.apiErrorFromResponse(res, "GET", `/api/agents/${pathPart(agentId)}/x402`);
    }
    const raw = res.headers.get("x-payment-required");
    if (!raw) throw new Error("Axon x402 error: server returned 402 without X-Payment-Required header");
    const decoded = decodeRequirements(raw);
    if (!decoded) throw new Error("Axon x402 error: could not decode X-Payment-Required header");
    return decoded;
  }
  async submitTaskX402(agentId, task, pay, opts) {
    const probeRes = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`, { method: "GET" });
    if (probeRes.status === 200) {
      return this.sendTask({ from: opts?.from ?? "anonymous", to: agentId, task, context: opts?.context });
    }
    if (probeRes.status !== 402) {
      throw await this.apiErrorFromResponse(probeRes, "GET", `/api/agents/${pathPart(agentId)}/x402`);
    }
    const rawReq = probeRes.headers.get("x-payment-required");
    if (!rawReq) throw new Error("Axon x402 error: 402 response missing X-Payment-Required header");
    const requirements = decodeRequirements(rawReq);
    if (!requirements) throw new Error("Axon x402 error: could not decode X-Payment-Required header");
    const { signature, from } = await pay(requirements);
    const network = requirements.accepts[0]?.network ?? "solana-mainnet";
    const paymentHeader = buildPaymentHeader(signature, from, network);
    const submitRes = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment": paymentHeader },
      body: JSON.stringify({ task, context: opts?.context })
    });
    if (!submitRes.ok) {
      throw await this.apiErrorFromResponse(submitRes, "POST", `/api/agents/${pathPart(agentId)}/x402`);
    }
    return submitRes.json();
  }
  // MCP
  async registerMcpServer(options) {
    return this.post("/api/mcp/servers", options);
  }
  async listMcpServers() {
    return this.get("/api/mcp/servers");
  }
  async getMcpServer(serverId) {
    return this.get(`/api/mcp/servers/${pathPart(serverId)}`);
  }
  async syncMcpServer(serverId) {
    return this.post(`/api/mcp/servers/${pathPart(serverId)}/sync`, {});
  }
  async deleteMcpServer(serverId) {
    return this.delete(`/api/mcp/servers/${pathPart(serverId)}`);
  }
  async callMcpTool(options) {
    return this.post(`/api/mcp/tools/${pathPart(options.toolId)}/call`, { args: options.args ?? {} });
  }
  // HTTP helpers
  baseUrl() {
    return this.config.endpoint ?? (typeof window !== "undefined" ? "" : "http://localhost:3000");
  }
  headers(extra) {
    const headers = { ...extra ?? {} };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }
  async get(path) {
    const res = await fetch(`${this.baseUrl()}${path}`, { headers: this.headers() });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", path);
    return res.json();
  }
  async post(path, body, extraHeaders) {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", ...extraHeaders ?? {} }),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "POST", path);
    return res.json();
  }
  async delete(path) {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: "DELETE",
      headers: this.headers()
    });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "DELETE", path);
    return res.json();
  }
  async apiErrorFromResponse(res, method, path) {
    const text = await res.text().catch(() => "");
    return this.apiErrorFromText(res.status, method, path, text);
  }
  apiErrorFromText(status, method, path, text) {
    let body;
    let parsed = null;
    if (text) {
      try {
        body = JSON.parse(text);
        if (isRecord(body) && typeof body.error === "string") {
          parsed = {
            error: body.error,
            code: typeof body.code === "string" ? body.code : void 0,
            details: isRecord(body.details) ? body.details : void 0
          };
        }
      } catch {
        body = text;
      }
    }
    const message = parsed?.error ?? `Axon API error: ${status} ${method} ${path}`;
    return new AxonApiError({ status, method, path, message, code: parsed?.code, details: parsed?.details, body });
  }
};

// src/webhooks.ts
async function computeHmac(secret, message) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHmac } = await import('crypto');
  return createHmac("sha256", secret).update(message).digest("hex");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
async function verifyWebhookSignature(opts) {
  const { secret, rawBody, signature, timestamp, maxAgeSeconds = 300 } = opts;
  const receivedHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  const ageSeconds = Math.floor(Date.now() / 1e3) - ts;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return false;
  const expectedHex = await computeHmac(secret, `${ts}.${rawBody}`);
  return safeEqual(receivedHex, expectedHex);
}

// src/index.ts
var axon = new AxonClient();

exports.AxonApiError = AxonApiError;
exports.AxonClient = AxonClient;
exports.axon = axon;
exports.verifyWebhookSignature = verifyWebhookSignature;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map