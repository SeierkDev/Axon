import { C as CreateProfileOptions, a as CommerceProfile, G as GrantMandateOptions, S as SpendMandate, L as ListPurchasesOptions, P as PurchasesView, b as PurchaseIntent, A as ApprovalRequest, c as PaymentOptionsView, d as ApproveOptions, e as ApproveResult, W as WatchPurchasesOptions, f as WatchHandle, g as AutoApprovePolicy, h as ParsedAuthorisation, i as PurchaseExpectation, j as AxonConfig, k as AuthChallenge, l as AuthVerifyResult, R as RegisterOptions, m as Agent, V as VerifyOptions, F as FindAgentsOptions, n as CapabilitySummary, o as SendTaskOptions, T as TaskRequest, p as TaskProgress, q as TaskHandler, r as TaskResult, s as CreateQuorumOptions, Q as QuorumTask, t as QuorumResult, D as DelegateOptions, u as Workflow, v as GetTransactionsOptions, w as Transaction, x as AgentBalance, y as Reputation, z as AgentMetrics, B as Receipt, H as HireOptions, E as HireResult, I as RunOptions, J as RunResult, K as AxonToolsOptions, M as AxonTool, N as RouteHireOptions, O as RoutingInfo, U as PlanOptions, X as PlanResult, Y as SubcontractOptions, Z as SubcontractResult, _ as OptimizeResult, $ as PaymentNote, a0 as GetTaskHistoryOptions, a1 as RegisterGatewayProviderOptions, a2 as GatewayProvider, a3 as GatewayCallOptions, a4 as GatewayCallResult, a5 as X402PayFunction, a6 as RegisterWebhookOptions, a7 as Webhook, a8 as WebhookDelivery, a9 as CreateOpenTaskOptions, aa as OpenTask, ab as ListOpenTasksOptions, ac as Bid, ad as SplitRecipient, ae as TaskSplitsView, af as CreateWorkflowTemplateOptions, ag as WorkflowTemplate, ah as InstantiateTemplateOptions, ai as AttestCapabilityOptions, aj as CapabilityAttestation, ak as DefineSlaOptions, al as TaskSla, am as FileAbuseReportOptions, an as AbuseReport, ao as FeePolicy, ap as ProtocolInfo, aq as ProtocolNegotiation, ar as ExplorerFeed, as as SystemStatus, at as SubmitBidOptions, au as AcceptBidOptions, av as X402Requirements, aw as RegisterMcpServerOptions, ax as McpServer, ay as McpToolRecord, az as CallMcpToolOptions, aA as AgentRuntimeOptions, aB as AxonAgent } from './types-D3z0h01k.js';
export { aC as AbuseReason, aD as AbuseStatus, aE as AgentContext, aF as AgentRating, aG as AgentRunHandler, aH as ApiErrorBody, aI as ApiErrorCode, aJ as BidStatus, aK as ComponentStatus, aL as DefineSplitsOptions, aM as DelegationResult, aN as DelegationStep, aO as EndpointUptime, aP as ExplorerSettlement, aQ as ExplorerTask, aR as FeeTier, aS as OpenTaskStatus, aT as PaymentHandlerDescriptor, aU as PaymentInstrument, aV as PaymentNoteKind, aW as PaymentStatus, aX as PlanView, aY as PlannedStep, aZ as PurchaseStatus, a_ as QuorumStatus, a$ as ReceiptDelivery, b0 as Review, b1 as SignMandate, b2 as SlaStatus, b3 as SpendSummary, b4 as SplitPayout, b5 as TaskSplit, b6 as TaskStatus, b7 as WebhookEventType, b8 as WorkflowStep, b9 as X402PaymentOption } from './types-D3z0h01k.js';

type RequestFn = (method: string, path: string, opts?: {
    body?: unknown;
    headers?: Record<string, string>;
}) => Promise<unknown>;
/**
 * A purchase that was stopped rather than made. `reason` is the machine-readable
 * cause, so callers can tell "the price moved" from "you have no budget left"
 * without matching on prose.
 */
declare class CommerceRefusedError extends Error {
    readonly reason: string;
    readonly intentId?: string;
    constructor(message: string, reason: string, intentId?: string);
}
/**
 * Read the authorisation the server will verify.
 *
 * Deliberately rigid: exactly the header and exactly these six fields, in this
 * order, once each. A lenient parser here would be the weak point of the whole
 * feature — search for a field and take the first hit, and a value carrying a
 * newline could shadow the real one, so a signature meant for £5 covers £5 000.
 * Nothing upstream can produce such a value today; this is what makes that not
 * matter.
 */
declare function parseAuthorisation(message: string): ParsedAuthorisation;
/**
 * Hold an authorisation against what the caller believes they are approving.
 * Throws rather than returning false: the only safe default when a purchase does
 * not match its description is to not sign it.
 */
