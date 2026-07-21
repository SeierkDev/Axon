// One-shot hire: discover → (pay, if priced) → submit → poll to completion →
// receipt, in a single call. The code mirror of the in-browser hire flow — the
// demand-side counterpart to the agent runtime.
//
//   const result = await hire(axon, {
//     to: "research-agent",
//     task: "Summarize the top 5 L2s by TVL",
//     pay,            // omit for free-lane agents
//   });
//   console.log(result.output);   // the answer
//   console.log(result.receipt);  // the verifiable proof

import { AxonClient } from "./client";
import type { HireOptions, HireResult, Receipt, TaskRequest, X402Requirements } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hire an agent and wait for the result. Handles both lanes automatically:
 * free-lane agents run anonymously; priced agents are paid via x402 using the
 * supplied `pay` function. Polls the task to completion and (by default) returns
 * the verifiable receipt alongside the output.
 *
 * Retrieving the private output requires reading the task back, so set `from` to
 * an identity this client can read — your wallet address, or an agent you own —
 * with an initialized (`init({ apiKey })`) client. The default `from: "anonymous"`
 * creates the task fine but its private output isn't readable here (the receipt
 * still is); for accountless hiring that returns the output, use the in-browser
 * claim-token flow instead.
 */
export async function hire(client: AxonClient, opts: HireOptions): Promise<HireResult> {
  const {
    to,
    task,
    context,
    from = "anonymous",
    pay,
    paymentMethod,
    pollIntervalMs = 2000,
    timeoutMs = 120_000,
    withReceipt = true,
  } = opts;

  let created: TaskRequest;
  let paid: boolean;

  if (paymentMethod === "balance") {
    // Fund the hire from the `from` agent's earned balance — no x402 probe, no
    // `pay` function. The value is already pooled from when it earned. Requires an
    // authenticated, registered `from` (an identity that owns a balance).
    if (from === "anonymous") {
      throw new Error(
        'paymentMethod "balance" requires an authenticated `from` agent — init the client with an apiKey and set `from` to an agent you own. Balance is spent from that agent\'s earnings.',
      );
    }
    created = await client.sendTask({ from, to, task, context, paymentMethod: "balance" });
    paid = true;
  } else {
    // Is this agent priced? A 402 means yes (and carries the requirements); null
    // means free. Never trust a guess — ask the endpoint.
    let requirements: X402Requirements | null = null;
    try {
      requirements = await client.getX402Requirements(to);
    } catch {
      // If the probe itself fails, fall through to the free path; a genuinely paid
      // agent will reject an unpaid submit with a clear 402 below.
      requirements = null;
    }
    paid = requirements !== null;

    if (paid && !pay) {
      throw new Error(
        `Agent "${to}" is priced (x402) — pass a \`pay\` function to hire it, or set paymentMethod:"balance" to spend the \`from\` agent's earned balance. Free-lane agents need no payment.`,
      );
    }

    // Create the task — paid via x402, or free/anonymous.
    if (paid && pay) {
      created = await client.submitTaskX402(to, task, pay, { from, context });
    } else {
      created = await client.sendTask({ from, to, task, context });
    }
  }

  // Poll to a terminal state or the timeout.
  const deadline = Date.now() + timeoutMs;
  let current = created;
  while (current.status !== "completed" && current.status !== "failed") {
    if (Date.now() >= deadline) {
      return { taskId: current.taskId, status: current.status, paid, timedOut: true };
    }
    await sleep(pollIntervalMs);
    try {
      current = await client.getTask(current.taskId);
    } catch {
      // Transient read failure — keep polling until the deadline.
    }
  }

  const result: HireResult = {
    taskId: current.taskId,
    status: current.status,
    paid,
    timedOut: false,
  };
  if (current.status === "completed") {
    result.output = current.output ?? "";
    if (withReceipt) {
      try {
        const receipt: Receipt = (await client.getReceipt(current.taskId)).receipt;
        result.receipt = receipt;
      } catch {
        // The result stands even if the receipt isn't fetchable yet.
      }
    }
  } else {
    result.error = current.error ?? "Task failed";
  }
  return result;
}
