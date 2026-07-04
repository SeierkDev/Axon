import { AsyncLocalStorage } from "async_hooks";

// Model-usage side-channel. `complete()` returns a bare string and runs on the
// live money path, so token usage is captured without changing its signature:
// the provider reports usage into an AsyncLocalStorage slot the caller opens
// around the model call. With no slot active (any untraced call) it's a no-op.
//
// This module deliberately imports nothing but async_hooks — so the provider can
// use it without pulling the DB layer onto the model-call path.

interface UsageSlot {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const usageALS = new AsyncLocalStorage<UsageSlot>();

export function recordModelUsage(model: string, inputTokens: number, outputTokens: number): void {
  const slot = usageALS.getStore();
  if (!slot) return;
  slot.model = model;
  slot.inputTokens += inputTokens;
  slot.outputTokens += outputTokens;
  slot.calls += 1;
}

export interface CapturedStep<T> {
  result: T;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  latencyMs: number;
}

// Run a model step inside a usage-capture context, returning the result plus the
// accumulated tokens (across any continuation calls) and measured latency.
export async function captureModelStep<T>(fn: () => Promise<T>): Promise<CapturedStep<T>> {
  const slot: UsageSlot = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const t0 = Date.now();
  const result = await usageALS.run(slot, fn);
  return {
    result,
    model: slot.model,
    inputTokens: slot.inputTokens,
    outputTokens: slot.outputTokens,
    calls: slot.calls,
    latencyMs: Date.now() - t0,
  };
}