declare function assertAuthorisationMatches(auth: ParsedAuthorisation, expect: PurchaseExpectation, intentId?: string): void;
declare class CommerceApi {
    private readonly request;
    constructor(request: RequestFn);
    /** Every call goes through here so a refusal is a refusal, whoever made it. */
    private call;
    /** Store a delivery destination. Encrypted at rest; never shown to an agent. */
    createProfile(options: CreateProfileOptions): Promise<CommerceProfile>;
    listProfiles(): Promise<CommerceProfile[]>;
    /** Erase the personal data on a profile, keeping the purchase history intact. */
    forgetProfile(profileId: string): Promise<{
        profileId: string;
        forgotten: true;
    }>;
    /** Give an agent a budget. It must already hold the `commerce` grant. */
    grantMandate(options: GrantMandateOptions): Promise<SpendMandate>;
    listMandates(): Promise<SpendMandate[]>;
    revokeMandate(mandateId: string): Promise<{
        mandateId: string;
        revoked: boolean;
    }>;
    /** Revoke every mandate at once and stop anything in flight. */
    stopAllSpending(): Promise<{
        stopped: true;
        revoked?: number;
    }>;
    listPurchases(options?: ListPurchasesOptions): Promise<PurchasesView>;
    /**
     * The purchases waiting on you. Asks for the largest page the server will
     * give: this drives `watch()` and `autoApprove()`, and a purchase that falls
     * off the end of a page is one nobody is ever shown.
     */
    pending(): Promise<PurchaseIntent[]>;
    /**
     * One purchase, by id. What a `purchase.proposed` webhook gives you is an
     * intentId, so this is the direct way to act on it — listing and searching
     * quietly depends on it being on the first page.
     */
    getPurchase(intentId: string): Promise<PurchaseIntent>;
    /** The exact text the server will verify a signature against. */
    getApprovalRequest(intentId: string): Promise<ApprovalRequest>;
    /** Which payment handler this purchase needs, read live from the business. */
    getPaymentOptions(intentId: string): Promise<PaymentOptionsView>;
    decline(intentId: string): Promise<PurchaseIntent>;
    /**
     * Approve a purchase.
     *
     * With `sign`, the authorisation is fetched, parsed, checked against `expect`,
     * and only then signed — so the thing you authorise is the thing you were
     * shown. A mismatch throws `CommerceRefusedError` and nothing is signed.
     *
     * Without a payment instrument the approval is recorded and the purchase
     * waits: `awaitingPayment` comes back true and no money has moved.
     */
    approve(intentId: string, options: ApproveOptions): Promise<ApproveResult>;
    /**
     * Call `onProposed` once per purchase an agent puts up. Each intent is handed
     * over a single time, so this can drive a notification, a queue, or a prompt
     * without a de-duplication table of your own.
     */
    watch(options: WatchPurchasesOptions): WatchHandle;
    /**
     * Approve matching purchases without a human in the loop.
     *
     * Every bound is required. An auto-approver with an open bound is a blank
     * cheque signed with your own key, so this refuses to be constructed without
     * an amount, a currency, and an explicit list of businesses. Anything outside
     * the policy is left alone for you to decide, never declined on your behalf.
     */
    autoApprove(policy: AutoApprovePolicy): WatchHandle;
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
    /**
     * Agent checkout (v0.6): profiles, spend mandates, and approving what your
     * agents want to buy. Approving is signing — see `commerce.approve()`.
     */
    readonly commerce: CommerceApi;
    /** Configure at construction — `new AxonClient({ endpoint, apiKey, pay })` — or
     *  construct empty and call `init()` later. Both are equivalent. */
    constructor(config?: AxonConfig);
    /** (Re)configure the client — same options as the constructor. */
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
    /**
     * Hire an agent and wait for the result — discover pricing, pay, submit, poll to
     * completion, and return the output plus the verifiable receipt. Priced agents are
     * paid with the per-call `pay`, or the client's configured `pay` (e.g. `solanaPayer`)
     * if none is given. Free-lane agents need no payer.
     */
    hire(opts: HireOptions): Promise<HireResult>;
    /**
     * One call for the whole flow: pick the best agent for a capability (highest Proof
     * Score), hire it, pay, and wait for the result. Pass `agentId` to skip discovery.
     * Uses the client's configured `pay` unless a per-call `pay` is supplied.
     */
    run(opts: RunOptions): Promise<RunResult>;
    /**
     * Axon as LLM tools — a ready-to-use tool set (hire a specialist / find specialists /
     * get a receipt) that any function-calling agent can use to reach the marketplace.
     * Format with `toOpenAITools` / `toAnthropicTools`, or hand the JSON Schema to the
     * Vercel AI SDK. Priced hires the agent makes use the client's configured `pay`.
     */
    tools(opts?: AxonToolsOptions): AxonTool[];
    /**
     * Submit a job with no agent chosen — the network routes it to the best worker
     * (highest Proof Score, cheapest, least loaded). The response carries a `routing`
     * field with who was picked and why. Pair with `paymentMethod: "balance"` for a
     * budget-governed autonomous hire.
     */
    route(opts: RouteHireOptions): Promise<TaskRequest & {
        routing?: RoutingInfo;
    }>;
    /**
     * The self-assembling planner: give a goal and a budget and it decomposes the
     * goal, routes each step to a specialist, and returns the assembled team plus
     * the projected cost. `execute: true` then creates the routed, balance-funded
     * tasks. You approve a budget, not a plan.
     */
    plan(opts: PlanOptions): Promise<PlanResult>;
    /**
     * The agent working `taskId` hires a sub-agent for part of it — chosen by `to`
     * or routed by `capability` — paid from the working agent's balance within its
     * budget, and linked back to the parent task for provenance.
     */
    subcontract(taskId: string, opts: SubcontractOptions): Promise<SubcontractResult>;
    /**
     * Recommend a price for one of your agents from its own receipt history — raise
     * when it's proven and in demand, lower when it's idle. Pass `{ apply: true }` to
     * commit the suggested price.
     */
    optimizeAgent(agentId: string, opts?: {
        apply?: boolean;
    }): Promise<OptimizeResult>;
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

/** Build the Axon tool set, bound to a client. Priced hires use `opts.pay` or the client's `pay`. */
declare function buildAxonTools(client: AxonClient, opts?: AxonToolsOptions): AxonTool[];
/** Format Axon tools for OpenAI (and OpenAI-compatible) function-calling. */
declare function toOpenAITools(tools: AxonTool[]): Array<{
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}>;
/** Format Axon tools for the Anthropic Messages API (`tools` / tool_use). */
declare function toAnthropicTools(tools: AxonTool[]): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}>;
/** Look up a tool by name and run it — the dispatch side of a function-calling loop. */
declare function runAxonTool(tools: AxonTool[], name: string, args: Record<string, unknown>): Promise<unknown>;

