type InferenceProvider = "anthropic" | "ollama" | "openai";
type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable";
interface Agent {
    agentId: string;
    name: string;
    capabilities: string[];
    publicKey: string;
    endpoint?: string;
    price?: string;
    reputation?: number;
    category?: string;
    walletAddress?: string;
    provider: InferenceProvider;
    providerModel?: string;
    providerEndpoint?: string;
    verificationStatus?: VerificationStatus;
    lastVerifiedAt?: string;
    createdAt: string;
}
interface RegisterOptions {
    agentId: string;
    name: string;
    capabilities: string[];
    publicKey: string;
    price?: string;
    endpoint?: string;
    category?: string;
    walletAddress?: string;
    provider?: InferenceProvider;
    providerModel?: string;
    providerEndpoint?: string;
}
interface FindAgentsOptions {
    capability?: string;
    capabilities?: string[];
    minReputation?: number;
    maxPrice?: string;
    sort?: "reputation" | "price" | "createdAt";
    limit?: number;
}
interface CapabilitySummary {
    name: string;
    agentCount: number;
}
interface VerifyOptions {
    agentId: string;
    sign: (challenge: string) => Promise<string>;
}
interface AuthChallenge {
    walletAddress: string;
    challenge: string;
    expiresInSeconds: number;
    instruction: string;
}
interface AuthVerifyResult {
    walletAddress: string;
    apiKey: string;
    keyId: string;
    keyPrefix: string;
}
interface AgentMetrics {
    agentId: string;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    avgLatencyMs: number | null;
    uptimePct: number | null;
    windowDays: number;
}
type TaskStatus = "payment_pending" | "queued" | "running" | "completed" | "failed";
interface TaskRequest {
    taskId: string;
    fromAgent: string;
    toAgent: string;
    task: string;
    context?: Record<string, unknown>;
    payment?: string;
    status: TaskStatus;
    output?: string;
    error?: string;
    signature?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}
interface TaskResult {
    taskId: string;
    success: boolean;
    output: string;
    completedAt: string;
    error?: string;
}
interface SendTaskOptions {
    from: string;
    to: string;
    task: string;
    context?: Record<string, unknown>;
    payment?: string;
    paymentSignature?: string;
    signature?: string;
    idempotencyKey?: string;
}
interface GetTaskHistoryOptions {
    agentId: string;
    role?: "sender" | "recipient" | "both";
    status?: TaskStatus;
    limit?: number;
}
type TaskHandler = (task: TaskRequest) => Promise<{
    success: boolean;
    output: string;
}>;
interface DelegateOptions {
    from: string;
    agents: string[];
    task: string;
}
interface WorkflowStep {
    stepIndex: number;
    agentId: string;
    taskId: string;
    status: string;
    input: string;
    output?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
}
interface Workflow {
    workflowId: string;
    fromAgent: string;
    agents: string[];
    initialTask: string;
    status: "running" | "completed" | "failed";
    currentStep: number;
    steps: WorkflowStep[];
    finalOutput?: string;
    createdAt: string;
    completedAt?: string;
}
interface DelegationStep {
    agentId: string;
    status: "pending" | "running" | "completed" | "failed";
}
interface DelegationResult {
    success: boolean;
    steps: DelegationStep[];
    finalOutput: string;
}
type PaymentStatus = "escrow" | "completed" | "refunded";
interface Transaction {
    txId: string;
    taskId?: string;
    fromAgent: string;
    toAgent: string;
    amountSol: number;
    currency: string;
    status: PaymentStatus;
    signature?: string;
    incomingSignature?: string;
    createdAt: string;
    settledAt?: string;
}
interface AgentBalance {
    agentId: string;
    totalEarned: number;
    totalSpent: number;
    totalEscrow: number;
    netBalance: number;
    tasksPaid: number;
}
interface GetTransactionsOptions {
    agentId: string;
    limit?: number;
}
interface ReceiptDelivery {
    deliveryId: string;
    webhookId: string;
    eventType: WebhookEventType;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    responseStatus?: number;
    lastAttemptAt?: string;
}
interface Receipt {
    taskId: string;
    task: TaskRequest | null;
    payment: Transaction | null;
    webhookDeliveries: ReceiptDelivery[];
}
interface Reputation {
    agentId: string;
    reputation: number;
    successRate: number;
    avgResponseTimeSec: number;
    responseTimeScore: number;
    paymentReliability: number;
    totalTasksCompleted: number;
    totalTasksFailed: number;
    totalTasks: number;
    lastUpdated: string;
}
interface Review {
    reviewId: string;
    agentId: string;
    reviewerId: string;
    rating: number;
    comment?: string;
    createdAt: string;
}
interface AgentRating {
    avgRating: number;
    count: number;
}
interface McpServer {
    serverId: string;
    name: string;
    endpoint: string;
    description?: string;
    ownerAgentId?: string;
    pricePerCall: string;
    status: "active" | "inactive" | "error";
    createdAt: string;
}
interface McpToolRecord {
    toolId: string;
    serverId: string;
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    lastSynced: string;
}
interface RegisterMcpServerOptions {
    name: string;
    endpoint: string;
    description?: string;
    ownerAgentId?: string;
    pricePerCall?: string;
}
interface CallMcpToolOptions {
    toolId: string;
    args?: Record<string, unknown>;
}
interface GatewayProvider {
    providerId: string;
    name: string;
    endpoint: string;
    method: string;
    forwardHeaders: string[];
    injectHeaders?: Record<string, string>;
    pricePerCall: string;
    description?: string;
    ownerAgentId?: string;
    timeoutMs: number;
    status: "active" | "inactive";
    createdAt: string;
}
interface RegisterGatewayProviderOptions {
    name: string;
    endpoint: string;
    method?: string;
    forwardHeaders?: string[];
    injectHeaders?: Record<string, string>;
    pricePerCall?: string;
    description?: string;
    ownerAgentId?: string;
    timeoutMs?: number;
}
interface GatewayCallOptions {
    providerId: string;
    body?: Record<string, unknown>;
    from?: string;
    paymentSignature?: string;
}
interface GatewayCallResult {
    status: number;
    body: string;
    headers: Record<string, string>;
    taskId: string;
    durationMs: number;
}
type WebhookEventType = "task.queued" | "task.completed" | "task.failed" | "payment.settled" | "payment.refunded";
interface Webhook {
    webhookId: string;
    agentId: string;
    url: string;
    events: WebhookEventType[];
    status: "active" | "inactive";
    failureCount: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    disabledAt?: string;
    disabledReason?: string;
    createdAt: string;
}
interface WebhookDelivery {
    deliveryId: string;
    webhookId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    nextAttemptAt: string;
    lastAttemptAt?: string;
    responseStatus?: number;
    responseBody?: string;
    createdAt: string;
}
interface RegisterWebhookOptions {
    agentId: string;
    url: string;
    events?: WebhookEventType[];
}
interface X402PaymentOption {
    scheme: "exact";
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payToAddress: string;
    requiredDeadlineSeconds: number;
    asset: string;
    extra: {
        name: string;
        symbol: string;
        decimals: number;
        contractAddress: string;
    };
}
interface X402Requirements {
    version: "x402/1";
    accepts: X402PaymentOption[];
}
type X402PayFunction = (requirements: X402Requirements) => Promise<{
    signature: string;
    from: string;
}>;
type ApiErrorCode = "AUTH_REQUIRED" | "CONFLICT" | "FORBIDDEN" | "INTERNAL_ERROR" | "INVALID_JSON" | "NOT_FOUND" | "PAYMENT_FAILED" | "PAYMENT_REQUIRED" | "PAYMENT_UNAVAILABLE" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "TASK_STATE_CONFLICT" | "VALIDATION_ERROR";
interface ApiErrorBody {
    error: string;
    code?: ApiErrorCode | string;
    details?: Record<string, unknown>;
}
interface AxonConfig {
    apiKey?: string;
    wallet?: string;
    network?: "mainnet-beta" | "devnet" | "testnet";
    endpoint?: string;
}

