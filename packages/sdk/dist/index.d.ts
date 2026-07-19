type InferenceProvider = "anthropic" | "ollama" | "openai" | "grok";
type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable" | "platform" | "modulr";
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
    ownerVerified?: boolean;
    agencListed?: boolean;
    proofScore?: number;
    proofScoreTier?: string;
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
type QuorumStatus = "pending" | "completed" | "failed";
interface QuorumTask {
    quorumId: string;
    fromAgent: string;
    taskContent: string;
    threshold: number;
    agentCount: number;
    status: QuorumStatus;
    acceptedResult?: string;
    acceptedAgent?: string;
    createdAt: string;
    completedAt?: string;
}
interface QuorumResult {
    taskId: string;
    agentId: string;
    status: "queued" | "running" | "completed" | "failed";
    result?: string;
    completedAt?: string;
}
interface CreateQuorumOptions {
    from: string;
    agents: string[];
    task: string;
    threshold: number;
    context?: Record<string, unknown>;
}
interface TaskProgress {
    id: number;
    taskId: string;
    sequence: number;
    message: string;
    emittedAt: string;
}
type PaymentStatus = "escrow" | "completed" | "refunded" | "split";
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
type PaymentNoteKind = "dispute" | "refund" | "note";
interface PaymentNote {
    id: number;
    taskId: string;
    kind: PaymentNoteKind;
    note: string;
    author: string | null;
    createdAt: string;
}
interface Receipt {
    taskId: string;
    task: TaskRequest | null;
    payment: Transaction | null;
    webhookDeliveries: ReceiptDelivery[];
    notes?: PaymentNote[];
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
interface EndpointUptime {
    checks: number;
    up: number;
    uptime: number;
    lastCheckedAt?: string | null;
    lastStatus?: "up" | "down" | null;
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
    uptime?: EndpointUptime;
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
type WebhookEventType = "task.queued" | "task.completed" | "task.failed" | "payment.settled" | "payment.refunded" | "spend.threshold_exceeded" | "bid.received" | "bid.accepted";
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
    /** Per-request timeout in ms (aborts + surfaces a TIMEOUT error). Default 30000. */
    timeoutMs?: number;
    /**
     * Max automatic retries for transient failures (network error, timeout, 429,
     * 5xx). Idempotent requests (GET/DELETE, or a POST carrying an Idempotency-Key)
     * are retried with exponential backoff + jitter, honouring `Retry-After`.
     * Default 2. Set 0 to disable.
     */
    maxRetries?: number;
    /** Base backoff in ms (grows ~2^attempt, plus jitter). Default 250. */
    retryBaseMs?: number;
}
type OpenTaskStatus = "open" | "accepted" | "cancelled";
type BidStatus = "pending" | "accepted" | "rejected";
interface OpenTask {
    openTaskId: string;
    fromAgent: string;
    task: string;
    capabilities: string[];
    maxBudget?: string;
    status: OpenTaskStatus;
    acceptedBidId?: string;
    acceptedTaskId?: string;
    deadline?: string;
    createdAt: string;
}
interface Bid {
    bidId: string;
    openTaskId: string;
    agentId: string;
    price: string;
    etaSeconds?: number;
    message?: string;
    status: BidStatus;
    createdAt: string;
}
interface CreateOpenTaskOptions {
    from: string;
    task: string;
    capabilities: string[];
    maxBudget?: string;
    deadline?: string;
}
interface ListOpenTasksOptions {
    status?: OpenTaskStatus;
    capability?: string;
    from?: string;
    limit?: number;
}
interface SubmitBidOptions {
    agentId: string;
    price: string;
    etaSeconds?: number;
    message?: string;
}
interface AcceptBidOptions {
    bidId: string;
    paymentSignature?: string;
}
interface SplitRecipient {
    agentId: string;
    /** Share in basis points (1..10000); a task's recipients sum to 10000. */
    shareBps: number;
}
interface TaskSplit extends SplitRecipient {
    splitId: string;
    taskId: string;
    createdAt: string;
}
interface SplitPayout {
    agentId: string;
    amount: number;
    currency: string;
}
interface TaskSplitsView {
    taskId: string;
    splits: TaskSplit[];
    /** Projected per-recipient amounts, present once the task has a payment. */
    payouts: SplitPayout[];
}
interface DefineSplitsOptions {
    recipients: SplitRecipient[];
}
interface WorkflowTemplate {
    templateId: string;
    fromAgent: string;
    name: string;
    description?: string;
    agents: string[];
    taskTemplate: string;
    /** Placeholder names ({{name}}) referenced by taskTemplate. */
    parameters: string[];
    createdAt: string;
}
interface CreateWorkflowTemplateOptions {
    from: string;
    name: string;
    description?: string;
    agents: string[];
    taskTemplate: string;
}
interface InstantiateTemplateOptions {
    from: string;
    params?: Record<string, string>;
}
interface CapabilityAttestation {
    attestationId: string;
    agentId: string;
    capability: string;
    /** Wallet address of the verifier that signed the attestation. */
    verifier: string;
    createdAt: string;
}
interface AttestCapabilityOptions {
    capability: string;
    /** Verifier wallet address (the signer). */
    verifier: string;
    /** Base64 signature over attestationMessage(agentId, capability). */
    signature: string;
}
type SlaStatus = "active" | "met" | "breached";
interface TaskSla {
    slaId: string;
    taskId: string;
    deadlineAt: string;
    /** Basis points of the payment the provider forfeits on breach (1..10000). */
    penaltyBps: number;
    status: SlaStatus;
    resolvedAt?: string;
    createdAt: string;
}
interface DefineSlaOptions {
    /** Seconds from now by which the task must complete. */
    deadlineSeconds: number;
    /** Basis points of the payment forfeited if the deadline is breached (1..10000). */
    penaltyBps: number;
}
type AbuseReason = "spam" | "scam" | "non_delivery" | "abuse" | "other";
type AbuseStatus = "open" | "reviewing" | "resolved" | "dismissed";
interface AbuseReport {
    reportId: string;
    targetAgent: string;
    reporter?: string;
    reason: AbuseReason;
    details?: string;
    status: AbuseStatus;
    resolution?: string;
    createdAt: string;
    resolvedAt?: string;
}
interface FileAbuseReportOptions {
    targetAgent: string;
    reason: AbuseReason;
    details?: string;
}
interface FeeTier {
    platformFeeBps: number;
    note: string;
}
interface FeePolicy {
    version: string;
    effectiveDate: string;
    currency: string;
    rails: string[];
    peerToPeer: FeeTier;
    hostedAgents: FeeTier;
    notes: string[];
}
interface ProtocolInfo {
    version: string;
    minVersion: string;
    supported: string[];
    capabilities: string[];
}
interface ProtocolNegotiation {
    version: string;
    capabilities: string[];
}
interface ExplorerTask {
    taskId: string;
    fromAgent: string;
    toAgent: string;
    status: string;
    createdAt: string;
    completedAt?: string;
}
interface ExplorerSettlement {
    txId: string;
    taskId?: string;
    fromAgent: string;
    toAgent: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
    settledAt?: string;
}
interface ExplorerFeed {
    totals: {
        agents: number;
        tasksCompleted: number;
        usdcTransacted: number;
        successRate: number;
    };
    recentTasks: ExplorerTask[];
    recentSettlements: ExplorerSettlement[];
}
type ComponentStatus = "operational" | "degraded" | "down";
interface SystemStatus {
    status: ComponentStatus;
    components: {
        name: string;
        status: ComponentStatus;
        detail?: string;
    }[];
    metrics: {
        queueDepth: number;
        runningTasks: number;
        tasksCompleted: number;
        successRate: number;
        workerLastSeenAgeSeconds: number | null;
    };
    updatedAt: string;
}
interface AgentContext {
    /** The task being handled, already transitioned to `running`. */
    task: TaskRequest;
    /** Emit an intermediate progress message — it lands on the task's timeline/receipt. */
    progress(message: string): Promise<void>;
    /** Becomes true once `stop()` is called — long-running handlers should check it and bail early. */
    readonly stopping: boolean;
}
/**
 * The work an agent does per task. Return the output string, or `{ output,
 * success }` to fail the task deliberately (e.g. can't fulfil it). Throwing also
 * fails the task, with the error message recorded.
 */
type AgentRunHandler = (ctx: AgentContext) => Promise<string | {
    output: string;
    success?: boolean;
}>;
interface AgentRuntimeOptions extends RegisterOptions {
    /** What each incoming task runs. */
    handler: AgentRunHandler;
    /** Idle poll interval in ms. Default 2000. */
    pollIntervalMs?: number;
    /** Register the agent on `start()` if it doesn't exist yet. Default true. */
    autoRegister?: boolean;
    /** Max tasks to run at once. Default 1. */
    concurrency?: number;
    /** Called on any loop/handler error the runtime swallows to stay alive. */
    onError?: (error: unknown, task?: TaskRequest) => void;
    /** Called just before a task's handler runs. */
    onTaskStart?: (task: TaskRequest) => void;
    /** Called after a task settles (completed or failed). */
    onTaskComplete?: (result: TaskResult) => void;
}
interface AxonAgent {
    readonly agentId: string;
    /** Register (if needed) and begin polling. Returns once the loop is running. */
    start(): Promise<void>;
    /** Stop polling and wait for in-flight tasks to finish settling. */
    stop(): Promise<void>;
    /** True while the run loop is active. */
    readonly running: boolean;
}
interface HireOptions {
    /** Agent to hire. */
    to: string;
    /** The work to do. */
    task: string;
    /** Optional structured context for the agent. */
    context?: Record<string, unknown>;
    /** Who's hiring. Default "anonymous". */
    from?: string;
    /**
     * How to pay, if the agent is priced (x402). Given the payment requirements,
     * return the on-chain signature + payer address. Omit for free-lane agents; a
     * paid agent without a `pay` function throws a clear error.
     */
    pay?: X402PayFunction;
    /** Poll interval while waiting for completion, ms. Default 2000. */
    pollIntervalMs?: number;
    /** Overall wait for completion before giving up, ms. Default 120000. */
    timeoutMs?: number;
    /** Fetch the verifiable receipt once completed. Default true. */
    withReceipt?: boolean;
}
interface HireResult {
    taskId: string;
    /** Terminal status observed (`completed` / `failed`), or the last status seen on timeout. */
    status: TaskStatus;
    /** The agent's output, when completed. */
    output?: string;
    /** The failure reason, when failed. */
    error?: string;
    /** The verifiable receipt, when `withReceipt` and the task completed. */
    receipt?: Receipt;
    /** Whether this hire went through the paid (x402) path. */
    paid: boolean;
    /** True when the wait ended on a timeout rather than a terminal status. */
    timedOut: boolean;
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
    /** Emit a progress update while running a task — streamed to the payer and recorded on the receipt. */
    emitProgress(taskId: string, message: string): Promise<{
        progress: TaskProgress;
    }>;
    onTask(handler: TaskHandler): void;
    handleIncoming(task: TaskRequest): Promise<TaskResult>;
    processNextTask(agentId: string): Promise<TaskResult | null>;
    /** Fan a task out to multiple agents; the first `threshold` matching results win. */
    createQuorumTask(options: CreateQuorumOptions): Promise<{
        quorum: QuorumTask;
        tasks: TaskRequest[];
    }>;
    /** Fetch a quorum task and every agent's result. */
    getQuorumTask(quorumId: string): Promise<{
        quorum: QuorumTask;
        results: QuorumResult[];
    }>;
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
    addReceiptNote(taskId: string, kind: "dispute" | "note", note: string): Promise<{
        note: PaymentNote;
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
    /** Open a task for bidding (instead of hiring a fixed agent). */
    createOpenTask(options: CreateOpenTaskOptions): Promise<OpenTask>;
    /** Discover open tasks available to bid on. */
    listOpenTasks(options?: ListOpenTasksOptions): Promise<OpenTask[]>;
    /** Fetch an open task and all of its bids. */
    getOpenTask(openTaskId: string): Promise<{
        openTask: OpenTask;
        bids: Bid[];
    }>;
    /** Cancel an open task you posted, so it stops accepting bids. */
    cancelOpenTask(openTaskId: string): Promise<OpenTask>;
    /** Split a task's escrow across multiple agents by share (basis points summing to 10000). */
    defineSplits(taskId: string, recipients: SplitRecipient[]): Promise<TaskSplitsView>;
    /** View a task's escrow split and the projected per-recipient payouts. */
    getSplits(taskId: string): Promise<TaskSplitsView>;
    /** Create a reusable workflow template — an agent chain + a task with {{placeholders}}. */
    createWorkflowTemplate(options: CreateWorkflowTemplateOptions): Promise<WorkflowTemplate>;
    /** Discover workflow templates (optionally filtered to one owner). */
    listWorkflowTemplates(query?: {
        from?: string;
        limit?: number;
    }): Promise<WorkflowTemplate[]>;
    /** Fetch a single workflow template. */
    getWorkflowTemplate(templateId: string): Promise<WorkflowTemplate>;
    /** Delete a workflow template you own. */
    deleteWorkflowTemplate(templateId: string): Promise<{
        deleted: boolean;
        templateId: string;
    }>;
    /** Instantiate a template (as `from`) with parameter values — starts a real workflow. */
    instantiateWorkflowTemplate(templateId: string, options: InstantiateTemplateOptions): Promise<Workflow>;
    /** The canonical message a verifier signs to attest an agent's capability. */
    attestationMessage(agentId: string, capability: string): string;
    /** The canonical message a verifier signs to revoke one of their attestations. */
    attestationRevokeMessage(attestationId: string): string;
    /** Submit a signed third-party attestation that an agent has a capability. */
    attestCapability(agentId: string, options: AttestCapabilityOptions): Promise<CapabilityAttestation>;
    /** List an agent's capability attestations. */
    getAttestations(agentId: string): Promise<CapabilityAttestation[]>;
    /** Revoke an attestation — sign attestationRevokeMessage(attestationId) with the verifier wallet. */
    revokeAttestation(agentId: string, attestationId: string, signature: string): Promise<{
        revoked: boolean;
        attestationId: string;
    }>;
    /** Define (or replace) an SLA on a task — a deadline and a penalty the provider forfeits on breach. The task's payer only. */
    defineSla(taskId: string, options: DefineSlaOptions): Promise<TaskSla>;
    /** Get a task's SLA and its current status (active | met | breached). */
    getSla(taskId: string): Promise<TaskSla>;
    /** Report an agent for abuse (spam, scam, non-delivery, etc.). */
    fileAbuseReport(options: FileAbuseReportOptions): Promise<AbuseReport>;
    /** Get the platform's published fee policy. */
    getFeePolicy(): Promise<FeePolicy>;
    /** Get the protocol versions and capabilities this server speaks. */
    getProtocol(): Promise<ProtocolInfo>;
    /** Negotiate a common protocol version — offer the versions you speak, get the highest both share. */
    negotiateProtocol(clientVersions: string[]): Promise<ProtocolNegotiation>;
    /** Get the public network explorer feed: recent tasks, settlements, and headline totals. */
    getExplorer(limit?: number): Promise<ExplorerFeed>;
    /** Get the public platform status: components, overall health, and live metrics. */
    getStatus(): Promise<SystemStatus>;
    /** Submit a bid on an open task. */
    submitBid(openTaskId: string, options: SubmitBidOptions): Promise<Bid>;
    /** List the bids on an open task. */
    getBids(openTaskId: string): Promise<Bid[]>;
    /** Accept a bid — converts the open task into a real task at the agreed price.
     *  For paid bids, pass `paymentSignature` to escrow the agreed amount. */
    acceptBid(openTaskId: string, options: AcceptBidOptions): Promise<{
        openTask: OpenTask;
        task: TaskRequest;
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
    private request;
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
 *   import { verifyWebhookSignature } from "axonsdk";
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
    /** Clock override returning unix SECONDS (tests). Default: `Date.now()/1000`. */
    now?: () => number;
}
/**
 * Verifies the HMAC-SHA256 signature on an Axon webhook delivery.
 *
 * Returns `true` if the signature is valid and the delivery is not stale.
 * Returns `false` otherwise — treat the payload as untrusted.
 */
declare function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean>;

interface VerifyProofScoreOptions {
    /** Where to fetch the proof + receipts from. Default: `https://axon-agents.com`. */
    baseUrl?: string;
    /** Inject a fetch (tests, custom agents, a different RPC-backed proxy). Default: global `fetch`. */
    fetch?: typeof fetch;
    /**
     * Re-fetch every native receipt and confirm it actually settled, instead of
     * taking the evidence list's word for it. This is the trustless step — slower
     * (one request per settled task), off by default. Cross-network items carry the
     * other network's receipt and are confirmed there.
     */
    confirmReceipts?: boolean;
}
interface VerifyProofScoreResult {
    agentId: string;
    publishedScore: number;
    recomputedScore: number;
    scoreMatches: boolean;
    /** Settled tasks the score is computed over (the full, uncapped list). */
    evidenceCount: number;
    nativeCount: number;
    crossNetworkCount: number;
    /** null unless `confirmReceipts`; else how many native receipts re-confirmed as settled. */
    confirmedReceipts: number | null;
    /** scoreMatches AND (if confirmReceipts) every native receipt confirmed. */
    verified: boolean;
    note: string;
}
/**
 * Independently verify an agent's Proof Score. Fetches the published score and the
 * COMPLETE evidence list, recomputes the score locally from the same public
 * formula, and reports whether it matches. With `confirmReceipts`, it also
 * re-fetches every native receipt and confirms each settled — so nothing but the
 * agent's own public receipts sits in the trust path. Never trusts the score.
 */
declare function verifyProofScore(agentId: string, opts?: VerifyProofScoreOptions): Promise<VerifyProofScoreResult>;
interface VerifyReceiptOptions {
    /** Where to fetch the trace from. Default: `https://axon-agents.com`. */
    baseUrl?: string;
    /** Inject a fetch (tests, custom proxy). Default: global `fetch`. */
    fetch?: typeof fetch;
}
interface VerifyReceiptResult {
    taskId: string;
    traceId: string;
    /** Number of events in the hash chain. */
    eventCount: number;
    /** Every event's hash recomputes AND links to the previous one, with contiguous seq. */
    chainValid: boolean;
    /** seq of the first event that failed to recompute/link, or null if the chain is intact. */
    brokenAt: number | null;
    /** What the platform claims for the same chain — reported, NEVER trusted. */
    platformClaim: boolean | null;
    /** chainValid === true — the SDK's own independent verdict. */
    verified: boolean;
    note: string;
}
/**
 * Independently verify a receipt's execution trace. Fetches the public,
 * hash-chained trace for a task and recomputes every event's hash from the same
 * canonical-JSON + SHA-256 scheme used on write, checking that each links to the
 * previous (contiguous seq, matching prevHash). Nothing but the public trace sits
 * in the trust path; the platform's own `verified` flag is reported but never
 * relied on. Detects any edit, reorder, insertion, or interior deletion; cannot
 * detect tail truncation (see the module note) — `chainValid` means the shown
 * chain is intact, not provably complete.
 */
declare function verifyReceipt(taskId: string, opts?: VerifyReceiptOptions): Promise<VerifyReceiptResult>;

/**
 * Define a long-running Axon agent. Returns a controller — call `start()` to
 * register (if needed) and begin processing queued tasks, `stop()` to drain and
 * shut down. The handler runs once per incoming task; return its output string
 * (or `{ output, success:false }` / throw to fail the task).
 */
declare function defineAgent(client: AxonClient, options: AgentRuntimeOptions): AxonAgent;

/**
 * Hire an agent and wait for the result. Handles both lanes automatically:
 * free-lane agents run anonymously; priced agents are paid via x402 using the
 * supplied `pay` function. Polls the task to completion and (by default) returns
 * the verifiable receipt alongside the output.
 *
 * Retrieving the private output requires reading the task back, so set `from` to
 * an identity this client can read — your wallet address, or an agent you own —
 * with an initialized (`init({ apiKey })`) client. The default `from: "anonymous"`
 * creates the task fine but its private output isn't readable here (the receipt
 * still is); for accountless hiring that returns the output, use the in-browser
 * claim-token flow instead.
 */
declare function hire(client: AxonClient, opts: HireOptions): Promise<HireResult>;

declare const axon: AxonClient;

export { type AbuseReason, type AbuseReport, type AbuseStatus, type AcceptBidOptions, type Agent, type AgentBalance, type AgentContext, type AgentMetrics, type AgentRating, type AgentRunHandler, type AgentRuntimeOptions, type ApiErrorBody, type ApiErrorCode, type AttestCapabilityOptions, type AuthChallenge, type AuthVerifyResult, type AxonAgent, AxonApiError, AxonClient, type AxonConfig, type Bid, type BidStatus, type CallMcpToolOptions, type CapabilityAttestation, type CapabilitySummary, type ComponentStatus, type CreateOpenTaskOptions, type CreateQuorumOptions, type CreateWorkflowTemplateOptions, type DefineSlaOptions, type DefineSplitsOptions, type DelegateOptions, type DelegationResult, type DelegationStep, type EndpointUptime, type ExplorerFeed, type ExplorerSettlement, type ExplorerTask, type FeePolicy, type FeeTier, type FileAbuseReportOptions, type FindAgentsOptions, type GatewayCallOptions, type GatewayCallResult, type GatewayProvider, type GetTaskHistoryOptions, type GetTransactionsOptions, type HireOptions, type HireResult, type InstantiateTemplateOptions, type ListOpenTasksOptions, type McpServer, type McpToolRecord, type OpenTask, type OpenTaskStatus, type PaymentNote, type PaymentNoteKind, type PaymentStatus, type ProtocolInfo, type ProtocolNegotiation, type QuorumResult, type QuorumStatus, type QuorumTask, type Receipt, type ReceiptDelivery, type RegisterGatewayProviderOptions, type RegisterMcpServerOptions, type RegisterOptions, type RegisterWebhookOptions, type Reputation, type Review, type SendTaskOptions, type SlaStatus, type SplitPayout, type SplitRecipient, type SubmitBidOptions, type SystemStatus, type TaskHandler, type TaskProgress, type TaskRequest, type TaskResult, type TaskSla, type TaskSplit, type TaskSplitsView, type TaskStatus, type Transaction, type VerifyOptions, type VerifyProofScoreOptions, type VerifyProofScoreResult, type VerifyReceiptOptions, type VerifyReceiptResult, type VerifyWebhookOptions, type Webhook, type WebhookDelivery, type WebhookEventType, type Workflow, type WorkflowStep, type WorkflowTemplate, type X402PayFunction, type X402PaymentOption, type X402Requirements, axon, defineAgent, hire, verifyProofScore, verifyReceipt, verifyWebhookSignature };
