// Distributed trace context — propagates a traceId through async task processing chains.
// A trace groups: task creation → worker execution → payment settlement → webhook queueing.
// Webhook delivery runs in a separate poll cycle and does not carry the traceId.
// The traceId is set at task creation time (inherited from the HTTP requestId when available)
// and carried forward via AsyncLocalStorage through the worker processing chain.

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { getRequestId } from "./requestContext";

const storage = new AsyncLocalStorage<{ traceId: string }>();

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

// Returns the active traceId if one exists, otherwise falls back to the
// current requestId, and finally generates a fresh one.
export function resolveTraceId(): string {
  return getTraceId() ?? getRequestId() ?? randomUUID();
}
