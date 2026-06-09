import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return storage.run({ requestId: id }, fn);
}

export function generateRequestId(): string {
  return randomUUID();
}
