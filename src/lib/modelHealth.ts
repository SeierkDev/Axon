// Whether an agent's configured model is a model the provider will actually run.
//
// An agent is registered with a provider and a model name, and nothing checks the name against
// the provider until the first task runs. A typo ("gpt5.5", "grok 4.7", "ID") is accepted at
// registration and then fails every task the agent is ever given, forever. Because the generated
// activity cron picks uniformly from every registered agent, a handful of these produce a steady
// drip of failures that no retry and no key rotation will fix.
//
// The provider tells us plainly when this is the case, and it says so differently per provider:
// Anthropic raises NotFound/PermissionDenied, OpenAI answers 404 model_not_found, xAI answers
// "not-found". What they have in common is the verdict: this model does not exist, or is not
// yours to use. That is a permanent answer about configuration, not a transient failure.

import { isoHoursAgo } from "./sqlTime";

/**
 * Does this error mean the model itself is unusable, rather than the call having gone wrong?
 *
 * Deliberately narrow. A timeout, a rate limit, an overloaded provider and an invalid API key are
 * all things that come right on their own or with a fix elsewhere, and none of them say anything
 * about the agent's configuration. Only a verdict about the model counts here, because the
 * consequence is that the agent stops being given work.
 */
export function isPermanentModelError(raw: unknown): boolean {
  const text = String(
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(raw ?? ""),
  );
  if (!text) return false;

  // An auth failure can also carry a 404, and it is emphatically not the model's fault.
  if (/authentication_error|api key is invalid|invalid_api_key|unauthorized/i.test(text)) return false;

  return (
    /does not exist or you do not have access/i.test(text) ||
    /model_not_found/i.test(text) ||
    /\binvalid model\b/i.test(text) ||
    /\bunknown model\b/i.test(text) ||
    /model .{0,80}? does not exist/i.test(text) ||
    /"code"\s*:\s*"not-found"/i.test(text)
  );
}

/** A short, storable note about what the provider said. */
export function summarizeModelError(raw: unknown): string {
  const text = String(raw instanceof Error ? raw.message : raw ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 300);
}

/**
 * How long an agent is left out of generated work after its model was rejected.
 *
 * A cooldown rather than a permanent exclusion, because nothing in the update path lets an owner
 * change a model today: a flag that only ever gets set would strand the agent for good. After the
 * window it is tried once more, and either it has been fixed or it costs a single failure and goes
 * quiet again. One a day instead of one every few minutes.
 */
export const MODEL_ERROR_COOLDOWN_HOURS = Number(process.env.AXON_MODEL_ERROR_COOLDOWN_HOURS ?? 24);

/** SQL for "this agent's model was not rejected recently". Safe to paste into a WHERE clause. */
export const MODEL_LOOKS_USABLE = `(
  model_error_at IS NULL
  OR model_error_at < ${isoHoursAgo(Number.isFinite(MODEL_ERROR_COOLDOWN_HOURS) ? MODEL_ERROR_COOLDOWN_HOURS : 24)}
)`;
