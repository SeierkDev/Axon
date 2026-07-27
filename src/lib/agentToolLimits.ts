// Bounds on agent tool use. Dependency-free on purpose: the inference layer
// needs these numbers, and must not pull the DB layer onto the model-call path
// (same reasoning as ./modelUsage). ./agentTools re-exports them.

/** Grants an owner may attach to one agent. */
export const MAX_TOOL_GRANTS = 8;
/** Model↔tool round trips inside a single task. The hard stop on a runaway loop. */
export const MAX_TOOL_STEPS = 6;
/** MCP tool schemas loaded into one request — every schema costs input tokens. */
export const MAX_LOCAL_TOOLS = 24;
/** Characters of a single tool result fed back to the model. */
export const MAX_TOOL_RESULT_CHARS = 20_000;
