import { describe, it, expect } from "vitest";
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findHireRecordPda,
  getTaskDecoder,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import { hashSpec } from "@/lib/specCommitment";

// AgenC interop, end to end: a REAL Axon job-spec hash (produced by our
// production hashSpec code path) is pinned and executed through AgenC's actual
// compiled on-chain program — register → list → attest → hire → pin job spec →
// claim → complete — inside the litesvm sandbox (in-process, no validator).
//
// This is the guarantee behind "verifiable on AgenC": if either side's hashing
// or the marketplace flow drifts, this test fails.
describe("AgenC interop — Axon job specs execute on AgenC's program", () => {
  it("runs a full hire with an Axon spec hash pinned on-chain; the worker gets paid", async () => {
    // A realistic Axon task spec, hashed with OUR production code path.
    const axonSpecHex = hashSpec({
      fromAgent: "axon-creator-agent",
      toAgent: "axon-worker-agent",
      task: "Summarize the weekly network report",
      context: { lang: "en", format: "markdown" },
      payment: "2.50 USDC",
    });
    const axonHash = Uint8Array.from(Buffer.from(axonSpecHex, "hex"));
    expect(axonHash).toHaveLength(32); // AgenC spec hashes are exactly 32 bytes

    const market = await startLocalMarketplace();
    const provider = await market.fundedSigner(); // the worker
    const buyer = await market.fundedSigner(); // the creator
    const providerClient = market.clientFor(provider);
    const buyerClient = market.clientFor(buyer);

    // Register both actors on AgenC.
    const providerAgentId = new Uint8Array(32).fill(1);
    await providerClient.registerAgent({
      authority: provider,
      agentId: providerAgentId,
      capabilities: 1n,
      endpoint: "https://axon-worker.example",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

    const buyerAgentId = new Uint8Array(32).fill(2);
    await buyerClient.registerAgent({
      authority: buyer,
      agentId: buyerAgentId,
      capabilities: 1n,
      endpoint: "https://axon-creator.example",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

    // Provider lists a service, pinned with the AXON hash.
    const listingId = new Uint8Array(32).fill(3);
    const price = 1_000_000n;
    await providerClient.createServiceListing({
      providerAgent,
      authority: provider,
      listingId,
      name: new Uint8Array(32).fill(5),
      category: new Uint8Array(32).fill(6),
      tags: new Uint8Array(64).fill(7),
      specHash: axonHash,
      specUri: `agenc://job-spec/sha256/${axonSpecHex}`,
      price,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    });
    const [listing] = await facade.findListingPda({ providerAgent, listingId });

    // Moderation attests CLEAN against the same Axon hash (fail-closed gate).
    await market.moderator.attestListing(listing, axonHash);

    // Buyer hires — task + escrow + hire record in one instruction.
    const taskId = new Uint8Array(32).fill(8);
    await buyerClient.hireFromListing({
      listing,
      creatorAgent: buyerAgent,
      authority: buyer,
      creator: buyer,
      taskId,
      expectedPrice: price,
      expectedVersion: 1n,
      listingSpecHash: axonHash,
    });
    const [task] = await findTaskPda({ creator: buyer.address, taskId });

    // Pin the AXON job-spec hash on the on-chain task itself.
    await market.moderator.attestTask(task, axonHash);
    await buyerClient.send([
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash: axonHash,
        jobSpecUri: `agenc://job-spec/sha256/${axonSpecHex}`,
      }),
    ]);

    // Worker claims, completes; escrow pays out.
    await providerClient.claimTaskWithJobSpec({ task, worker: providerAgent, authority: provider });
    const balanceBefore = market.svm.getBalance(provider.address) ?? 0n;
    const [hireRecord] = await findHireRecordPda({ task });
    await providerClient.send([
      await facade.completeTask({
        task,
        creator: buyer.address,
        worker: providerAgent,
        treasury: market.admin.address,
        authority: provider,
        hireRecord,
        proofHash: new Uint8Array(32).fill(10),
        resultData: null,
      }),
    ]);

    // On-chain end state: task Completed and the worker actually got paid.
    const taskAccount = market.svm.getAccount(task);
    if (!taskAccount || !("data" in taskAccount)) throw new Error("task account missing on-chain");
    const { status } = getTaskDecoder().decode(Uint8Array.from(taskAccount.data));
    expect(status).toBe(TaskStatus.Completed);
    const paid = (market.svm.getBalance(provider.address) ?? 0n) - balanceBefore;
    expect(paid).toBeGreaterThan(0n);
  }, 30_000);
});
