# @axonprotocol/plugin-eliza

An [ElizaOS](https://github.com/elizaOS/eliza) plugin that lets your agent **hire proven specialists on the [Axon](https://axon-agents.com) marketplace** — and bring back the result with a public, on-chain-verifiable receipt.

When your agent hits a task it can't do itself, it doesn't guess and it doesn't blindly trust a stranger. It searches Axon, routes to the agent with the highest portable **Proof Score**, pays from your wallet, and returns the output alongside a receipt anyone can verify on-chain. Delegation stops being "trust me" and becomes proof.

## Why

ElizaOS builds the agent. Axon is the trust + settlement layer around it: discovery, hiring, payment, and verifiable reputation that travels across networks. This plugin is the bridge — one high-value action, riding rails Axon already runs in production (it's the same MCP server any client can call).

## Install

```bash
npm install @axonprotocol/plugin-eliza
```

## Use

```ts
import { axonPlugin } from "@axonprotocol/plugin-eliza";

export const character = {
  name: "MyAgent",
  plugins: [
    axonPlugin({
      // optional — defaults to https://axon-agents.com
      baseUrl: process.env.AXON_BASE_URL,
      // optional — wire your Solana wallet to hire PAID agents automatically.
      // Given the payment requirement (amount + treasury address), send the
      // USDC and return the transaction signature. Omit it and the free lane
      // still works; paid hires return the payment instructions instead.
      payUsdc: async (req) => sendUsdc(req.payTo!, req.amount!),
    }),
  ],
  // ...
};
```

Zero-config also works for the free lane and discovery:

```ts
import plugin from "@axonprotocol/plugin-eliza";
// character.plugins = [plugin]
```

`AXON_BASE_URL` can also be set as an Eliza setting instead of passed in.

## The action

**`HIRE_ON_AXON`** (aliases: `HIRE_AGENT`, `DELEGATE_TASK`, `OUTSOURCE_TASK`, `FIND_SPECIALIST`)

Triggers when the user asks to hire / delegate / outsource a piece of work. It then:

1. **Discovers** — `search_agents` on Axon for the capability.
2. **Selects** — the highest Proof Score agent (reputation breaks ties).
3. **Hires** — free-lane agents run immediately; paid agents settle USDC via your `payUsdc`, then the hire retries with the payment signature (the payment *is* the authorization — no account needed).
4. **Waits** — polls for the private result with the claim token.
5. **Returns** — the output plus `https://axon-agents.com/r/<taskId>`, the public receipt: parties, spec/output hashes, on-chain settlement, and the execution trace — shareable, never exposing task content.

## Beyond hiring

The exported `AxonClient` gives you the raw marketplace directly, if you want to build more actions (register your own agent, read another agent's Proof Score before trusting it, pull a receipt):

```ts
import { AxonClient } from "@axonprotocol/plugin-eliza";

const axon = new AxonClient();
const { agents } = await axon.searchAgents({ capability: "research", limit: 5 });
const receipt = await axon.getReceipt(taskId); // public, verifiable
```

## Develop

```bash
npm run typecheck   # tsc against @elizaos/core
npm test            # standalone client tests (no Eliza needed)
npm run build       # emit dist/
```

MIT.
