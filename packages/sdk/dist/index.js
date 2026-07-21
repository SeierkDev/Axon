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
  /** Emit a progress update while running a task — streamed to the payer and recorded on the receipt. */
  async emitProgress(taskId, message) {
    return this.post(`/api/tasks/${pathPart(taskId)}/progress`, { message });
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
      return { ...result, taskId: task.taskId, completedAt: (/* @__PURE__ */ new Date()).toISOString() };
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
  // Quorum tasks
  /** Fan a task out to multiple agents; the first `threshold` matching results win. */
  async createQuorumTask(options) {
    return this.post("/api/tasks/quorum", options);
  }
  /** Fetch a quorum task and every agent's result. */
  async getQuorumTask(quorumId) {
    return this.get(`/api/quorum/${pathPart(quorumId)}`);
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
  // Attach a dispute (or general) note to a task's payment. Only parties to the
  // task may file one; it then surfaces on the receipt's `notes`.
  async addReceiptNote(taskId, kind, note) {
    return this.post(`/api/receipts/${pathPart(taskId)}`, { kind, note });
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
  // Bidding
  /** Open a task for bidding (instead of hiring a fixed agent). */
  async createOpenTask(options) {
    return this.post("/api/open-tasks", options);
  }
  /** Discover open tasks available to bid on. */
  async listOpenTasks(options = {}) {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.capability) params.set("capability", options.capability);
    if (options.from) params.set("from", options.from);
    if (options.limit !== void 0) params.set("limit", String(options.limit));
    const qs = params.toString();
    const res = await this.get(`/api/open-tasks${qs ? `?${qs}` : ""}`);
    return res.openTasks;
  }
  /** Fetch an open task and all of its bids. */
  async getOpenTask(openTaskId) {
    return this.get(`/api/open-tasks/${pathPart(openTaskId)}`);
  }
  /** Cancel an open task you posted, so it stops accepting bids. */
  async cancelOpenTask(openTaskId) {
    return this.delete(`/api/open-tasks/${pathPart(openTaskId)}`);
  }
  /** Split a task's escrow across multiple agents by share (basis points summing to 10000). */
  async defineSplits(taskId, recipients) {
    return this.post(`/api/tasks/${pathPart(taskId)}/splits`, { recipients });
  }
  /** View a task's escrow split and the projected per-recipient payouts. */
  async getSplits(taskId) {
    return this.get(`/api/tasks/${pathPart(taskId)}/splits`);
  }
  /** Create a reusable workflow template — an agent chain + a task with {{placeholders}}. */
  async createWorkflowTemplate(options) {
    return this.post("/api/workflow-templates", options);
  }
  /** Discover workflow templates (optionally filtered to one owner). */
  async listWorkflowTemplates(query) {
    const params = new URLSearchParams();
    if (query?.from) params.set("from", query.from);
    if (query?.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    const res = await this.get(`/api/workflow-templates${qs ? `?${qs}` : ""}`);
    return res.templates;
  }
  /** Fetch a single workflow template. */
  async getWorkflowTemplate(templateId) {
    return this.get(`/api/workflow-templates/${pathPart(templateId)}`);
  }
  /** Delete a workflow template you own. */
  async deleteWorkflowTemplate(templateId) {
    return this.delete(`/api/workflow-templates/${pathPart(templateId)}`);
  }
  /** Instantiate a template (as `from`) with parameter values — starts a real workflow. */
  async instantiateWorkflowTemplate(templateId, options) {
    const res = await this.post(`/api/workflow-templates/${pathPart(templateId)}/instantiate`, options);
    return res.workflow;
  }
  /** The canonical message a verifier signs to attest an agent's capability. */
  attestationMessage(agentId, capability) {
    return `axon-attest:${agentId}:${capability}`;
  }
  /** The canonical message a verifier signs to revoke one of their attestations. */
  attestationRevokeMessage(attestationId) {
    return `axon-attest-revoke:${attestationId}`;
  }
  /** Submit a signed third-party attestation that an agent has a capability. */
  async attestCapability(agentId, options) {
    return this.post(`/api/agents/${pathPart(agentId)}/attestations`, options);
  }
  /** List an agent's capability attestations. */
  async getAttestations(agentId) {
    const res = await this.get(`/api/agents/${pathPart(agentId)}/attestations`);
    return res.attestations;
  }
  /** Revoke an attestation — sign attestationRevokeMessage(attestationId) with the verifier wallet. */
  async revokeAttestation(agentId, attestationId, signature) {
    return this.delete(`/api/agents/${pathPart(agentId)}/attestations/${pathPart(attestationId)}`, { signature });
  }
  /** Define (or replace) an SLA on a task — a deadline and a penalty the provider forfeits on breach. The task's payer only. */
  async defineSla(taskId, options) {
    return this.post(`/api/tasks/${pathPart(taskId)}/sla`, options);
  }
  /** Get a task's SLA and its current status (active | met | breached). */
  async getSla(taskId) {
    return this.get(`/api/tasks/${pathPart(taskId)}/sla`);
  }
  /** Report an agent for abuse (spam, scam, non-delivery, etc.). */
  async fileAbuseReport(options) {
    return this.post(`/api/abuse-reports`, options);
  }
  /** Get the platform's published fee policy. */
  async getFeePolicy() {
    return this.get(`/api/fee-policy`);
  }
  /** Get the protocol versions and capabilities this server speaks. */
  async getProtocol() {
    return this.get(`/api/protocol`);
  }
  /** Negotiate a common protocol version — offer the versions you speak, get the highest both share. */
  async negotiateProtocol(clientVersions) {
    return this.post(`/api/protocol`, { clientVersions });
  }
  /** Get the public network explorer feed: recent tasks, settlements, and headline totals. */
  async getExplorer(limit) {
    const q = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.get(`/api/explorer${q}`);
  }
  /** Get the public platform status: components, overall health, and live metrics. */
  async getStatus() {
    return this.get(`/api/status`);
  }
  /** Submit a bid on an open task. */
  async submitBid(openTaskId, options) {
    return this.post(`/api/open-tasks/${pathPart(openTaskId)}/bids`, options);
  }
  /** List the bids on an open task. */
  async getBids(openTaskId) {
    const res = await this.get(`/api/open-tasks/${pathPart(openTaskId)}/bids`);
    return res.bids;
  }
  /** Accept a bid — converts the open task into a real task at the agreed price.
   *  For paid bids, pass `paymentSignature` to escrow the agreed amount. */
  async acceptBid(openTaskId, options) {
    return this.post(`/api/open-tasks/${pathPart(openTaskId)}/accept`, options);
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
  get(path) {
    return this.request("GET", path);
  }
  post(path, body, extraHeaders) {
    return this.request("POST", path, { body, headers: extraHeaders });
  }
  delete(path, body) {
    return this.request("DELETE", path, { body });
  }
  // Central request path: per-request timeout, plus automatic retry with
  // exponential backoff + jitter for transient failures (network error, timeout,
  // 429, 5xx). Only idempotent requests are retried — GET/DELETE always, a POST
  // ONLY when it carries an Idempotency-Key, so a retry can never double-apply a
  // side effect. A retryable network/timeout failure surfaces as an AxonApiError
  // with a NETWORK / TIMEOUT code (status 0) instead of a raw fetch throw.
  async request(method, path, opts = {}) {
    const maxRetries = Math.max(0, this.config.maxRetries ?? 2);
    const baseMs = this.config.retryBaseMs ?? 250;
    const timeoutMs = this.config.timeoutMs ?? 3e4;
    const url = `${this.baseUrl()}${path}`;
    const hasBody = opts.body !== void 0;
    const headers = this.headers({
      ...hasBody ? { "Content-Type": "application/json" } : {},
      ...opts.headers ?? {}
    });
    const idempotent = method === "GET" || method === "DELETE" || "Idempotency-Key" in headers;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          ...hasBody ? { body: JSON.stringify(opts.body) } : {},
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        if (idempotent && attempt < maxRetries) {
          await sleep(backoffMs(baseMs, attempt));
          continue;
        }
        throw new AxonApiError({
          status: 0,
          method,
          path,
          message: timedOut ? `Request timed out after ${timeoutMs}ms: ${method} ${path}` : `Network error: ${method} ${path}${err instanceof Error ? ` (${err.message})` : ""}`,
          code: timedOut ? "TIMEOUT" : "NETWORK"
        });
      }
      if (res.ok) return parseJson(res);
      if (idempotent && attempt < maxRetries && (res.status === 429 || res.status >= 500)) {
        await sleep(retryAfterMs(res) ?? backoffMs(baseMs, attempt));
        continue;
      }
      throw await this.apiErrorFromResponse(res, method, path);
    }
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffMs(base, attempt) {
  const ceil = Math.min(base * 2 ** attempt, 1e4);
  return Math.round(ceil / 2 + Math.random() * (ceil / 2));
}
function retryAfterMs(res) {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1e3);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
async function parseJson(res) {
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

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
  const nowSeconds = (opts.now ?? (() => Math.floor(Date.now() / 1e3)))();
  const ageSeconds = nowSeconds - ts;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return false;
  const expectedHex = await computeHmac(secret, `${ts}.${rawBody}`);
  return safeEqual(receivedHex, expectedHex);
}

// src/verify.ts
var SCALE = 1e3;
var QUALITY_WEIGHT = 0.6;
var VOLUME_WEIGHT = 0.4;
var TASKS_ANCHOR = 30;
var USDC_ANCHOR = 200;
var round = (n, dp = 3) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
var curve = (v, anchor) => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + anchor));
var provenWorkFactor = (count, usdc) => Math.min(1, 0.6 * curve(count, TASKS_ANCHOR) + 0.4 * curve(usdc, USDC_ANCHOR));
async function verifyProofScore(agentId, opts = {}) {
  const base = (opts.baseUrl ?? "https://axon-agents.com").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const id = encodeURIComponent(agentId);
  const proofRes = await f(`${base}/api/agents/${id}/proof-score`);
  if (!proofRes.ok) throw new Error(`proof-score fetch failed: HTTP ${proofRes.status}`);
  const proof = await proofRes.json();
  const evRes = await f(`${base}/api/agents/${id}/proof-score?evidence=full`);
  if (!evRes.ok) throw new Error(`evidence fetch failed: HTTP ${evRes.status}`);
  const { evidence } = await evRes.json();
  const native = evidence.filter((e) => e.network === "axon");
  const cross = evidence.filter((e) => e.network !== "axon");
  let confirmedReceipts = null;
  let count = evidence.length;
  let usdc = round(evidence.reduce((s, e) => s + e.settledUsdc, 0), 6);
  if (opts.confirmReceipts) {
    let ok = 0;
    let confirmedUsdc = 0;
    for (const e of native) {
      if (!e.verify) continue;
      try {
        const r = await f(`${base}${e.verify}`);
        if (!r.ok) continue;
        const receipt = await r.json();
        if (receipt.status === "completed" && receipt.settlement) {
          ok++;
          confirmedUsdc += e.settledUsdc;
        }
      } catch {
      }
    }
    confirmedReceipts = ok;
    count = ok + cross.length;
    usdc = round(confirmedUsdc + cross.reduce((s, e) => s + e.settledUsdc, 0), 6);
  }
  const volumeFactor = round(provenWorkFactor(count, usdc));
  const recomputedScore = Math.round(
    round(SCALE * QUALITY_WEIGHT * proof.components.quality.factor, 2) + round(SCALE * VOLUME_WEIGHT * volumeFactor, 2)
  );
  const scoreMatches = recomputedScore === proof.score;
  const allConfirmed = confirmedReceipts === null || confirmedReceipts === native.length;
  const verified = scoreMatches && allConfirmed;
  const note = !scoreMatches ? `Recomputed ${recomputedScore}, but the published score is ${proof.score} \u2014 does not match.` : allConfirmed ? `Recomputed ${recomputedScore} from ${evidence.length} settled task${evidence.length !== 1 ? "s" : ""}` + (confirmedReceipts !== null ? ` (re-confirmed ${confirmedReceipts}/${native.length} native receipts settled)` : "") + "; matches the published score." : `Score matches, but only ${confirmedReceipts}/${native.length} native receipts confirmed settled.`;
  return {
    agentId,
    publishedScore: proof.score,
    recomputedScore,
    scoreMatches,
    evidenceCount: evidence.length,
    nativeCount: native.length,
    crossNetworkCount: cross.length,
    confirmedReceipts,
    verified,
    note
  };
}
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}
async function sha256hex(input) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import('crypto');
  return createHash("sha256").update(input, "utf8").digest("hex");
}
async function verifyReceipt(taskId, opts = {}) {
  const base = (opts.baseUrl ?? "https://axon-agents.com").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const id = encodeURIComponent(taskId);
  const res = await f(`${base}/api/receipts/${id}/trace`);
  if (!res.ok) throw new Error(`trace fetch failed: HTTP ${res.status}`);
  const trace = await res.json();
  let prevHash = null;
  let expectedSeq = 1;
  let brokenAt = null;
  for (const e of trace.events) {
    const metaStr = e.meta == null ? null : canonicalStringify(e.meta);
    const recomputed = await sha256hex(
      canonicalStringify({
        traceId: trace.traceId,
        seq: e.seq,
        taskId: e.taskId,
        kind: e.kind,
        fromAgent: e.fromAgent,
        toAgent: e.toAgent,
        workflowId: e.workflowId,
        stepIndex: e.stepIndex,
        inputHash: e.inputHash,
        outputHash: e.outputHash,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costUsd: e.costUsd,
        latencyMs: e.latencyMs,
        meta: metaStr,
        createdAt: e.createdAt,
        prevHash: e.prevHash
      })
    );
    if (e.seq !== expectedSeq || e.prevHash !== prevHash || e.hash !== recomputed) {
      brokenAt = e.seq;
      break;
    }
    prevHash = e.hash;
    expectedSeq += 1;
  }
  const chainValid = brokenAt === null && trace.events.length > 0;
  const platformClaim = typeof trace.verified === "boolean" ? trace.verified : null;
  const note = chainValid ? `Recomputed all ${trace.events.length} event${trace.events.length !== 1 ? "s" : ""}; the hash chain is intact.` : trace.events.length === 0 ? "Trace has no events to verify." : `Hash chain breaks at event #${brokenAt} \u2014 the recomputed hash or link does not match.`;
  return {
    taskId: trace.taskId,
    traceId: trace.traceId,
    eventCount: trace.events.length,
    chainValid,
    brokenAt,
    platformClaim,
    verified: chainValid,
    note
  };
}

