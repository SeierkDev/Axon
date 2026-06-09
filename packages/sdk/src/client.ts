import type {
  Agent,
  RegisterOptions,
  FindAgentsOptions,
  VerifyOptions,
  AgentMetrics,
  SendTaskOptions,
  TaskRequest,
  TaskResult,
  TaskHandler,
  DelegateOptions,
  Workflow,
  Reputation,
  Transaction,
  AgentBalance,
  Receipt,
  GetTransactionsOptions,
  GetTaskHistoryOptions,
  CapabilitySummary,
  AxonConfig,
  McpServer,
  McpToolRecord,
  RegisterMcpServerOptions,
  CallMcpToolOptions,
  X402Requirements,
  X402PayFunction,
  Webhook,
  WebhookDelivery,
  RegisterWebhookOptions,
  GatewayProvider,
  RegisterGatewayProviderOptions,
  GatewayCallOptions,
  GatewayCallResult,
  AuthChallenge,
  AuthVerifyResult,
  ApiErrorBody,
} from "./types";

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Browser + Node compatible base64 helpers
function toBase64(str: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
  return btoa(str);
}

function fromBase64(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  return atob(b64);
}

function buildPaymentHeader(signature: string, from: string, network: string): string {
  return toBase64(JSON.stringify({ scheme: "x402", network, payload: { signature, from } }));
}

function decodeRequirements(raw: string): X402Requirements | null {
  try {
    const parsed = JSON.parse(fromBase64(raw)) as Partial<X402Requirements>;
    if (parsed.version !== "x402/1" || !Array.isArray(parsed.accepts) || !parsed.accepts.length) {
      return null;
    }
    return parsed as X402Requirements;
  } catch {
    return null;
  }
}

export class AxonApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly body?: unknown;

  constructor(options: {
    status: number;
    method: string;
    path: string;
    message: string;
    code?: string;
    details?: Record<string, unknown>;
    body?: unknown;
  }) {
    super(options.message);
    this.name = "AxonApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.code = options.code;
    this.details = options.details;
    this.body = options.body;
  }
}

export class AxonClient {
  private config: AxonConfig = {};
  private taskHandler: TaskHandler | null = null;

  init(config: AxonConfig): void {
    this.config = config;
  }

  // Identity

  async createAuthChallenge(walletAddress: string): Promise<AuthChallenge> {
    return this.post("/api/auth/challenge", { walletAddress }) as Promise<AuthChallenge>;
  }

  async verifyAuthChallenge(options: {
    walletAddress: string;
    challenge: string;
    signature: string;
  }): Promise<AuthVerifyResult> {
    return this.post("/api/auth/login", options) as Promise<AuthVerifyResult>;
  }

  async logout(): Promise<{ revoked: true }> {
    return this.delete("/api/auth/logout") as Promise<{ revoked: true }>;
  }

  async register(options: RegisterOptions): Promise<Agent> {
    return this.post("/api/agents", options) as Promise<Agent>;
  }

  async verify(options: VerifyOptions): Promise<boolean> {
    const { challenge } = await this.get(
      `/api/agents/${encodeURIComponent(options.agentId)}/challenge`
    ) as { challenge: string };

    const signature = await options.sign(challenge);

    const res = await this.post("/api/agents/verify", {
      agentId: options.agentId,
      challenge,
      signature,
    });
    return (res as { verified: boolean }).verified;
  }

  // Discovery

