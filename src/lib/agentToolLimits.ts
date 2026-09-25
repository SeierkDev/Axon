// Bounds on agent tool use. Dependency-free on purpose: the inference layer
// needs these numbers, and must not pull the DB layer onto the model-call path
// (same reasoning as ./modelUsage). ./agentTools re-exports them.

/** Grants an owner may attach to one agent. */
export const MAX_TOOL_GRANTS = 8;
/**
 * The most any owner can reach, whatever they hold. Request validation accepts up to this so the
 * per-owner allowance can be checked afterwards, against the wallet rather than against a constant;
 * a schema that stopped at the default would reject a holder's tenth tool before anyone asked whose
 * tools they were.
 */
export const MAX_TOOL_GRANTS_CEILING = MAX_TOOL_GRANTS * 3;
/** Model↔tool round trips inside a single task. The hard stop on a runaway loop. */
export const MAX_TOOL_STEPS = 6;
/** MCP tool schemas loaded into one request — every schema costs input tokens. */
export const MAX_LOCAL_TOOLS = 24;
/** Characters of a single tool result fed back to the model. */
export const MAX_TOOL_RESULT_CHARS = 20_000;
