import { z } from "zod";
import { apiError } from "./apiError";

// ── Shared primitives ─────────────────────────────────────────────────────────

export const agentIdField = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/, "must be 1–80 chars (letters, numbers, hyphens, underscores)");

export const solanaAddressField = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a valid Solana base58 address");

export const positiveUsdcField = z
  .number()
  .positive("must be a positive number");

// ── Request body schemas ──────────────────────────────────────────────────────

export const registerAgentSchema = z.object({
  agentId: agentIdField,
  name: z.string().min(1, "name is required").max(120, "name must be 120 characters or fewer"),
  capabilities: z
    .array(z.string().min(1))
    .min(1, "at least one capability is required")
    .max(20, "capabilities must contain 20 or fewer items"),
  publicKey: z.string().min(1, "publicKey is required"),
  walletAddress: solanaAddressField,
  endpoint: z.string().url("endpoint must be a valid URL").optional(),
  price: z.string().optional(),
  category: z.string().max(60).optional(),
  provider: z.enum(["anthropic", "ollama", "openai"]).optional(),
  providerModel: z.string().max(80).optional(),
  providerEndpoint: z.string().url("providerEndpoint must be a valid URL").optional(),
});

export const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    price: z.string().nullable().optional(),
    endpoint: z.string().url("endpoint must be a valid URL").nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, "At least one field must be provided");

export const createTaskSchema = z.object({
  from: z.string().min(1, "from is required"),
  to: z.string().min(1, "to is required"),
  task: z
    .string()
    .min(1, "task is required")
    .max(32_000, "task must be 32 000 characters or fewer"),
  context: z.record(z.string(), z.unknown())
    .refine((obj) => JSON.stringify(obj).length <= 50_000, "context must serialize to 50 KB or fewer")
    .optional(),
  payment: z.string().optional(),
  paymentSignature: z.string().optional(),
  signature: z.string().optional(),
});

// ── Bidding (Phase 8) ───────────────────────────────────────────────────────

export const createOpenTaskSchema = z.object({
  from: z.string().min(1, "from is required"),
  task: z.string().min(1, "task is required").max(32_000, "task must be 32 000 characters or fewer"),
  capabilities: z.array(z.string().min(1)).min(1, "at least one capability is required").max(20),
  // Must be a real amount — a malformed budget (e.g. "0.10" with no currency)
  // would otherwise silently disable budget enforcement on bids.
  maxBudget: z.string().regex(/^\d+(\.\d+)?\s+(USDC|SOL)$/i, 'maxBudget must be an amount like "0.10 USDC"').optional(),
  deadline: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "deadline must be a valid date/time (ISO 8601)").optional(),
});

export const submitBidSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  price: z.string().min(1, "price is required"),
  etaSeconds: z.number().int().positive().max(86_400).optional(),
  message: z.string().max(1_000).optional(),
});

export const acceptBidSchema = z.object({
  bidId: z.string().min(1, "bidId is required"),
  paymentSignature: z.string().optional(),
});

export const defineSplitsSchema = z.object({
  recipients: z
    .array(
      z.object({
        agentId: z.string().min(1, "agentId is required"),
        shareBps: z
          .number()
          .int("shareBps must be a whole number of basis points")
          .min(1, "shareBps must be at least 1")
          .max(10_000, "shareBps must be at most 10000"),
      })
    )
    .min(2, "a split needs at least two recipients")
    .max(20, "a split supports at most 20 recipients"),
});

export const createWorkflowTemplateSchema = z.object({
  from: z.string().min(1, "from is required"),
  name: z.string().min(1, "name is required").max(120, "name must be 120 characters or fewer"),
  description: z.string().max(1000, "description must be 1 000 characters or fewer").optional(),
  agents: z
    .array(z.string().min(1))
    .min(1, "at least one agent is required")
    .max(20, "a chain supports at most 20 agents"),
  taskTemplate: z
    .string()
    .min(1, "taskTemplate is required")
    .max(32_000, "taskTemplate must be 32 000 characters or fewer"),
});

export const instantiateTemplateSchema = z.object({
  from: z.string().min(1, "from is required"),
  params: z.record(z.string(), z.string()).optional(),
});

export const createWebhookSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  url: z.string().url("url must be a valid URL"),
  events: z.array(z.string()).optional(),
});

export const createBudgetSchema = z.object({
  name: z.string().max(120).optional(),
  maxPerCallUsdc: positiveUsdcField.optional(),
  maxPerDayUsdc: positiveUsdcField.optional(),
  allowedToAgents: z.array(agentIdField).optional(),
});

export const createReviewSchema = z.object({
  reviewerId: z.string().min(1).optional(),
  rating: z
    .number()
    .int("rating must be a whole number")
    .min(1, "rating must be at least 1")
    .max(5, "rating must be at most 5"),
  comment: z.string().max(2000, "comment must be 2 000 characters or fewer").optional(),
});

export const createGatewaySchema = z.object({
  name: z.string().min(1, "name is required").max(120),
  endpoint: z.string().url("endpoint must be a valid URL"),
  ownerAgentId: z.string().min(1, "ownerAgentId is required"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  forwardHeaders: z.array(z.string()).optional(),
  injectHeaders: z
    .record(z.string(), z.string())
    .refine((obj) => JSON.stringify(obj).length <= 4096, "injectHeaders must serialize to 4 KB or fewer")
    .optional(),
  pricePerCall: z.string().optional(),
  description: z.string().max(1000).optional(),
  timeoutMs: z.number().positive().max(60_000).optional(),
});

// ── parseBody helper ──────────────────────────────────────────────────────────
// Returns either the parsed + typed data, or a ready-to-return 400 response.

type ParseOk<T> = { ok: true; data: T };
type ParseFail = { ok: false; response: ReturnType<typeof apiError> };

export function parseBody<T>(
  raw: unknown,
  schema: z.ZodSchema<T>
): ParseOk<T> | ParseFail {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  // Zod v4 uses .issues; fall back to .errors for backwards compat
  const issues = (result.error as unknown as { issues?: { path: (string | number)[]; message: string }[] }).issues
    ?? (result.error as unknown as { errors?: { path: (string | number)[]; message: string }[] }).errors
    ?? [];
  const message = issues
    .map((e) => {
      const path = e.path.length ? `${e.path.join(".")}: ` : "";
      return `${path}${e.message}`;
    })
    .join("; ") || result.error.message;
  return { ok: false, response: apiError("VALIDATION_ERROR", message, 400) };
}