  async findAgents(query: FindAgentsOptions): Promise<Agent[]> {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.capabilities) params.set("capabilities", query.capabilities.join(","));
    if (query.minReputation !== undefined) params.set("minReputation", String(query.minReputation));
    if (query.maxPrice) params.set("maxPrice", query.maxPrice);
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const res = await this.get(`/api/agents?${params.toString()}`);
    return (res as { agents: Agent[] }).agents;
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.get(`/api/agents/${pathPart(agentId)}`) as Promise<Agent>;
  }

  async getCapabilities(): Promise<CapabilitySummary[]> {
    const res = await this.get("/api/capabilities");
    return (res as { capabilities: CapabilitySummary[] }).capabilities;
  }

  // Messaging

  async sendTask(options: SendTaskOptions): Promise<TaskRequest> {
    const { idempotencyKey, ...body } = options;
    return this.post(
      "/api/tasks",
      body,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
    ) as Promise<TaskRequest>;
  }

  async getTask(taskId: string): Promise<TaskRequest> {
    return this.get(`/api/tasks/${pathPart(taskId)}`) as Promise<TaskRequest>;
  }

  async startTask(taskId: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/start`, {}) as Promise<TaskRequest>;
  }

  async completeTask(taskId: string, output: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/complete`, { output }) as Promise<TaskRequest>;
  }

  async failTask(taskId: string, error: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/fail`, { error }) as Promise<TaskRequest>;
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  async handleIncoming(task: TaskRequest): Promise<TaskResult> {
    if (!this.taskHandler) {
      return { taskId: task.taskId, success: false, output: "", error: "No handler registered", completedAt: new Date().toISOString() };
    }
    try {
      const result = await this.taskHandler(task);
      return { taskId: task.taskId, ...result, completedAt: new Date().toISOString() };
    } catch (err) {
      return { taskId: task.taskId, success: false, output: "", error: String(err), completedAt: new Date().toISOString() };
    }
  }

  async processNextTask(agentId: string): Promise<TaskResult | null> {
    const [queued] = await this.getTaskHistory({
      agentId,
      role: "recipient",
      status: "queued",
      limit: 1,
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

  async delegate(options: DelegateOptions): Promise<Workflow> {
    return this.post("/api/tasks/delegate", options) as Promise<Workflow>;
  }

  async getWorkflow(workflowId: string): Promise<Workflow> {
    return this.get(`/api/workflows/${pathPart(workflowId)}`) as Promise<Workflow>;
  }

  async getWorkflows(agentId: string, limit?: number): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await this.get(`/api/agents/${pathPart(agentId)}/workflows?${params.toString()}`);
    return (res as { workflows: Workflow[] }).workflows;
  }

  // Payments

  async getTransactions(options: GetTransactionsOptions): Promise<Transaction[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/transactions?${params.toString()}`);
    return (res as { transactions: Transaction[] }).transactions;
  }

  async getBalance(agentId: string): Promise<AgentBalance> {
    return this.get(`/api/agents/${pathPart(agentId)}/balance`) as Promise<AgentBalance>;
  }

  // Reputation

  async getReputation(agentId: string): Promise<Reputation> {
    return this.get(`/api/agents/${pathPart(agentId)}/reputation`) as Promise<Reputation>;
  }

  async getAgentMetrics(agentId: string, days = 30): Promise<AgentMetrics> {
    return this.get(`/api/agents/${pathPart(agentId)}/metrics?days=${encodeURIComponent(String(days))}`) as Promise<AgentMetrics>;
  }

  async getBudget(agentId: string): Promise<{ budget: unknown | null }> {
    return this.get(`/api/agents/${pathPart(agentId)}/budget`) as Promise<{ budget: unknown | null }>;
  }

  async createBudget(agentId: string, opts: {
    name?: string;
    maxPerCallUsdc?: number;
    maxPerDayUsdc?: number;
    allowedToAgents?: string[];
  }): Promise<{ budget: unknown }> {
    return this.post(`/api/agents/${pathPart(agentId)}/budget`, opts) as Promise<{ budget: unknown }>;
  }

  async getReceipt(taskId: string): Promise<{ receipt: Receipt }> {
    return this.get(`/api/receipts/${pathPart(taskId)}`) as Promise<{ receipt: Receipt }>;
  }

  async verifyEndpoint(agentId: string): Promise<{ result: unknown }> {
    return this.get(`/api/agents/${pathPart(agentId)}/verify`) as Promise<{ result: unknown }>;
  }

  // Task history

  async getTaskHistory(options: GetTaskHistoryOptions): Promise<TaskRequest[]> {
    const params = new URLSearchParams();
    if (options.role) params.set("role", options.role);
    if (options.status) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/tasks?${params.toString()}`);
    return (res as { tasks: TaskRequest[] }).tasks;
  }

  // Gateway

  async registerGatewayProvider(
    options: RegisterGatewayProviderOptions
  ): Promise<GatewayProvider> {
    const res = await this.post("/api/gateway", options) as { provider: GatewayProvider };
    return res.provider;
  }

  async listGatewayProviders(): Promise<GatewayProvider[]> {
    const res = await this.get("/api/gateway") as { providers: GatewayProvider[] };
    return res.providers;
  }

  async getGatewayProvider(providerId: string): Promise<GatewayProvider> {
    const res = await this.get(`/api/gateway/${pathPart(providerId)}`) as { provider: GatewayProvider };
    return res.provider;
  }

  async deleteGatewayProvider(providerId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/gateway/${pathPart(providerId)}`) as Promise<{ deleted: string }>;
  }

  async callGatewayProvider(options: GatewayCallOptions): Promise<GatewayCallResult> {
    const body: Record<string, unknown> = { ...(options.body ?? {}) };
    if (options.from) body.from = options.from;
    if (options.paymentSignature) body.paymentSignature = options.paymentSignature;

    const res = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(options.providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const responseBody = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    return {
      status: res.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
    };
  }

  async callGatewayProviderX402(
    providerId: string,
    body: Record<string, unknown>,
    pay: X402PayFunction,
    opts?: { from?: string }
  ): Promise<GatewayCallResult> {
    const probeRes = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (probeRes.status !== 402) {
      const responseBody = await probeRes.text();
      const responseHeaders: Record<string, string> = {};
      probeRes.headers.forEach((v, k) => { responseHeaders[k] = v; });
      return {
        status: probeRes.status,
        body: responseBody,
        headers: responseHeaders,
        taskId: responseHeaders["x-axon-task-id"] ?? "",
        durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
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
      body: JSON.stringify({ ...body, from: opts?.from ?? from }),
    });

    const responseBody = await paidRes.text();
    const responseHeaders: Record<string, string> = {};
    paidRes.headers.forEach((v, k) => { responseHeaders[k] = v; });

    if (!paidRes.ok) {
      throw this.apiErrorFromText(paidRes.status, "POST", `/api/gateway/${pathPart(providerId)}/call`, responseBody);
    }

    return {
      status: paidRes.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
    };
  }

  // Webhooks

  async registerWebhook(
    options: RegisterWebhookOptions
  ): Promise<{ webhook: Webhook; secret: string }> {
    return this.post("/api/webhooks", options) as Promise<{ webhook: Webhook; secret: string }>;
  }

  async listWebhooks(agentId: string): Promise<Webhook[]> {
    const res = await this.get(`/api/webhooks?agentId=${encodeURIComponent(agentId)}`);
    return (res as { webhooks: Webhook[] }).webhooks;
  }

  async getWebhook(webhookId: string): Promise<{ webhook: Webhook; deliveries: WebhookDelivery[] }> {
    return this.get(`/api/webhooks/${pathPart(webhookId)}`) as Promise<{
      webhook: Webhook;
      deliveries: WebhookDelivery[];
    }>;
  }

  async deleteWebhook(webhookId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/webhooks/${pathPart(webhookId)}`) as Promise<{ deleted: string }>;
  }

  async getFailedDeliveries(agentId: string, limit?: number): Promise<WebhookDelivery[]> {
    const params = new URLSearchParams({ agentId });
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await this.get(`/api/webhooks/failed?${params.toString()}`);
    return (res as { deliveries: WebhookDelivery[] }).deliveries;
  }

  async retryWebhookDelivery(deliveryId: string): Promise<{ deliveryId: string; status: string; webhookReactivated?: boolean }> {
    return this.post(`/api/webhooks/deliveries/${pathPart(deliveryId)}/retry`, {}) as Promise<{
      deliveryId: string;
      status: string;
      webhookReactivated?: boolean;
    }>;
  }

  // x402

  async getX402Requirements(agentId: string): Promise<X402Requirements | null> {
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

  async submitTaskX402(
    agentId: string,
    task: string,
    pay: X402PayFunction,
    opts?: { from?: string; context?: Record<string, unknown> }
  ): Promise<TaskRequest> {
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
      body: JSON.stringify({ task, context: opts?.context }),
    });

    if (!submitRes.ok) {
      throw await this.apiErrorFromResponse(submitRes, "POST", `/api/agents/${pathPart(agentId)}/x402`);
    }

    return submitRes.json() as Promise<TaskRequest>;
  }

  // MCP

  async registerMcpServer(
    options: RegisterMcpServerOptions
  ): Promise<{ server: McpServer; tools: McpToolRecord[]; syncError?: string }> {
    return this.post("/api/mcp/servers", options) as Promise<{
      server: McpServer;
      tools: McpToolRecord[];
      syncError?: string;
    }>;
  }

  async listMcpServers(): Promise<{ servers: (McpServer & { tools: McpToolRecord[] })[] }> {
    return this.get("/api/mcp/servers") as Promise<{
      servers: (McpServer & { tools: McpToolRecord[] })[];
    }>;
  }

  async getMcpServer(serverId: string): Promise<McpServer & { tools: McpToolRecord[] }> {
    return this.get(`/api/mcp/servers/${pathPart(serverId)}`) as Promise<McpServer & { tools: McpToolRecord[] }>;
  }

  async syncMcpServer(serverId: string): Promise<{ synced: number; tools: McpToolRecord[] }> {
    return this.post(`/api/mcp/servers/${pathPart(serverId)}/sync`, {}) as Promise<{
      synced: number;
      tools: McpToolRecord[];
    }>;
  }

  async deleteMcpServer(serverId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/mcp/servers/${pathPart(serverId)}`) as Promise<{ deleted: string }>;
  }

  async callMcpTool(
    options: CallMcpToolOptions
  ): Promise<{ toolId: string; toolName: string; serverId: string; output: string }> {
    return this.post(`/api/mcp/tools/${pathPart(options.toolId)}/call`, { args: options.args ?? {} }) as Promise<{
      toolId: string;
      toolName: string;
      serverId: string;
      output: string;
    }>;
  }

  // HTTP helpers

  private baseUrl(): string {
    return this.config.endpoint ?? (typeof window !== "undefined" ? "" : "http://localhost:3000");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl()}${path}`, { headers: this.headers() });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", path);
    return res.json();
  }

  private async post(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", ...(extraHeaders ?? {}) }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "POST", path);
    return res.json();
  }

  private async delete(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "DELETE", path);
    return res.json();
  }

  private async apiErrorFromResponse(res: Response, method: string, path: string): Promise<AxonApiError> {
    const text = await res.text().catch(() => "");
    return this.apiErrorFromText(res.status, method, path, text);
  }

  private apiErrorFromText(status: number, method: string, path: string, text: string): AxonApiError {
    let body: unknown;
    let parsed: ApiErrorBody | null = null;

    if (text) {
      try {
        body = JSON.parse(text) as unknown;
        if (isRecord(body) && typeof body.error === "string") {
          parsed = {
            error: body.error,
            code: typeof body.code === "string" ? body.code : undefined,
            details: isRecord(body.details) ? body.details : undefined,
          };
        }
      } catch {
        body = text;
      }
    }

    const message = parsed?.error ?? `Axon API error: ${status} ${method} ${path}`;
    return new AxonApiError({ status, method, path, message, code: parsed?.code, details: parsed?.details, body });
  }
}
