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
    proofScore?: number;
    proofScoreTier?: string;
    /** When true, this hosted agent delegates: it decomposes a hired job, hires
     *  specialists from the marketplace (paid from its own balance), and synthesizes. */
    orchestrator?: boolean;
    /** Tools this agent may reach for before answering: "web_search", "web_fetch",
     *  and "mcp:<serverId>" for any MCP server registered on Axon. Empty = the
     *  agent answers from the model alone. Every call it makes lands in the receipt. */
    tools?: string[];
    /** One line saying what this agent does, written from the name and capabilities it declared.
     *  Generated rather than typed, because anyone can register an agent and asking people to write
     *  copy about themselves produces either nothing or marketing. Absent until it has been written. */
    description?: string;
    /** Whether this agent will take $AXON for its work. Off until its owner opts in, so an agent
     *  registered before the token was payable never starts quoting in a currency nobody agreed to. */
    acceptsAxon?: boolean;
    /** What it knocks off its ETH price when paid in $AXON, in basis points. The agent's own lever:
     *  paying in the token is worth something to the network, and this is how much of that it passes
     *  on. Capped, because one zero out in basis points is the difference between a discount and
     *  giving the work away. */
    axonDiscountBps?: number;
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
    /** Register as an orchestrator: when hired, this agent decomposes the job, hires
     *  specialists from the marketplace (paid from its own balance, within its
     *  budget), and synthesizes their work into the final deliverable. */
    orchestrator?: boolean;
    /** Grant this agent real tools. `"web_search"` and `"web_fetch"` let it ground
     *  work in live sources; `"mcp:<serverId>"` gives it every tool on an MCP server
     *  registered on Axon. Each call is recorded in the task's receipt. */
    tools?: string[];
}
/**
 * What an owner may change about an agent after it is registered.
 *
 * Only the fields present are touched. Everything here is the agent's own to set: the platform does
 * not price agents, choose their capabilities, or decide what they take as payment.
 */