// src/runtime.ts
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
function isNotFound(err) {
  return err instanceof AxonApiError && (err.status === 404 || err.code === "NOT_FOUND");
}
function isStateConflict(err) {
  return err instanceof AxonApiError && (err.status === 409 || err.code === "TASK_STATE_CONFLICT");
}
function defineAgent(client, options) {
  const {
    handler,
    pollIntervalMs = 2e3,
    autoRegister = true,
    concurrency = 1,
    onError,
    onTaskStart,
    onTaskComplete,
    ...registration
  } = options;
  const agentId = registration.agentId;
  let running = false;
  let stopping = false;
  let loopPromise = null;
  const inFlight = /* @__PURE__ */ new Set();
  const claiming = /* @__PURE__ */ new Set();
  async function ensureRegistered() {
    if (!autoRegister) return;
    try {
      await client.getAgent(agentId);
    } catch (err) {
      if (isNotFound(err)) {
        await client.register(registration);
        return;
      }
      throw err;
    }
  }
  function safeCall(fn, ...args) {
    if (!fn) return;
    try {
      fn(...args);
    } catch {
    }
  }
  async function settle(started, ok, text) {
    const attempts = 4;
    for (let i = 0; i < attempts; i++) {
      try {
        if (ok) await client.completeTask(started.taskId, text);
        else await client.failTask(started.taskId, text);
        return true;
      } catch (err) {
        if (isStateConflict(err)) return true;
        if (i === attempts - 1) {
          safeCall(onError, err, started);
          return false;
        }
        await sleep2(Math.min(2e3, 200 * 2 ** i));
      }
    }
    return false;
  }
  async function runOne(task) {
    let started;
    try {
      started = await client.startTask(task.taskId);
    } catch (err) {
      if (isStateConflict(err)) return;
      safeCall(onError, err, task);
      return;
    }
    safeCall(onTaskStart, started);
    const ctx = {
      task: started,
      // Progress is best-effort telemetry — a failed emit must never fail the
      // task the handler is otherwise completing fine.
      progress: (message) => client.emitProgress(started.taskId, message).then(
        () => void 0,
        () => void 0
      ),
      get stopping() {
        return stopping;
      }
    };
    let ok;
    let text;
    try {
      const result = await handler(ctx);
      if (typeof result === "string") {
        ok = true;
        text = result;
      } else {
        ok = result.success !== false;
        text = ok ? result.output : result.output || "Task failed";
      }
    } catch (err) {
      ok = false;
      text = err instanceof Error ? err.message : String(err);
      safeCall(onError, err, started);
    }
    const settled = await settle(started, ok, text);
    if (settled) {
      safeCall(onTaskComplete, {
        taskId: started.taskId,
        success: ok,
        output: ok ? text : "",
        error: ok ? void 0 : text,
        completedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  async function loop() {
    while (running) {
      let launched = 0;
      try {
        const slots = concurrency - inFlight.size;
        if (slots > 0) {
          const queued = await client.getTaskHistory({ agentId, role: "recipient", status: "queued", limit: slots });
          for (const task of queued) {
            if (!running) break;
            if (claiming.has(task.taskId)) continue;
            claiming.add(task.taskId);
            const p = runOne(task).finally(() => {
              inFlight.delete(p);
              claiming.delete(task.taskId);
            });
            inFlight.add(p);
            launched++;
          }
        }
      } catch (err) {
        safeCall(onError, err);
      }
      if (launched === 0) await sleep2(pollIntervalMs);
    }
  }
  return {
    get agentId() {
      return agentId;
    },
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      running = true;
      stopping = false;
      try {
        await ensureRegistered();
      } catch (err) {
        running = false;
        throw err;
      }
      loopPromise = loop();
    },
    async stop() {
      stopping = true;
      running = false;
      await Promise.allSettled([...inFlight]);
      if (loopPromise) await loopPromise;
      loopPromise = null;
    }
  };
}

// src/hire.ts
var sleep3 = (ms) => new Promise((r) => setTimeout(r, ms));
async function hire(client, opts) {
  const {
    to,
    task,
    context,
    from = "anonymous",
    pay,
    paymentMethod,
    pollIntervalMs = 2e3,
    timeoutMs = 12e4,
    withReceipt = true
  } = opts;
  let created;
  let paid;
  if (paymentMethod === "balance") {
    if (from === "anonymous") {
      throw new Error(
        'paymentMethod "balance" requires an authenticated `from` agent \u2014 init the client with an apiKey and set `from` to an agent you own. Balance is spent from that agent\'s earnings.'
      );
    }
    created = await client.sendTask({ from, to, task, context, paymentMethod: "balance" });
    paid = true;
  } else {
    let requirements = null;
    try {
      requirements = await client.getX402Requirements(to);
    } catch {
      requirements = null;
    }
    paid = requirements !== null;
    if (paid && !pay) {
      throw new Error(
        `Agent "${to}" is priced (x402) \u2014 pass a \`pay\` function to hire it, or set paymentMethod:"balance" to spend the \`from\` agent's earned balance. Free-lane agents need no payment.`
      );
    }
    if (paid && pay) {
      created = await client.submitTaskX402(to, task, pay, { from, context });
    } else {
      created = await client.sendTask({ from, to, task, context });
    }
  }
  const deadline = Date.now() + timeoutMs;
  let current = created;
  while (current.status !== "completed" && current.status !== "failed") {
    if (Date.now() >= deadline) {
      return { taskId: current.taskId, status: current.status, paid, timedOut: true };
    }
    await sleep3(pollIntervalMs);
    try {
      current = await client.getTask(current.taskId);
    } catch {
    }
  }
  const result = {
    taskId: current.taskId,
    status: current.status,
    paid,
    timedOut: false
  };
  if (current.status === "completed") {
    result.output = current.output ?? "";
    if (withReceipt) {
      try {
        const receipt = (await client.getReceipt(current.taskId)).receipt;
        result.receipt = receipt;
      } catch {
      }
    }
  } else {
    result.error = current.error ?? "Task failed";
  }
  return result;
}

// src/index.ts
var axon = new AxonClient();

exports.AxonApiError = AxonApiError;
exports.AxonClient = AxonClient;
exports.axon = axon;
exports.defineAgent = defineAgent;
exports.hire = hire;
exports.verifyProofScore = verifyProofScore;
exports.verifyReceipt = verifyReceipt;
exports.verifyWebhookSignature = verifyWebhookSignature;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map