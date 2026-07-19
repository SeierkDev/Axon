// The Axon agent runtime — the batteries-included worker.
//
// The low-level client gives you the primitives (register, getTaskHistory,
// startTask, completeTask, failTask, emitProgress). This wires them into a live
// agent: register once, then poll for queued work, run your handler, and settle
// each task — with concurrency, progress, graceful shutdown, and self-healing
// error handling. Building an earning agent goes from ~40 lines of glue to:
//
//   const agent = defineAgent(axon, {
//     agentId: "my-agent", name: "My Agent", capabilities: ["research"],
//     publicKey, walletAddress,
//     handler: async ({ task, progress }) => {
//       await progress("thinking…");
//       return await doTheWork(task.task);
//     },
//   });
//   await agent.start();

import { AxonApiError, AxonClient } from "./client";
import type { AgentContext, AgentRuntimeOptions, AxonAgent, TaskRequest } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isNotFound(err: unknown): boolean {
  return err instanceof AxonApiError && (err.status === 404 || err.code === "NOT_FOUND");
}

// A task claimed by another worker between our poll and our startTask — expected
// under concurrency, not an error worth surfacing.
function isStateConflict(err: unknown): boolean {
  return err instanceof AxonApiError && (err.status === 409 || err.code === "TASK_STATE_CONFLICT");
}

/**
 * Define a long-running Axon agent. Returns a controller — call `start()` to
 * register (if needed) and begin processing queued tasks, `stop()` to drain and
 * shut down. The handler runs once per incoming task; return its output string
 * (or `{ output, success:false }` / throw to fail the task).
 */
export function defineAgent(client: AxonClient, options: AgentRuntimeOptions): AxonAgent {
  const {
    handler,
    pollIntervalMs = 2000,
    autoRegister = true,
    concurrency = 1,
    onError,
    onTaskStart,
    onTaskComplete,
    ...registration
  } = options;
  const agentId = registration.agentId;

  let running = false;
  let stopping = false;
  let loopPromise: Promise<void> | null = null;
  const inFlight = new Set<Promise<void>>();
  // Task ids currently being handled. A queued task can be returned by another
  // poll before our startTask transitions it out of `queued`; tracking claims
  // stops us launching the same task twice under concurrency > 1.
  const claiming = new Set<string>();

  async function ensureRegistered(): Promise<void> {
    if (!autoRegister) return;
    try {
      await client.getAgent(agentId);
    } catch (err) {
      if (isNotFound(err)) {
        await client.register(registration);
        return;
      }
      throw err;
    }
  }

  // Invoke a user lifecycle hook without letting a throw from it derail the
  // runtime (it would otherwise surface as an unhandled rejection on the detached
  // runOne promise).
  function safeCall<A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A): void {
    if (!fn) return;
    try {
      fn(...args);
    } catch {
      /* a throwing hook is the caller's bug, not ours to propagate */
    }
  }

  // Settle a finished task, retrying a few times so a transient backend blip
  // doesn't strand completed work in `running`. Returns whether it settled; on a
  // sustained failure the output is unrecoverable, so we surface it via onError.
  async function settle(started: TaskRequest, ok: boolean, text: string): Promise<boolean> {
    const attempts = 4;
    for (let i = 0; i < attempts; i++) {
      try {
        if (ok) await client.completeTask(started.taskId, text);
        else await client.failTask(started.taskId, text);
        return true;
      } catch (err) {
        // Task is already terminal — an earlier settle landed but its response was
        // lost, and the retry now sees a state conflict. That's success, not an
        // orphan: the task did settle.
        if (isStateConflict(err)) return true;
        if (i === attempts - 1) {
          safeCall(onError, err, started);
          return false;
        }
        await sleep(Math.min(2000, 200 * 2 ** i));
      }
    }
    return false;
  }

  async function runOne(task: TaskRequest): Promise<void> {
    // Claim the task. If another worker beat us to it, quietly move on.
    let started: TaskRequest;
    try {
      started = await client.startTask(task.taskId);
    } catch (err) {
      if (isStateConflict(err)) return;
      safeCall(onError, err, task);
      return;
    }

    safeCall(onTaskStart, started);
    const ctx: AgentContext = {
      task: started,
      // Progress is best-effort telemetry — a failed emit must never fail the
      // task the handler is otherwise completing fine.
      progress: (message: string) =>
        client.emitProgress(started.taskId, message).then(
          () => undefined,
          () => undefined,
        ),
      get stopping() {
        return stopping;
      },
    };

    // Run the handler → normalize to a terminal outcome. `text` is the output
    // when successful, the error message otherwise. A throw fails the task.
    let ok: boolean;
    let text: string;
    try {
      const result = await handler(ctx);
      if (typeof result === "string") {
        ok = true;
        text = result;
      } else {
        ok = result.success !== false;
        text = ok ? result.output : result.output || "Task failed";
      }
    } catch (err) {
      ok = false;
      text = err instanceof Error ? err.message : String(err);
      safeCall(onError, err, started);
    }

    const settled = await settle(started, ok, text);
    if (settled) {
      safeCall(onTaskComplete, {
        taskId: started.taskId,
        success: ok,
        output: ok ? text : "",
        error: ok ? undefined : text,
        completedAt: new Date().toISOString(),
      });
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      let launched = 0;
      try {
        const slots = concurrency - inFlight.size;
        if (slots > 0) {
          const queued = await client.getTaskHistory({ agentId, role: "recipient", status: "queued", limit: slots });
          for (const task of queued) {
            if (!running) break;
            if (claiming.has(task.taskId)) continue; // already picked up this pass/loop
            claiming.add(task.taskId);
            const p = runOne(task).finally(() => {
              inFlight.delete(p);
              claiming.delete(task.taskId);
            });
            inFlight.add(p);
            launched++;
          }
        }
      } catch (err) {
        // A transient poll failure must not kill the loop.
        safeCall(onError, err);
      }
      // If we filled work this pass, loop again immediately to keep slots busy;
      // otherwise idle for the poll interval.
      if (launched === 0) await sleep(pollIntervalMs);
    }
  }

  return {
    get agentId() {
      return agentId;
    },
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      // Set running synchronously — before the first await — so a second
      // concurrent start() is a genuine no-op and can't spawn a rival loop.
      running = true;
      stopping = false;
      try {
        await ensureRegistered();
      } catch (err) {
        running = false; // startup failed; allow another attempt
        throw err;
      }
      loopPromise = loop();
    },
    async stop() {
      stopping = true;
      running = false;
      // Wait for in-flight handlers to settle so no task is left half-done.
      await Promise.allSettled([...inFlight]);
      if (loopPromise) await loopPromise;
      loopPromise = null;
    },
  };
}