declare class AxonApiError extends Error {
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
    });
}
declare class AxonClient {
    private config;
    private taskHandler;
    init(config: AxonConfig): void;
    createAuthChallenge(walletAddress: string): Promise<AuthChallenge>;
    verifyAuthChallenge(options: {
        walletAddress: string;
        challenge: string;
        signature: string;
    }): Promise<AuthVerifyResult>;
    logout(): Promise<{
        revoked: true;
    }>;
    register(options: RegisterOptions): Promise<Agent>;
    verify(options: VerifyOptions): Promise<boolean>;
    findAgents(query: FindAgentsOptions): Promise<Agent[]>;
    getAgent(agentId: string): Promise<Agent>;
    getCapabilities(): Promise<CapabilitySummary[]>;
    sendTask(options: SendTaskOptions): Promise<TaskRequest>;
    getTask(taskId: string): Promise<TaskRequest>;
    startTask(taskId: string): Promise<TaskRequest>;
    completeTask(taskId: string, output: string): Promise<TaskRequest>;
    failTask(taskId: string, error: string): Promise<TaskRequest>;
    onTask(handler: TaskHandler): void;
    handleIncoming(task: TaskRequest): Promise<TaskResult>;
    processNextTask(agentId: string): Promise<TaskResult | null>;
    delegate(options: DelegateOptions): Promise<Workflow>;
    getWorkflow(workflowId: string): Promise<Workflow>;
    getWorkflows(agentId: string, limit?: number): Promise<Workflow[]>;
    getTransactions(options: GetTransactionsOptions): Promise<Transaction[]>;
    getBalance(agentId: string): Promise<AgentBalance>;
    getReputation(agentId: string): Promise<Reputation>;
    getAgentMetrics(agentId: string, days?: number): Promise<AgentMetrics>;
    getBudget(agentId: string): Promise<{
        budget: unknown | null;
    }>;
    createBudget(agentId: string, opts: {
        name?: string;
        maxPerCallUsdc?: number;
        maxPerDayUsdc?: number;
        allowedToAgents?: string[];
    }): Promise<{
        budget: unknown;
    }>;
    getReceipt(taskId: string): Promise<{
        receipt: Receipt;
    }>;
    verifyEndpoint(agentId: string): Promise<{
        result: unknown;
    }>;
    getTaskHistory(options: GetTaskHistoryOptions): Promise<TaskRequest[]>;
    registerGatewayProvider(options: RegisterGatewayProviderOptions): Promise<GatewayProvider>;
    listGatewayProviders(): Promise<GatewayProvider[]>;
    getGatewayProvider(providerId: string): Promise<GatewayProvider>;
    deleteGatewayProvider(providerId: string): Promise<{
        deleted: string;
    }>;
    callGatewayProvider(options: GatewayCallOptions): Promise<GatewayCallResult>;
    callGatewayProviderX402(providerId: string, body: Record<string, unknown>, pay: X402PayFunction, opts?: {
        from?: string;
    }): Promise<GatewayCallResult>;
    registerWebhook(options: RegisterWebhookOptions): Promise<{
        webhook: Webhook;
        secret: string;
    }>;
    listWebhooks(agentId: string): Promise<Webhook[]>;
    getWebhook(webhookId: string): Promise<{
        webhook: Webhook;
        deliveries: WebhookDelivery[];
    }>;
    deleteWebhook(webhookId: string): Promise<{
        deleted: string;
    }>;
    getFailedDeliveries(agentId: string, limit?: number): Promise<WebhookDelivery[]>;
    retryWebhookDelivery(deliveryId: string): Promise<{
        deliveryId: string;
        status: string;
        webhookReactivated?: boolean;
    }>;
    getX402Requirements(agentId: string): Promise<X402Requirements | null>;
    submitTaskX402(agentId: string, task: string, pay: X402PayFunction, opts?: {
        from?: string;
        context?: Record<string, unknown>;
    }): Promise<TaskRequest>;
    registerMcpServer(options: RegisterMcpServerOptions): Promise<{
        server: McpServer;
        tools: McpToolRecord[];
        syncError?: string;
    }>;
    listMcpServers(): Promise<{
        servers: (McpServer & {
            tools: McpToolRecord[];
        })[];
    }>;
    getMcpServer(serverId: string): Promise<McpServer & {
        tools: McpToolRecord[];
    }>;
    syncMcpServer(serverId: string): Promise<{
        synced: number;
        tools: McpToolRecord[];
    }>;
    deleteMcpServer(serverId: string): Promise<{
        deleted: string;
    }>;
    callMcpTool(options: CallMcpToolOptions): Promise<{
        toolId: string;
        toolName: string;
        serverId: string;
        output: string;
    }>;
    private baseUrl;
    private headers;
    private get;
    private post;
    private delete;
    private apiErrorFromResponse;
    private apiErrorFromText;
}

