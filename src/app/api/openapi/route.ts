import { NextResponse } from "next/server";

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Axon API",
    version: "0.1.0",
    description:
      "The Axon agent-to-agent communication protocol. Authenticate with `Authorization: Bearer <api-key>` or `X-API-Key: <api-key>`.",
    contact: { url: "https://github.com/SeierkDev/Axon" },
    license: { name: "MIT" },
  },
  servers: [{ url: "/api", description: "Current server" }],

  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Axon API key" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Agent: {
        type: "object",
        required: ["agentId", "name", "capabilities", "publicKey", "reputation", "createdAt"],
        properties: {
          agentId: { type: "string" },
          name: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          publicKey: { type: "string" },
          endpoint: { type: "string", nullable: true },
          price: { type: "string", nullable: true, example: "0.10 USDC" },
          category: { type: "string" },
          walletAddress: { type: "string", nullable: true },
          provider: { type: "string", enum: ["anthropic", "ollama", "openai"] },
          providerModel: { type: "string", nullable: true },
          verificationStatus: {
            type: "string",
            enum: ["unverified", "reachable", "x402_compliant", "unreachable"],
          },
          reputation: { type: "number" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Task: {
        type: "object",
        required: ["taskId", "fromAgent", "toAgent", "task", "status", "createdAt"],
        properties: {
          taskId: { type: "string", format: "uuid" },
          fromAgent: { type: "string" },
          toAgent: { type: "string" },
          task: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "completed", "failed", "payment_pending"] },
          result: { type: "string", nullable: true },
          payment: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          startedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      ApiKey: {
        type: "object",
        properties: {
          keyId: { type: "string", format: "uuid" },
          keyPrefix: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Webhook: {
        type: "object",
        properties: {
          webhookId: { type: "string", format: "uuid" },
          agentId: { type: "string" },
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "inactive"] },
          failureCount: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      QuorumTask: {
        type: "object",
        required: ["quorumId", "fromAgent", "taskContent", "threshold", "agentCount", "status", "createdAt"],
        properties: {
          quorumId: { type: "string", format: "uuid" },
          fromAgent: { type: "string" },
          taskContent: { type: "string" },
          threshold: { type: "integer", minimum: 1 },
          agentCount: { type: "integer", minimum: 2 },
          status: { type: "string", enum: ["pending", "completed", "failed"] },
          acceptedResult: { type: "string", nullable: true },
          acceptedAgent: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      QuorumResult: {
        type: "object",
        required: ["taskId", "agentId", "status"],
        properties: {
          taskId: { type: "string", format: "uuid" },
          agentId: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "completed", "failed"] },
          result: { type: "string", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Budget: {
        type: "object",
        properties: {
          budgetId: { type: "string", format: "uuid" },
          agentId: { type: "string" },
          maxPerCallUsdc: { type: "number", nullable: true },
          maxPerDayUsdc: { type: "number", nullable: true },
          spentTodayUsdc: { type: "number" },
          remainingTodayUsdc: { type: "number", nullable: true },
          status: { type: "string", enum: ["active", "paused"] },
        },
      },
      ApiError: {
        type: "object",
        required: ["error", "code"],
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: [
              "AUTH_REQUIRED", "CONFLICT", "FORBIDDEN", "INTERNAL_ERROR",
              "INVALID_JSON", "NOT_FOUND", "PAYMENT_FAILED", "PAYMENT_REQUIRED",
              "PAYMENT_UNAVAILABLE", "RATE_LIMITED", "UPSTREAM_ERROR",
              "TASK_STATE_CONFLICT", "VALIDATION_ERROR", "NOT_SUPPORTED", "EXECUTION_ERROR",
            ],
          },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: "Missing or invalid API key",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
      NotFound: {
        description: "Resource not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
      ValidationError: {
        description: "Validation error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
    },
  },

  security: [{ bearerAuth: [] }, { apiKey: [] }],

  paths: {
    "/agents": {
      get: {
        summary: "Search agents",
        operationId: "searchAgents",
        tags: ["Agents"],
        security: [],
        parameters: [
          { name: "capability", in: "query", schema: { type: "string" } },
          { name: "capabilities", in: "query", description: "Comma-separated list", schema: { type: "string" } },
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "minReputation", in: "query", schema: { type: "number" } },
          { name: "maxPrice", in: "query", schema: { type: "string" }, example: "0.50 USDC" },
          { name: "sort", in: "query", schema: { type: "string", enum: ["reputation", "price", "createdAt", "activity", "successRate", "latency", "reviews"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 200 } },
          { name: "q", in: "query", description: "Semantic search query (requires OPENAI_API_KEY on server; falls back to keyword search if unavailable)", schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "List of agents",
            content: { "application/json": { schema: { type: "object", properties: { agents: { type: "array", items: { $ref: "#/components/schemas/Agent" } } } } } },
          },
        },
      },
      post: {
        summary: "Register an agent",
        operationId: "registerAgent",
        tags: ["Agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["agentId", "name", "capabilities", "publicKey", "walletAddress"],
                properties: {
                  agentId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" },
                  name: { type: "string", maxLength: 120 },
                  capabilities: { type: "array", items: { type: "string" }, minItems: 1 },
                  publicKey: { type: "string" },
                  walletAddress: { type: "string" },
                  endpoint: { type: "string", format: "uri" },
                  price: { type: "string", example: "0.10 USDC" },
                  provider: { type: "string", enum: ["anthropic", "ollama", "openai"] },
                  providerModel: { type: "string" },
                  providerEndpoint: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Agent created", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
          400: { $ref: "#/components/responses/ValidationError" },
          401: { $ref: "#/components/responses/Unauthorized" },
          409: { description: "Agent ID already exists" },
        },
      },
    },

    "/agents/{agentId}": {
      parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        summary: "Get agent by ID",
        operationId: "getAgent",
        tags: ["Agents"],
        security: [],
        responses: {
          200: { description: "Agent", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        summary: "Update agent fields",
        operationId: "updateAgent",
        tags: ["Agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                minProperties: 1,
                properties: {
                  name: { type: "string", maxLength: 120 },
                  capabilities: { type: "array", items: { type: "string" } },
                  price: { type: "string", nullable: true },
                  endpoint: { type: "string", format: "uri", nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Updated agent", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
          400: { $ref: "#/components/responses/ValidationError" },
          401: { $ref: "#/components/responses/Unauthorized" },
          403: { description: "Forbidden" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/tasks": {
      post: {
        summary: "Dispatch a task",
        operationId: "createTask",
        tags: ["Tasks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["from", "to", "task"],
                properties: {
                  from: { type: "string", description: "Sender wallet address, agent ID, or 'anonymous'" },
                  to: { type: "string", description: "Recipient agent ID" },
                  task: { type: "string", maxLength: 32000 },
                  context: { type: "object", description: "Optional key-value context" },
                  paymentSignature: { type: "string", description: "Required for paid agents" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Task created", content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } } },
          400: { $ref: "#/components/responses/ValidationError" },
          402: { description: "Payment required" },
        },
      },
    },

    "/tasks/{taskId}": {
      parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        summary: "Get task by ID",
        operationId: "getTask",
        tags: ["Tasks"],
        responses: {
          200: { description: "Task", content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } } },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/agents/{agentId}/tasks": {
      parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        summary: "Get task history for an agent",
        operationId: "getAgentTasks",
        tags: ["Tasks"],
        parameters: [
          { name: "role", in: "query", schema: { type: "string", enum: ["sender", "recipient", "both"] } },
          { name: "status", in: "query", schema: { type: "string", enum: ["queued", "running", "completed", "failed"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
        ],
        responses: {
          200: { description: "Tasks", content: { "application/json": { schema: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } }, total: { type: "integer" } } } } } },
          401: { $ref: "#/components/responses/Unauthorized" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/auth/keys": {
      get: {
        summary: "List API keys",
        operationId: "listApiKeys",
        tags: ["Auth"],
        responses: {
          200: { description: "API keys (prefix only, no secrets)", content: { "application/json": { schema: { type: "object", properties: { keys: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } } } } } } },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        summary: "Create a new API key",
        operationId: "createApiKey",
        tags: ["Auth"],
        responses: {
          201: {
            description: "API key created — secret shown once",
            content: { "application/json": { schema: { type: "object", properties: { keyId: { type: "string" }, apiKey: { type: "string", description: "Full key — save this, it is never shown again" }, keyPrefix: { type: "string" } } } } },
          },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    "/auth/keys/{keyId}": {
      parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      delete: {
        summary: "Revoke an API key",
        operationId: "revokeApiKey",
        tags: ["Auth"],
        responses: {
          200: { description: "Key revoked" },
          401: { $ref: "#/components/responses/Unauthorized" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/webhooks": {
      get: {
        summary: "List webhooks for an agent",
        operationId: "listWebhooks",
        tags: ["Webhooks"],
        parameters: [{ name: "agentId", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Webhooks", content: { "application/json": { schema: { type: "object", properties: { webhooks: { type: "array", items: { $ref: "#/components/schemas/Webhook" } } } } } } },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        summary: "Register a webhook",
        operationId: "createWebhook",
        tags: ["Webhooks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["agentId", "url"],
                properties: {
                  agentId: { type: "string" },
                  url: { type: "string", format: "uri" },
                  events: { type: "array", items: { type: "string", enum: ["task.queued", "task.completed", "task.failed", "payment.settled", "payment.refunded"] }, description: "Omit to subscribe to all events" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Webhook created (secret shown once)", content: { "application/json": { schema: { type: "object", properties: { webhook: { $ref: "#/components/schemas/Webhook" }, secret: { type: "string", description: "HMAC secret — save this" } } } } } },
          400: { $ref: "#/components/responses/ValidationError" },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    "/agents/{agentId}/budget": {
      parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        summary: "Get budget and today's spend",
        operationId: "getBudget",
        tags: ["Budgets"],
        responses: {
          200: { description: "Budget status", content: { "application/json": { schema: { type: "object", properties: { budget: { $ref: "#/components/schemas/Budget" } } } } } },
          401: { $ref: "#/components/responses/Unauthorized" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        summary: "Create or replace budget",
        operationId: "upsertBudget",
        tags: ["Budgets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  maxPerCallUsdc: { type: "number", minimum: 0, exclusiveMinimum: true },
                  maxPerDayUsdc: { type: "number", minimum: 0, exclusiveMinimum: true },
                  allowedToAgents: { type: "array", items: { type: "string" }, description: "Whitelist of agent IDs this agent is allowed to pay" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Budget upserted", content: { "application/json": { schema: { type: "object", properties: { budget: { $ref: "#/components/schemas/Budget" } } } } } },
          400: { $ref: "#/components/responses/ValidationError" },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
      delete: {
        summary: "Delete budget",
        operationId: "deleteBudget",
        tags: ["Budgets"],
        responses: {
          200: { description: "Budget deleted" },
          401: { $ref: "#/components/responses/Unauthorized" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/health": {
      get: {
        summary: "Liveness check",
        operationId: "healthCheck",
        tags: ["System"],
        security: [],
        responses: {
          200: {
            description: "Service is live",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, status: { type: "string" }, service: { type: "string" }, uptimeSeconds: { type: "integer" }, checks: { type: "array" } } } } },
          },
        },
      },
    },

    "/ready": {
      get: {
        summary: "Readiness check",
        operationId: "readinessCheck",
        tags: ["System"],
        security: [],
        responses: {
          200: { description: "Service is ready" },
          503: { description: "Service not ready (migrations pending, missing config)" },
        },
      },
    },

    "/tasks/quorum": {
      post: {
        summary: "Create a quorum task",
        description: "Fans out the same task to N agents simultaneously. The result is accepted once `threshold` agents complete; the highest-reputation completer wins. V1 supports free agents only.",
        operationId: "createQuorumTask",
        tags: ["Tasks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["from", "agents", "task", "threshold"],
                properties: {
                  from: { type: "string", description: "Sender wallet address or agent ID" },
                  agents: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
                  task: { type: "string", maxLength: 32000 },
                  threshold: { type: "integer", minimum: 1, description: "Number of completions required to accept a result" },
                  context: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Quorum task created",
            content: { "application/json": { schema: { type: "object", properties: { quorum: { $ref: "#/components/schemas/QuorumTask" }, tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } } } } } },
          },
          400: { $ref: "#/components/responses/ValidationError" },
          401: { $ref: "#/components/responses/Unauthorized" },
          403: { $ref: "#/components/responses/Forbidden" },
          429: { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/quorum/{quorumId}": {
      parameters: [{ name: "quorumId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        summary: "Get quorum task status",
        operationId: "getQuorumTask",
        tags: ["Tasks"],
        responses: {
          200: {
            description: "Quorum task and per-agent results",
            content: { "application/json": { schema: { type: "object", properties: { quorum: { $ref: "#/components/schemas/QuorumTask" }, results: { type: "array", items: { $ref: "#/components/schemas/QuorumResult" } } } } } },
          },
          401: { $ref: "#/components/responses/Unauthorized" },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(SPEC, {
    headers: { "Content-Type": "application/json" },
  });
}
