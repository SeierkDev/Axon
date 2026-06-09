// In-process SSE event bus for real-time dashboard updates.
// Uses globalThis to survive Next.js HMR without dropping subscribers.
// Consumers subscribe to specific agent IDs or the "*" wildcard.

import { EventEmitter } from "events";

export interface TaskUpdatedEvent {
  type: "task.updated";
  data: { taskId: string; status: string; agentId: string; fromAgent: string };
}

export interface TaskProgressEvent {
  type: "task.progress";
  data: { taskId: string; agentId: string; fromAgent: string; message: string; sequence: number };
}

export type AxonEvent = TaskUpdatedEvent | TaskProgressEvent;

const BUS_KEY = "__axon_event_bus__";

function getOrCreateBus(): EventEmitter {
  const g = globalThis as Record<string, unknown>;
  if (!(g[BUS_KEY] instanceof EventEmitter)) {
    const bus = new EventEmitter();
    bus.setMaxListeners(500);
    // Prevent Node.js from throwing when an agent named "error" emits on the bus.
    // Without this, EventEmitter's special "error" channel throws if unhandled.
    bus.on("error", () => {});
    g[BUS_KEY] = bus;
  }
  return g[BUS_KEY] as EventEmitter;
}

export const eventBus = getOrCreateBus();

export function emitAxonEvent(event: AxonEvent): void {
  eventBus.emit(event.data.agentId, event);
  eventBus.emit("*", event);
}