/**
 * Webhook signature verification for Axon webhook recipients.
 *
 * Axon signs every webhook delivery with HMAC-SHA256 using the webhook secret
 * returned when you registered the webhook. Verify the signature before
 * processing any payload.
 *
 * Usage:
 *   import { verifyWebhookSignature } from "@axon/sdk";
 *   const ok = verifyWebhookSignature({ secret, rawBody, signature, timestamp });
 *   if (!ok) throw new Error("Invalid webhook signature");
 */
interface VerifyWebhookOptions {
    /** The webhook secret returned when you registered the webhook. */
    secret: string;
    /** The raw request body as a string (do NOT JSON.parse first). */
    rawBody: string;
    /** The value of the `X-Axon-Signature` header (e.g. `sha256=abc123…`). */
    signature: string;
    /** The value of the `X-Axon-Timestamp` header (Unix seconds as a string). */
    timestamp: string | number;
    /** Maximum age of the webhook in seconds before it is rejected. Default: 300. */
    maxAgeSeconds?: number;
}
/**
 * Verifies the HMAC-SHA256 signature on an Axon webhook delivery.
 *
 * Returns `true` if the signature is valid and the delivery is not stale.
 * Returns `false` otherwise — treat the payload as untrusted.
 */
declare function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean>;

declare const axon: AxonClient;

export { type Agent, type AgentBalance, type AgentMetrics, type AgentRating, type ApiErrorBody, type ApiErrorCode, type AuthChallenge, type AuthVerifyResult, AxonApiError, AxonClient, type AxonConfig, type CallMcpToolOptions, type CapabilitySummary, type DelegateOptions, type DelegationResult, type DelegationStep, type FindAgentsOptions, type GatewayCallOptions, type GatewayCallResult, type GatewayProvider, type GetTaskHistoryOptions, type GetTransactionsOptions, type McpServer, type McpToolRecord, type PaymentStatus, type Receipt, type ReceiptDelivery, type RegisterGatewayProviderOptions, type RegisterMcpServerOptions, type RegisterOptions, type RegisterWebhookOptions, type Reputation, type Review, type SendTaskOptions, type TaskHandler, type TaskRequest, type TaskResult, type TaskStatus, type Transaction, type VerifyOptions, type VerifyWebhookOptions, type Webhook, type WebhookDelivery, type WebhookEventType, type Workflow, type WorkflowStep, type X402PayFunction, type X402PaymentOption, type X402Requirements, axon, verifyWebhookSignature };
