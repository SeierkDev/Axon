// The function-calling door, for everything that does not speak MCP.
//
// The thing worth protecting here is that there is only one implementation of what a tool does.
// These routes translate shapes at the edge and hand the work to the MCP server module, so a model
// in Cursor and a model in a Python script mean the same thing by "hire". Most of this file is
// checking that the translation is right and that nothing has quietly grown a second copy.

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { GET as toolsGET, OPTIONS as toolsOPTIONS } from "@/app/api/tools/route";
import { POST as callPOST } from "@/app/api/tools/call/route";
import { MCP_TOOLS } from "@/lib/mcpServer";

const get = async (query = "") => {
  const res = await toolsGET(new NextRequest(`https://axon-agents.com/api/tools${query}`));
  return { status: res.status, body: await res.json(), res };
};

const call = async (body: unknown) => {
  const res = await callPOST(
    new NextRequest("https://axon-agents.com/api/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
};

const seed = (id: string, price: string | null, capability = "toolsapi") => {
  const db = getDb();
  db.prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
  db.prepare(
    `INSERT INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, price, description)
     VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)`,
  ).run(id, id, JSON.stringify([capability]), `${id}-k`, new Date().toISOString(), price, `does ${capability}`);
  db.prepare("INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)").run(capability, id);
};

describe("the schemas a model is handed", () => {
  it("wraps them the way OpenAI expects", async () => {
    const { body } = await get("?format=openai");

    expect(body.format).toBe("openai");
    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("flattens them the way Anthropic expects", async () => {
    const { body } = await get("?format=anthropic");

    for (const tool of body.tools) {
      // Same schema, different key, and getting this wrong means the model is handed a tool it
      // cannot call rather than an error anyone would notice.
      expect(tool.input_schema.type).toBe("object");
      expect(tool.function).toBeUndefined();
    }
  });

  it("gives Grok and Gemini the OpenAI shape, because that is what they take", async () => {
    const grok = await get("?format=grok");
    const gemini = await get("?format=gemini");
    const openai = await get("?format=openai");

    expect(grok.body.tools).toEqual(openai.body.tools);
    expect(gemini.body.tools).toEqual(openai.body.tools);
    // Named separately so a caller can ask for what they use, without pretending there is a third
    // format being maintained.
    expect(grok.body.format).toBe("grok");
  });

  it("falls back to OpenAI on a format it does not know, and says what it did", async () => {
    const { body } = await get("?format=llama-something");

    expect(body.format).toBe("openai");
    // Silently returning the wrong shape is how someone spends an hour debugging their own code.
    expect(body.requested).toBe("llama-something");
    expect(body.supported).toContain("anthropic");
  });

  it("offers every tool the MCP endpoint offers, and no others", async () => {
    // The check that matters: one implementation. A tool that exists on one door and not the other
    // means the doors have started drifting.
    const { body } = await get("?format=openai");
    const names = body.tools.map((t: { function: { name: string } }) => t.function.name).sort();

    expect(names).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });

  it("points at the MCP endpoint for clients that can use it directly", async () => {
    const { body } = await get();

    expect(body.mcp.url).toContain("/mcp");
    expect(body.call.url).toContain("/api/tools/call");
    expect(body.docs).toContain("/docs/mcp");
  });

  it("is readable from anywhere", async () => {
    // These are read by somebody's script or somebody's assistant, never by a page on this domain.
    const res = await toolsOPTIONS();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("running a call the model decided to make", () => {
  beforeEach(() => {
    seed("tools-free", null);
    seed("tools-paid", "0.0005 ETH");
  });

  it("returns the value parsed, not a wall of text", async () => {
    const { body } = await call({ name: "search_agents", arguments: { capability: "toolsapi" } });

    expect(body.ok).toBe(true);
    // A function-calling caller wants the value. The content blocks are kept alongside for anyone
    // handing the model exactly what MCP would have given it.
    expect(typeof body.result).toBe("object");
    expect(body.content[0].type).toBe("text");
  });

  it("takes arguments under any of the names frameworks use for them", async () => {
    // Half of them say arguments, some say input, some say args. Making a caller read source to
    // find out which is a pointless way to lose them.
    const a = await call({ name: "search_agents", arguments: { capability: "toolsapi" } });
    const b = await call({ name: "search_agents", input: { capability: "toolsapi" } });
    const c = await call({ name: "search_agents", args: { capability: "toolsapi" } });

    expect(a.body.ok && b.body.ok && c.body.ok).toBe(true);
    expect(JSON.stringify(b.body.result)).toBe(JSON.stringify(a.body.result));
    expect(JSON.stringify(c.body.result)).toBe(JSON.stringify(a.body.result));
  });

  it("refuses a tool that does not exist with a 400, not a cheerful 200", async () => {
    const { status, body } = await call({ name: "drop_everything" });

    expect(status).toBe(400);
    expect(body.error).toContain("drop_everything");
  });

  it("asks for a name when none was sent", async () => {
    const { status, body } = await call({ arguments: { capability: "toolsapi" } });

    expect(status).toBe(400);
    expect(body.error).toContain("name");
  });

  it("says so when the body is not JSON", async () => {
    const res = await callPOST(
      new NextRequest("https://axon-agents.com/api/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("hires a free agent without an account", async () => {
    const { body } = await call({
      name: "hire_agent",
      arguments: { agentId: "tools-free", task: "summarise this" },
    });

    expect(body.ok).toBe(true);
    const hire = body.result as { taskId: string; claimToken: string; receiptUrl: string };
    expect(hire.taskId).toBeTruthy();
    // The claim token is the only way back to the output, so a hire that did not return one would
    // leave the caller with work they cannot read.
    expect(hire.claimToken).toBeTruthy();
    expect(hire.receiptUrl).toContain(hire.taskId);
  });

  it("answers a paid hire with its price instead of running it", async () => {
    // Same behaviour as through MCP, because it is the same code. Nothing is spent by a model
    // deciding on its own to hire something.
    const { body } = await call({
      name: "hire_agent",
      arguments: { agentId: "tools-paid", task: "do a thing" },
    });

    const text = JSON.stringify(body.result);
    expect(text).toContain("0.0005 ETH");
  });
});
