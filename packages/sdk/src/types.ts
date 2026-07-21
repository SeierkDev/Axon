// ─── Agent ────────────────────────────────────────────────────────────────────

export type InferenceProvider = "anthropic" | "ollama" | "openai" | "grok";
export type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable" | "platform" | "modulr";

export interface Agent {
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
  providerModel?: string;   // null = use provider default
  providerEndpoint?: string; // required for ollama, unsupported for openai/grok
  verificationStatus?: VerificationStatus;
  lastVerifiedAt?: string;
  ownerVerified?: boolean; // owner wallet has cryptographically authenticated (verified-owner badge)
  agencListed?: boolean; // cross-listed on the AgenC marketplace protocol (✓ AgenC badge)
  proofScore?: number; // 0-1000 portable Proof Score (directory badge; see /api/agents/<id>/proof-score)
  proofScoreTier?: string;
  createdAt: string;
}

export interface RegisterOptions {
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

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface FindAgentsOptions {
  capability?: string;
  capabilities?: string[];
  minReputation?: number;
  maxPrice?: string;
  sort?: "reputation" | "price" | "createdAt";
  limit?: number;
}

export interface CapabilitySummary {
  name: string;
  agentCount: number;
}

export interface VerifyOptions {
  agentId: string;
  sign: (challenge: string) => Promise<string>;
}

export interface AuthChallenge {
  walletAddress: string;
  challenge: string;
  expiresInSeconds: number;
  instruction: string;
}

export interface AuthVerifyResult {
  walletAddress: string;
  apiKey: string;
  keyId: string;
  keyPrefix: string;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface AgentMetrics {
  agentId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  windowDays: number;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

export type TaskStatus = "payment_pending" | "queued" | "running" | "completed" | "failed";

export interface TaskRequest {
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

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  completedAt: string;
  error?: string;
}

export interface SendTaskOptions {
  from: string;
  to: string;
  task: string;
  context?: Record<string, unknown>;
  payment?: string;
  paymentSignature?: string;
  /**
   * How a paid hire is funded: "onchain" (default — a fresh USDC transfer proven
   * by paymentSignature) or "balance" (spend the `from` agent's earned balance,
   * no new transfer). "balance" requires an authenticated, registered `from`.
   */
  paymentMethod?: "onchain" | "balance";
  signature?: string;
  idempotencyKey?: string;
}

export interface GetTaskHistoryOptions {
  agentId: string;
  role?: "sender" | "recipient" | "both";
  status?: TaskStatus;
  limit?: number;
}

export type TaskHandler = (
  task: TaskRequest
) => Promise<{ success: boolean; output: string }>;

// ─── Delegation ───────────────────────────────────────────────────────────────

export interface DelegateOptions {
  from: string;
  agents: string[];
  task: string;
}

export interface WorkflowStep {
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

export interface Workflow {
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

export interface DelegationStep {
  agentId: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface DelegationResult {
  success: boolean;
  steps: DelegationStep[];
  finalOutput: string;
}

// ─── Quorum Tasks ─────────────────────────────────────────────────────────────

export type QuorumStatus = "pending" | "completed" | "failed";

export interface QuorumTask {
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

export interface QuorumResult {
  taskId: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: string;
  completedAt?: string;
}

export interface CreateQuorumOptions {
  from: string;
  agents: string[];
  task: string;
  threshold: number;
  context?: Record<string, unknown>;
}

// Progress event emitted while a task is running (streamed to the payer).
export interface TaskProgress {
  id: number;
  taskId: string;
  sequence: number;
  message: string;
  emittedAt: string;
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export type PaymentStatus = "escrow" | "completed" | "refunded" | "split";

export interface Transaction {
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

export interface AgentBalance {
  agentId: string;
  totalEarned: number;
  totalSpent: number;
  totalEscrow: number;
  netBalance: number;
  tasksPaid: number;
}

export interface GetTransactionsOptions {
  agentId: string;
  limit?: number;
}

export interface ReceiptDelivery {
  deliveryId: string;
  webhookId: string;
  eventType: WebhookEventType;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus?: number;
  lastAttemptAt?: string;
}

export type PaymentNoteKind = "dispute" | "refund" | "note";

export interface PaymentNote {
  id: number;
  taskId: string;
  kind: PaymentNoteKind;
  note: string;
  author: string | null; // wallet that attached it; null = system-generated
  createdAt: string;
}

export interface Receipt {
  taskId: string;
  task: TaskRequest | null;
  payment: Transaction | null;
  webhookDeliveries: ReceiptDelivery[];
  notes?: PaymentNote[]; // dispute/refund notes attached to this payment
}

// ─── Reputation ───────────────────────────────────────────────────────────────

export interface Reputation {
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

// ─── Marketplace ──────────────────────────────────────────────────────────────

export interface Review {
  reviewId: string;
  agentId: string;
  reviewerId: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

export interface AgentRating {
  avgRating: number;
  count: number;
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

export interface McpServer {
  serverId: string;
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall: string;
  status: "active" | "inactive" | "error";
  createdAt: string;
}

export interface McpToolRecord {
  toolId: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  lastSynced: string;
}

export interface RegisterMcpServerOptions {
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall?: string;
}

export interface CallMcpToolOptions {
  toolId: string;
  args?: Record<string, unknown>;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

// Recorded endpoint reliability over a trailing window. lastCheckedAt/lastStatus
// are present on the single-provider GET and omitted from the (batched) list.
export interface EndpointUptime {
  checks: number;
  up: number;
  uptime: number; // 0..1
  lastCheckedAt?: string | null;
  lastStatus?: "up" | "down" | null;
}

export interface GatewayProvider {
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
  uptime?: EndpointUptime; // omitted at registration, present on GET responses
}

export interface RegisterGatewayProviderOptions {
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

export interface GatewayCallOptions {
  providerId: string;
  body?: Record<string, unknown>;
  from?: string;
  paymentSignature?: string;
}

export interface GatewayCallResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  taskId: string;
  durationMs: number;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | "task.queued"
  | "task.completed"
  | "task.failed"
  | "payment.settled"
  | "payment.refunded"
  | "spend.threshold_exceeded"
  | "bid.received"
  | "bid.accepted";

export interface Webhook {
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

export interface WebhookDelivery {
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

export interface RegisterWebhookOptions {
  agentId: string;
  url: string;
  events?: WebhookEventType[];
}

// ─── x402 ─────────────────────────────────────────────────────────────────────

export interface X402PaymentOption {
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

export interface X402Requirements {
  version: "x402/1";
  accepts: X402PaymentOption[];
}

export type X402PayFunction = (
  requirements: X402Requirements
) => Promise<{ signature: string; from: string }>;

// ─── Config ───────────────────────────────────────────────────────────────────

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "INVALID_JSON"
  | "NOT_FOUND"
  | "PAYMENT_FAILED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TASK_STATE_CONFLICT"
  | "VALIDATION_ERROR";

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode | string;
  details?: Record<string, unknown>;
}

export interface AxonConfig {
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

// ─── Bidding (Phase 8) ────────────────────────────────────────────────────────

export type OpenTaskStatus = "open" | "accepted" | "cancelled";
export type BidStatus = "pending" | "accepted" | "rejected";

export interface OpenTask {
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

export interface Bid {
  bidId: string;
  openTaskId: string;
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
  status: BidStatus;
  createdAt: string;
}

export interface CreateOpenTaskOptions {
  from: string;
  task: string;
  capabilities: string[];
  maxBudget?: string;
  deadline?: string;
}

export interface ListOpenTasksOptions {
  status?: OpenTaskStatus;
  capability?: string;
  from?: string;
  limit?: number;
}

export interface SubmitBidOptions {
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
}

export interface AcceptBidOptions {
  bidId: string;
  paymentSignature?: string;
}

// ─── Escrow splits (Phase 8) ──────────────────────────────────────────────────

export interface SplitRecipient {
  agentId: string;
  /** Share in basis points (1..10000); a task's recipients sum to 10000. */
  shareBps: number;
}

export interface TaskSplit extends SplitRecipient {
  splitId: string;
  taskId: string;
  createdAt: string;
}

export interface SplitPayout {
  agentId: string;
  amount: number;
  currency: string;
}

export interface TaskSplitsView {
  taskId: string;
  splits: TaskSplit[];
  /** Projected per-recipient amounts, present once the task has a payment. */
  payouts: SplitPayout[];
}

export interface DefineSplitsOptions {
  recipients: SplitRecipient[];
}

// ─── Workflow templates (Phase 8) ─────────────────────────────────────────────

export interface WorkflowTemplate {
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

export interface CreateWorkflowTemplateOptions {
  from: string;
  name: string;
  description?: string;
  agents: string[];
  taskTemplate: string;
}

export interface InstantiateTemplateOptions {
  from: string;
  params?: Record<string, string>;
}

// ─── Capability attestations (Phase 8) ────────────────────────────────────────

export interface CapabilityAttestation {
  attestationId: string;
  agentId: string;
  capability: string;
  /** Wallet address of the verifier that signed the attestation. */
  verifier: string;
  createdAt: string;
}

export interface AttestCapabilityOptions {
  capability: string;
  /** Verifier wallet address (the signer). */
  verifier: string;
  /** Base64 signature over attestationMessage(agentId, capability). */
  signature: string;
}

// ─── Task SLAs (Phase 8) ──────────────────────────────────────────────────────

export type SlaStatus = "active" | "met" | "breached";

export interface TaskSla {
  slaId: string;
  taskId: string;
  deadlineAt: string;
  /** Basis points of the payment the provider forfeits on breach (1..10000). */
  penaltyBps: number;
  status: SlaStatus;
  resolvedAt?: string;
  createdAt: string;
}

export interface DefineSlaOptions {
  /** Seconds from now by which the task must complete. */
  deadlineSeconds: number;
  /** Basis points of the payment forfeited if the deadline is breached (1..10000). */
  penaltyBps: number;
}

// ─── Abuse reporting & fee policy (Phase 9) ───────────────────────────────────

export type AbuseReason = "spam" | "scam" | "non_delivery" | "abuse" | "other";
export type AbuseStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface AbuseReport {
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

export interface FileAbuseReportOptions {
  targetAgent: string;
  reason: AbuseReason;
  details?: string;
}

export interface FeeTier {
  platformFeeBps: number;
  note: string;
}

export interface FeePolicy {
  version: string;
  effectiveDate: string;
  currency: string;
  rails: string[];
  peerToPeer: FeeTier;
  hostedAgents: FeeTier;
  notes: string[];
}

// ─── Protocol negotiation (Phase 9) ───────────────────────────────────────────

export interface ProtocolInfo {
  version: string;
  minVersion: string;
  supported: string[];
  capabilities: string[];
}

export interface ProtocolNegotiation {
  version: string;
  capabilities: string[];
}

// ─── Network explorer (Phase 9) ───────────────────────────────────────────────

export interface ExplorerTask {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

export interface ExplorerSettlement {
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

export interface ExplorerFeed {
  totals: { agents: number; tasksCompleted: number; usdcTransacted: number; successRate: number };
  recentTasks: ExplorerTask[];
  recentSettlements: ExplorerSettlement[];
}

// ─── Status (Phase 9) ─────────────────────────────────────────────────────────

export type ComponentStatus = "operational" | "degraded" | "down";

export interface SystemStatus {
  status: ComponentStatus;
  components: { name: string; status: ComponentStatus; detail?: string }[];
  metrics: {
    queueDepth: number;
    runningTasks: number;
    tasksCompleted: number;
    successRate: number;
    workerLastSeenAgeSeconds: number | null;
  };
  updatedAt: string;
}

// ─── Agent runtime (v0.3) ─────────────────────────────────────────────────────
// The batteries-included worker: register once, then poll → run → settle in a
// loop. Turns the low-level task primitives into a live, earning agent.

export interface AgentContext {
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
export type AgentRunHandler = (
  ctx: AgentContext
) => Promise<string | { output: string; success?: boolean }>;

export interface AgentRuntimeOptions extends RegisterOptions {
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

export interface AxonAgent {
  readonly agentId: string;
  /** Register (if needed) and begin polling. Returns once the loop is running. */
  start(): Promise<void>;
  /** Stop polling and wait for in-flight tasks to finish settling. */
  stop(): Promise<void>;
  /** True while the run loop is active. */
  readonly running: boolean;
}

// ─── One-shot hire (v0.3) ─────────────────────────────────────────────────────
// Discover → (pay, if the agent is priced) → submit → poll to completion →
// receipt, in a single call. The demand-side mirror of the runtime.

export interface HireOptions {
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

export interface HireResult {
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

// Receipt / trace verification (v0.3) lives in ./verify alongside the other
// verify primitives — see VerifyReceiptOptions / VerifyReceiptResult there.