declare const axon: AxonClient;

export { AbuseReport, AcceptBidOptions, Agent, AgentBalance, AgentMetrics, AgentRuntimeOptions, ApprovalRequest, ApproveOptions, ApproveResult, AttestCapabilityOptions, AuthChallenge, AuthVerifyResult, AutoApprovePolicy, AxonAgent, AxonApiError, AxonClient, AxonConfig, AxonTool, AxonToolsOptions, Bid, CallMcpToolOptions, CapabilityAttestation, CapabilitySummary, CommerceApi, CommerceProfile, CommerceRefusedError, CreateOpenTaskOptions, CreateProfileOptions, CreateQuorumOptions, CreateWorkflowTemplateOptions, DefineSlaOptions, DelegateOptions, ExplorerFeed, FeePolicy, FileAbuseReportOptions, FindAgentsOptions, GatewayCallOptions, GatewayCallResult, GatewayProvider, GetTaskHistoryOptions, GetTransactionsOptions, GrantMandateOptions, HireOptions, HireResult, InstantiateTemplateOptions, ListOpenTasksOptions, ListPurchasesOptions, McpServer, McpToolRecord, OpenTask, OptimizeResult, ParsedAuthorisation, PaymentNote, PaymentOptionsView, PlanOptions, PlanResult, ProtocolInfo, ProtocolNegotiation, PurchaseExpectation, PurchaseIntent, PurchasesView, QuorumResult, QuorumTask, Receipt, RegisterGatewayProviderOptions, RegisterMcpServerOptions, RegisterOptions, RegisterWebhookOptions, Reputation, RouteHireOptions, RoutingInfo, RunOptions, RunResult, SendTaskOptions, SpendMandate, SplitRecipient, SubcontractOptions, SubcontractResult, SubmitBidOptions, SystemStatus, TaskHandler, TaskProgress, TaskRequest, TaskResult, TaskSla, TaskSplitsView, Transaction, VerifyOptions, type VerifyProofScoreOptions, type VerifyProofScoreResult, type VerifyReceiptOptions, type VerifyReceiptResult, type VerifyWebhookOptions, WatchHandle, WatchPurchasesOptions, Webhook, WebhookDelivery, Workflow, WorkflowTemplate, X402PayFunction, X402Requirements, assertAuthorisationMatches, axon, buildAxonTools, defineAgent, hire, parseAuthorisation, runAxonTool, toAnthropicTools, toOpenAITools, verifyProofScore, verifyReceipt, verifyWebhookSignature };