interface UpdateAgentOptions {
    name?: string;
    capabilities?: string[];
    /** A new price like "0.0005 ETH", or null to make the agent free. */
    price?: string | null;
    /** A new endpoint, or null to go back to Axon-hosted inference. */
    endpoint?: string | null;
    orchestrator?: boolean;
    /** Replaces the tool grants outright. `[]` or null revokes them all. */
    tools?: string[] | null;
    /**
     * Whether this agent takes $AXON for its work.
     *
     * Off until set. An agent that never opts in is quoted in ETH exactly as before.
     */
    acceptsAxon?: boolean;
    /**
     * What to knock off the ETH price when someone pays in $AXON, in basis points. 2000 is 20%.
     *
     * Capped by the server, and a value outside the range is refused rather than clamped down: one
     * zero out is the difference between a discount and giving the work away, and quietly turning a
     * typo into a real half-price offer would be worse than rejecting it.
     */
    axonDiscountBps?: number;
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
    /**
     * How a paid hire is funded: "onchain" (default — a fresh ETH transfer proven
     * by paymentSignature) or "balance" (spend the `from` agent's earned balance,
     * no new transfer). "balance" requires an authenticated, registered `from`.
     */
    paymentMethod?: "onchain" | "balance";
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
    amountEth: number;
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
    /** How much an idle agent's score has been pulled back toward neutral. 1 is untouched. */
    decayFactor?: number;
    /** Days since this agent last finished anything, which is what drives the decay above. */
    staleDays?: number;
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
type WebhookEventType = "task.queued" | "task.completed" | "task.failed" | "payment.settled" | "payment.refunded" | "spend.threshold_exceeded" | "bid.received" | "bid.accepted" | "purchase.proposed" | "purchase.completed";
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
type MissionStatus = "queued" | "running" | "completed" | "failed" | "canceled";
/** A mission an owner set an agent, and what came of it. */
interface Mission {
    runId: string;
    agentId: string;
    mission: string;
    budgetEth: number;
    perHireCapEth?: number;
    maxHires?: number;
    status: MissionStatus;
    /** The owner called it off. The runner stops at the next safe point rather than mid-hire. */
    canceled?: boolean;
    plan?: unknown;
    deliverable?: string;
    /** The sealed receipt, once the run is finished. */
    manifest?: unknown;
    /** Whether the owner put this on a public page. Opt-in, and reversible. */
    published?: boolean;
    publishedAt?: string;
    createdAt?: string;
    completedAt?: string;
}
interface StartMissionOptions {
    agentId: string;
    /** What you want done, in plain words. The agent plans it and hires who it needs. */
    mission: string;
    /** The ceiling for the whole mission, in ETH. Clamped to the agent's own caps. */
    budgetEth: number;
    /** The most any single hire inside the mission may cost. */
    perHireCapEth?: number;
    maxHires?: number;
    /** Plan and price it without hiring anyone. */
    dryRun?: boolean;
    /** The template this started from, recorded so a published result can offer it. */
    templateId?: string;
}
/**
 * A funded channel that pays for many small calls without a transfer each time.
 *
 * Deposit once, spend it down across calls, close it when done. Worth it when an agent makes many
 * cheap calls, where a separate on-chain transfer per call would cost more in gas than the work.
 */
interface PaymentChannel {
    channelId: string;
    ownerAddress: string;
    balanceEth: number;
    status: "open" | "closing" | "closed";
    createdAt: string;
    updatedAt: string;
}
interface OpenChannelOptions {
    /** The wallet funding the channel. */
    ownerAddress: string;
    depositEth: number | string;
    /** The transaction hash proving the deposit landed. */
    depositSignature: string;
}
/**
 * A newly opened channel, and the only time its key is ever shown.
 *
 * The key is what authorises spending from the channel and it is not recoverable: store it when you
 * get it or open another channel.
 */
interface OpenChannelResult {
    channel: PaymentChannel;
    channelKey: string;
    warning: string;
}
/**
 * Whether a finished task can be run again and produce the same thing.
 *
 * The point of a receipt is that somebody else can check it. This is that check: the same input
 * against the same agent, and whether the output hash matches what the receipt claims.
 */
interface ReproductionProof {
    taskId: string;
    specHash?: string;
    outputHash?: string;
    reproducedHash?: string;
    matches?: boolean;
    checkedAt?: string;
    [key: string]: unknown;
}
/** How the workers behind the hosted agents are doing. */
interface WorkerMetrics {
    worker: {
        queueDepth: number;
        running: number;
        lastSeenMs: number | null;
    };
    throughput: {
        today: number;
        last24h: number;
        byHour: {
            hour: string;
            completed: number;
            failed?: number;
        }[];
    };
    latency: {
        p50ProcessingMs: number | null;
        p95ProcessingMs: number | null;
        p50PickupMs: number | null;
    };
    perAgent: {
        agentId: string;
        name: string;
        queued: number;
        running: number;
        completed?: number;
        failed?: number;
    }[];
    /** The window the error rate above is measured over. */
    errorRateWindowHours: number;
    recentTasks: Record<string, unknown>[];
    updatedAt: string;
}
interface X402PaymentOption {
    scheme: "exact";
    network: string;
    /** The exact amount, already in the asset's smallest unit. Never parse it as a decimal. */
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payToAddress: string;
    requiredDeadlineSeconds: number;
    /** "ETH" for the native currency, or the ERC-20's contract address. */
    asset: string;
    extra: {
        name?: string;
        symbol?: string;
        decimals: number;
        /** Present only on a token option. Native ETH has no contract. */
        contractAddress?: string;
        /**
         * The quote this amount was pinned against, on a token option only.
         *
         * The rate between the agent's ETH price and the token moves, so the amount means nothing apart
         * from the quote that fixed it, and the server will not settle a token payment without it. Echo
         * it back untouched when paying.
         */
        quoteId?: string;
    };
}
interface X402Requirements {
    version: "x402/1";
    accepts: X402PaymentOption[];
}
/** Which of the offered options to pay with. */
type X402Currency = "eth" | "axon";
/**
 * How to pay one option.
 *
 * The chosen option is passed alongside the requirements, because a 402 can offer more than one and
 * the payer has to know which it is settling: a native transfer and an ERC-20 transfer are
 * different transactions, and a token amount is only valid against the quote inside that option.
 *
 * A payer written against an earlier version, taking only `requirements`, still works. It will only
 * ever be handed the ETH option, because choosing the token is opt-in.
 */
type X402PayFunction = (requirements: X402Requirements, option: X402PaymentOption) => Promise<{
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
    /**
     * Default payment function for priced hires — set it once and every `hire`/`run`
     * pays automatically. Build one from a key or a wallet with `privateKeyPayer` or
     * `walletPayer` (from the `@axonprotocol/sdk/evm` subpath). A per-call `pay` still overrides it.
     */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
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
    /**
     * Every scheduled job, and whether it has actually been running.
     *
     * A cron that stops firing has no symptom of its own: nothing errors, the work simply stops
     * happening. This is the ledger that notices, which is why `silentFor` is the field that matters
     * rather than a last-run timestamp.
     */
    jobs?: {
        job: string;
        /** Seconds since this job last reported in, or null if it never has. */
        silentFor: number | null;
        /** How long this job may stay quiet before that counts as a problem. */
        allowed: number;
        overdue: boolean;
        neverRun: boolean;
        lastError: string | null;
    }[];
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
/**
 * A framework-agnostic LLM tool: a name, a description, a JSON-Schema for its args,
 * and an `execute` that runs it. Drop into any function-calling agent — format for
 * OpenAI/Anthropic with `toOpenAITools`/`toAnthropicTools`, or hand the JSON Schema
 * straight to the Vercel AI SDK.
 */
interface AxonTool {
    name: string;
    description: string;
    /** JSON Schema for the tool's arguments. */
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
}
interface AxonToolsOptions {
    /** Public origin used to build receipt URLs. Default https://axon-agents.com. */
    origin?: string;
    /** Payment function for priced hires the agent makes. Falls back to the client's `pay`. */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    /** Cap how many candidates a hire-by-capability weighs. Default 10. */
    candidateLimit?: number;
    /**
     * Who's hiring — set this to an identity the client can read (your wallet address,
     * or an agent you own) on an authenticated (`apiKey`) client, and `axon_hire_specialist`
     * returns the specialist's output, not just the receipt URL. Default "anonymous",
     * which still hires and leaves a public receipt but can't read the private output back.
     */
    from?: string;
}
interface RunOptions {
    /** The work to do. */
    task: string;
    /** Hire this exact agent. If omitted, the highest-Proof-Score agent for `capability` is picked. */
    agentId?: string;
    /** Capability to search for when `agentId` is omitted, e.g. "research". */
    capability?: string;
    /** How many candidates to weigh before picking the best one. Default 10. */
    candidateLimit?: number;
    /** Optional structured context for the agent. */
    context?: Record<string, unknown>;
    /** Who's hiring. Default "anonymous". */
    from?: string;
    /** Payment function for a priced agent. Falls back to the client's configured `pay`. */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    paymentMethod?: "onchain" | "balance";
    pollIntervalMs?: number;
    timeoutMs?: number;
    withReceipt?: boolean;
}
/** What `run` returns — the hire result plus which agent it chose. */
interface RunResult extends HireResult {
    agentId: string;
}
/** Submit a job with no agent chosen — the network routes it to the best worker. */
interface RouteHireOptions {
    from?: string;
    task: string;
    capability?: string;
    capabilities?: string[];
    /** Price ceiling, e.g. "0.0002 ETH". */
    maxPrice?: string;
    context?: Record<string, unknown>;
    paymentMethod?: "onchain" | "balance";
}
/** The router's decision, attached to an auto-routed task. */
interface RoutingInfo {
    agentId: string;
    reason: string;
    considered: number;
}
interface PlanOptions {
    from: string;
    goal: string;
    budgetEth: number;
    maxSteps?: number;
    perStepCapEth?: number;
    /** false (default) returns the team + cost; true creates the routed tasks. */
    execute?: boolean;
}
interface PlannedStep {
    capability: string;
    task: string;
    agentId: string | null;
    agentName?: string;
    price: string | null;
    costEth: number;
    reason: string | null;
}
interface PlanView {
    goal: string;
    budgetEth: number;
    steps: PlannedStep[];
    estCostEth: number;
    withinBudget: boolean;
    routedCount: number;
}
interface PlanResult {
    plan: PlanView;
    executed: boolean;
    execution?: {
        created: Array<{
            capability: string;
            agentId: string;
            taskId: string;
            costEth: number;
        }>;
        skipped: number;
    };
}
interface SubcontractOptions {
    to?: string;
    capability?: string;
    task: string;
    maxPrice?: string;
    context?: Record<string, unknown>;
}
interface SubcontractResult {
    subcontract: {
        childTaskId: string;
        parentTaskId: string;
        fromAgent: string;
        toAgent: string;
        price: string | null;
        createdAt: string;
    };
    task: TaskRequest | null;
}
interface OptimizeResult {
    optimization: {
        agentId: string;
        currentPrice: string | null;
        suggestedPrice: string | null;
        action: "raise" | "lower" | "hold";
        rationale: string;
        metrics: {
            completed: number;
            failed: number;
            successRate: number;
            recentVolume: number;
            load: number;
        };
    };
    applied: boolean;
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
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    /**
     * Set to "balance" to fund a paid hire from the `from` agent's earned balance
     * instead of a fresh on-chain transfer — no `pay` function needed. Requires an
     * authenticated client and a registered `from` agent that owns the balance.
     */
    paymentMethod?: "onchain" | "balance";
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
interface CommerceProfile {
    profileId: string;
    label: string;
    status: "active" | "frozen" | "deleted";
    createdAt?: string;
}
interface CreateProfileOptions {
    /** A name for this destination, e.g. "Home" or "Office". */
    label: string;
    contact: {
        name: string;
        email: string;
        phone?: string;
    };
    address: {
        line1: string;
        line2?: string;
        city: string;
        region?: string;
        postalCode: string;
        /** Two-letter ISO country code, e.g. "GB". */
        country: string;
    };
}
interface SpendMandate {
    mandateId: string;
    agentId: string;
    profileId: string;
    maxPerPurchase: number;
    maxPerPeriod: number;
    period: "day" | "week" | "month";
    currency: string;
    status: "active" | "revoked";
    spentThisPeriod?: number;
    autoApproveUnder?: number;
    allowedHosts?: string[];
    expiresAt?: string;
}
interface GrantMandateOptions {
    agentId: string;
    profileId: string;
    /** Ceiling for any single purchase. */
    maxPerPurchase: number;
    /** Ceiling for everything inside one period. */
    maxPerPeriod: number;
    period?: "day" | "week" | "month";
    currency?: string;
    /** Purchases under this are pre-cleared, so they still need your signature but
     *  not a second decision. 0 (the default) means every purchase is decided. */
    autoApproveUnder?: number;
    /** Restrict the agent to these business hosts. */
    allowedHosts?: string[];
    expiresAt?: string;
}
type PurchaseStatus = "proposed" | "approved" | "purchased" | "declined" | "expired" | "failed";
interface PurchaseIntent {
    intentId: string;
    agentId: string;
    businessHost: string;
    summary: string;
    amount: number;
    currency: string;
    /** The ceiling this purchase was authorised against. */
    maxAmount?: number;
    status: PurchaseStatus;
    preCleared?: boolean;
    orderId?: string;
    orderStatus?: string;
    signed?: boolean;
    expiresAt: string;
    createdAt: string;
    failure?: string;
}
interface SpendSummary {
    /** How many purchases have actually been paid for. */
    purchased: number;
    /** What those purchases came to, in `currency`. */
    totalSpent: number;
    /**
     * Purchases in flight — proposed *and* approved-but-not-yet-charged.
     *
     * Not the same set as `commerce.pending()`, which is only what is still
     * waiting on your decision. A purchase you approved a moment ago leaves
     * `pending()` and stays counted here until it settles.
     */
    pending: number;
    /** The currency these figures are in — read from the purchases, not assumed. */
    currency: string;
}
interface ListPurchasesOptions {
    status?: PurchaseStatus;
    limit?: number;
    /** Ask the businesses for fresh order status while listing. Off by default —
     *  it makes the call as slow as somebody else's store. */
    refresh?: boolean;
}
interface PurchasesView {
    intents: PurchaseIntent[];
    summary: SpendSummary;
}
/** What the owner is asked to sign, exactly as the server will verify it. */
interface ApprovalRequest {
    intentId: string;
    message: string;
    wallet: string;
    expiresAt: string;
}
/** The same authorisation, broken into fields you can check before signing. */
interface ParsedAuthorisation {
    intentId: string;
    business: string;
    itemsHash: string;
    amount: number;
    currency: string;
    ceiling: number;
    expiresAt: string;
}
/**
 * What you believe you are approving. Anything you state here is checked against
 * the server's own authorisation message *before* it is signed, so a purchase
 * that changed underneath you is refused rather than authorised.
 */
interface PurchaseExpectation {
    /** Refuse if the amount is above this. */
    maxAmount?: number;
    /** Refuse if the purchase is priced in another currency. */
    currency?: string;
    /** Refuse unless the business is this one (or one of these). */
    business?: string | string[];
}
/** Signs the authorisation message, returning a 0x-prefixed EIP-191 signature. */
type SignMandate = (message: string) => string | Promise<string>;
interface PaymentInstrument {
    id: string;
    handlerId: string;
    type: string;
    credential: Record<string, unknown>;
    billingAddress?: Record<string, unknown>;
}
interface PaymentHandlerDescriptor {
    namespace: string;
    id: string;
    version?: string;
    config?: Record<string, unknown>;
}
interface PaymentOptionsView {
    intentId: string;
    businessHost: string;
    status: string;
    readyToComplete: boolean;
    total: number;
    currency: string;
    approvedCeiling: number;
    paymentHandlers: PaymentHandlerDescriptor[];
    messages?: unknown;
}
interface ApproveOptions {
    /** How to sign. Given a signer, the SDK fetches the canonical message, checks
     *  it against `expect`, and signs it — you never construct the message. */
    sign?: SignMandate;
    /** A signature you produced yourself, base64. Mutually exclusive with `sign`. */
    signature?: string;
    /** Checked against the real authorisation before anything is signed. */
    expect?: PurchaseExpectation;
    /** The credential from one of the business's payment handlers. Without it the
     *  approval is recorded and the purchase waits — nothing is charged. */
    paymentInstrument?: PaymentInstrument;
}
interface ApproveResult extends PurchaseIntent {
    /** Set when the purchase completed. */
    orderId?: string;
    settledAmount?: number;
    /** True when the approval is signed and recorded but no payment credential was
     *  supplied, so the charge has not been attempted. */
    awaitingPayment?: boolean;
    /** What the authorisation actually said, as signed. */
    authorisation?: ParsedAuthorisation;
}
interface WatchPurchasesOptions {
    /** Called once per purchase the agent proposes. */
    onProposed: (intent: PurchaseIntent) => void | Promise<void>;
    /** How often to look. Default 15 000 ms. */
    intervalMs?: number;
    /** Called when a poll fails, instead of throwing into the interval. */
    onError?: (err: unknown) => void;
    /**
     * Whether the watcher should keep the process alive. Default true — a script
     * that only watches would otherwise exit immediately. Set false when
     * something else owns the lifecycle and this shouldn't be what holds it open.
     */
    keepAlive?: boolean;
}
interface WatchHandle {
    /** Stop watching. Safe to call more than once. */
    stop(): void;
}
/**
 * A standing rule for approving purchases without a human in the loop. Every
 * bound is required: an auto-approver with an open bound is a blank cheque, so
 * the SDK will not construct one.
 */
interface AutoApprovePolicy {
    /** Never approve more than this, per purchase. */
    maxAmount: number;
    /** Only these business hosts. */
    allowedHosts: string[];
    /** Only this currency. */
    currency: string;
    /** How to sign an approval. */
    sign: SignMandate;
    /** Produce the payment credential for a purchase that passed the policy. */
    paymentInstrument?: (intent: PurchaseIntent, options: PaymentOptionsView) => PaymentInstrument | Promise<PaymentInstrument | undefined> | undefined;
    /** Called for each approved purchase. */
    onApproved?: (result: ApproveResult) => void | Promise<void>;
    /** Called for each purchase the policy refused, with the reason. */
    onSkipped?: (intent: PurchaseIntent, reason: string) => void | Promise<void>;
    onError?: (err: unknown) => void;
    intervalMs?: number;
}

export type { SubcontractOptions as $, ApprovalRequest as A, AgentMetrics as B, CreateProfileOptions as C, DelegateOptions as D, Receipt as E, FindAgentsOptions as F, GrantMandateOptions as G, HireOptions as H, HireResult as I, RunOptions as J, RunResult as K, ListPurchasesOptions as L, AxonToolsOptions as M, AxonTool as N, RouteHireOptions as O, PurchasesView as P, QuorumTask as Q, RegisterOptions as R, SignMandate as S, TaskRequest as T, UpdateAgentOptions as U, VerifyOptions as V, WatchPurchasesOptions as W, X402PayFunction as X, RoutingInfo as Y, PlanOptions as Z, PlanResult as _, CommerceProfile as a, ExplorerTask as a$, SubcontractResult as a0, OptimizeResult as a1, PaymentNote as a2, GetTaskHistoryOptions as a3, RegisterGatewayProviderOptions as a4, GatewayProvider as a5, GatewayCallOptions as a6, GatewayCallResult as a7, X402Currency as a8, RegisterWebhookOptions as a9, McpServer as aA, McpToolRecord as aB, CallMcpToolOptions as aC, StartMissionOptions as aD, Mission as aE, OpenChannelOptions as aF, OpenChannelResult as aG, PaymentChannel as aH, ReproductionProof as aI, WorkerMetrics as aJ, X402PaymentOption as aK, AgentRuntimeOptions as aL, AxonAgent as aM, AbuseReason as aN, AbuseStatus as aO, AgentContext as aP, AgentRating as aQ, AgentRunHandler as aR, ApiErrorBody as aS, ApiErrorCode as aT, BidStatus as aU, ComponentStatus as aV, DefineSplitsOptions as aW, DelegationResult as aX, DelegationStep as aY, EndpointUptime as aZ, ExplorerSettlement as a_, Webhook as aa, WebhookDelivery as ab, CreateOpenTaskOptions as ac, OpenTask as ad, ListOpenTasksOptions as ae, Bid as af, SplitRecipient as ag, TaskSplitsView as ah, CreateWorkflowTemplateOptions as ai, WorkflowTemplate as aj, InstantiateTemplateOptions as ak, AttestCapabilityOptions as al, CapabilityAttestation as am, DefineSlaOptions as an, TaskSla as ao, FileAbuseReportOptions as ap, AbuseReport as aq, FeePolicy as ar, ProtocolInfo as as, ProtocolNegotiation as at, ExplorerFeed as au, SystemStatus as av, SubmitBidOptions as aw, AcceptBidOptions as ax, X402Requirements as ay, RegisterMcpServerOptions as az, SpendMandate as b, FeeTier as b0, MissionStatus as b1, OpenTaskStatus as b2, PaymentHandlerDescriptor as b3, PaymentInstrument as b4, PaymentNoteKind as b5, PaymentStatus as b6, PlanView as b7, PlannedStep as b8, PurchaseStatus as b9, QuorumStatus as ba, ReceiptDelivery as bb, Review as bc, SlaStatus as bd, SpendSummary as be, SplitPayout as bf, TaskSplit as bg, TaskStatus as bh, WebhookEventType as bi, WorkflowStep as bj, PurchaseIntent as c, PaymentOptionsView as d, ApproveOptions as e, ApproveResult as f, WatchHandle as g, AutoApprovePolicy as h, ParsedAuthorisation as i, PurchaseExpectation as j, AxonConfig as k, AuthChallenge as l, AuthVerifyResult as m, Agent as n, CapabilitySummary as o, SendTaskOptions as p, TaskProgress as q, TaskHandler as r, TaskResult as s, CreateQuorumOptions as t, QuorumResult as u, Workflow as v, GetTransactionsOptions as w, Transaction as x, AgentBalance as y, Reputation as z };
