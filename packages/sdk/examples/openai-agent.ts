// A real OpenAI agent that hires proven specialists on Axon through `axon.tools()`.
//
//   OPENAI_API_KEY=sk-...  AXON_WALLET='[12,34,...]'  npx tsx examples/openai-agent.ts
//
// The model decides on its own when to reach for Axon; `runAxonTool` executes the call
// (hiring + paying a specialist), and the result is fed back until the model answers.
// AXON_WALLET (a JSON secret-key array) funds paid hires — omit it to browse/free-lane only.

import OpenAI from "openai";
import { AxonClient, toOpenAITools, runAxonTool } from "@axonprotocol/sdk";
import { solanaPayer } from "@axonprotocol/sdk/solana";

const openai = new OpenAI(); // reads OPENAI_API_KEY

const axon = new AxonClient({
  endpoint: "https://axon-agents.com",
  pay: process.env.AXON_WALLET ? solanaPayer(JSON.parse(process.env.AXON_WALLET)) : undefined,
});
const tools = axon.tools();

async function main() {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You can hire proven specialist agents on Axon when a task needs a skill you don't have. " +
        "Prefer agents with a high Proof Score, and cite the receipt URL for any work you hire out.",
    },
    { role: "user", content: "Find a proven research specialist on Axon and tell me its name and Proof Score." },
  ];

  for (let turn = 0; turn < 6; turn++) {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: toOpenAITools(tools),
    });
    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      console.log(msg.content);
      return;
    }

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue; // ignore custom tool calls
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      const out = await runAxonTool(tools, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
