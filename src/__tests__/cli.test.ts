import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseArgs,
  buildRegisterBody,
  buildTaskBody,
  loadConfig,
  saveConfig,
  clearConfig,
  verifyTrace,
} from "@/cli/axon";

describe("axon cli", () => {
  describe("parseArgs", () => {
    it("parses command, value flags, and boolean flags", () => {
      const p = parseArgs(["register", "--id", "a", "--name", "My Agent", "--dry"]);
      expect(p.command).toBe("register");
      expect(p.flags.id).toBe("a");
      expect(p.flags.name).toBe("My Agent");
      expect(p.flags.dry).toBe(true);
    });

    it("captures positional args", () => {
      const p = parseArgs(["receipt", "task-123"]);
      expect(p.command).toBe("receipt");
      expect(p.positional).toEqual(["task-123"]);
    });

    it("defaults to help with no args", () => {
      expect(parseArgs([]).command).toBe("help");
    });
  });

  describe("buildRegisterBody", () => {
    it("maps flags and splits/trims capabilities", () => {
      const body = buildRegisterBody({
        id: "my-agent",
        name: "My Agent",
        capabilities: "research, analysis ,coding",
        wallet: "WALLET",
        "public-key": "PUBKEY",
      });
      expect(body).toMatchObject({
        agentId: "my-agent",
        name: "My Agent",
        capabilities: ["research", "analysis", "coding"],
        walletAddress: "WALLET",
        publicKey: "PUBKEY",
        provider: "anthropic",
      });
    });

    it("includes optional fields and respects an explicit provider", () => {
      const body = buildRegisterBody({
        id: "a",
        name: "A",
        capabilities: "x",
        wallet: "W",
        "public-key": "PK",
        provider: "openai",
        price: "0.05 USDC",
        category: "Research",
      });
      expect(body.provider).toBe("openai");
      expect(body.price).toBe("0.05 USDC");
      expect(body.category).toBe("Research");
    });

    it("throws listing the missing required flags", () => {
      expect(() => buildRegisterBody({ id: "a" })).toThrow(/missing required/);
    });
  });

  describe("buildTaskBody", () => {
    it("maps from/to/task plus optional payment", () => {
      const body = buildTaskBody({ from: "a", to: "b", task: "do x", payment: "0.05 USDC" });
      expect(body).toMatchObject({ from: "a", to: "b", task: "do x", payment: "0.05 USDC" });
    });

    it("throws on missing required flags", () => {
      expect(() => buildTaskBody({ from: "a" })).toThrow(/missing required/);
    });

    it("keeps idempotency-key OUT of the body (it's sent as a header)", () => {
      const body = buildTaskBody({ from: "a", to: "b", task: "x", "idempotency-key": "k1" });
      expect(body.idempotencyKey).toBeUndefined();
      expect("idempotency-key" in body).toBe(false);
    });
  });

  describe("config", () => {
    it("round-trips and clears", () => {
      const path = join(tmpdir(), `axon-cli-test-${Date.now()}.json`);
      saveConfig({ endpoint: "http://x", apiKey: "k" }, path);
      expect(loadConfig(path)).toEqual({ endpoint: "http://x", apiKey: "k" });
      clearConfig(path);
      expect(loadConfig(path)).toEqual({});
    });
  });

  describe("verifyTrace (axon verify)", () => {
    const trace = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "packages", "sdk", "test", "fixtures", "trace-valid.json"), "utf8"),
    );

    it("recomputes a real production trace as intact", () => {
      const r = verifyTrace(trace);
      expect(r.chainValid).toBe(true);
      expect(r.brokenAt).toBeNull();
      expect(r.chainValid).toBe(r.platformClaim);
    });

    it("catches a tampered field", () => {
      const t = JSON.parse(JSON.stringify(trace));
      const ev = t.events.find((e: { seq: number }) => e.seq === 2) ?? t.events[1];
      ev.outputTokens = (ev.outputTokens ?? 0) + 1;
      const r = verifyTrace(t);
      expect(r.chainValid).toBe(false);
      expect(r.brokenAt).toBe(2);
    });

    it("catches a dropped event", () => {
      const t = JSON.parse(JSON.stringify(trace));
      t.events = t.events.filter((e: { seq: number }) => e.seq !== 2);
      expect(verifyTrace(t).chainValid).toBe(false);
    });
  });
});
