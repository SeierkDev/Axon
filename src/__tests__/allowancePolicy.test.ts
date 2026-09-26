import { describe, it, expect, afterEach } from "vitest";
import {
  NATIVE_TOKEN,
  DEFAULT_MAX_PER_TASK_WEI,
  DEFAULT_MAX_PER_DAY_WEI,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MAX_ALLOWED_AGENTS,
  RESERVATION_TIMEOUT_SECONDS,
  allowanceTokens,
  isAllowanceToken,
  allowancesEnabled,
  defaultRules,
  axonDefaultRules,
  rulesError,
  agentKey,
  taskKey,
  utcDay,
} from "@/lib/allowancePolicy";
import { toWei } from "@/lib/money";

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const NOW = 1_790_000_000;
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("allowance defaults", () => {
  it("the per-task default covers every paid agent price seen when it was set", () => {
    // 0.00005 to 0.0005 ETH across the 27 paid agents on 2026-09-26.
    for (const price of ["0.00005", "0.00015", "0.00025", "0.0005"]) {
      expect(toWei(price)! <= DEFAULT_MAX_PER_TASK_WEI).toBe(true);
    }
  });

  it("the daily default is above the per-task default and stays small", () => {
    expect(DEFAULT_MAX_PER_DAY_WEI).toBeGreaterThan(DEFAULT_MAX_PER_TASK_WEI);
    expect(DEFAULT_MAX_PER_DAY_WEI).toBe(toWei("0.005"));
  });

  it("default rules are valid as they stand", () => {
    expect(rulesError(defaultRules(NOW), NOW)).toBeNull();
    expect(defaultRules(NOW).expiresAt).toBe(NOW + DEFAULT_EXPIRY_DAYS * 86_400);
  });

  it("the $AXON defaults convert the ETH limits once, at creation", () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    const rules = axonDefaultRules(NOW, AXON, (wei) => wei * 1000n);
    expect(rules.maxPerTaskWei).toBe(DEFAULT_MAX_PER_TASK_WEI * 1000n);
    expect(rules.maxPerDayWei).toBe(DEFAULT_MAX_PER_DAY_WEI * 1000n);
    expect(rulesError(rules, NOW)).toBeNull();
  });

  it("a reservation can be reclaimed by its owner after a day", () => {
    expect(RESERVATION_TIMEOUT_SECONDS).toBe(86_400);
  });
});

describe("allowance tokens", () => {
  it("holds ETH only while $AXON payments are off", () => {
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    expect(allowanceTokens()).toEqual([NATIVE_TOKEN]);
    expect(isAllowanceToken(AXON)).toBe(false);
  });

  it("holds $AXON too once payments are on, whatever case the address is in", () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    expect(isAllowanceToken(AXON.toLowerCase())).toBe(true);
    expect(isAllowanceToken(AXON.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("refuses any other token", () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    expect(isAllowanceToken("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")).toBe(false);
  });

  it("is off until a contract address is set", () => {
    delete process.env.AXON_ALLOWANCE_ADDRESS;
    expect(allowancesEnabled()).toBe(false);
    process.env.AXON_ALLOWANCE_ADDRESS = "not an address";
    expect(allowancesEnabled()).toBe(false);
    process.env.AXON_ALLOWANCE_ADDRESS = "0x1111111111111111111111111111111111111111";
    expect(allowancesEnabled()).toBe(true);
  });
});

describe("rulesError", () => {
  const ok = () => defaultRules(NOW);

  it("refuses a zero per-task limit", () => {
    expect(rulesError({ ...ok(), maxPerTaskWei: 0n }, NOW)).toMatch(/per-task/);
  });

  it("refuses a daily limit below the per-task limit", () => {
    expect(rulesError({ ...ok(), maxPerDayWei: DEFAULT_MAX_PER_TASK_WEI - 1n }, NOW)).toMatch(/daily/);
  });

  it("refuses an expiry in the past or too far out", () => {
    expect(rulesError({ ...ok(), expiresAt: NOW }, NOW)).toMatch(/future/);
    expect(rulesError({ ...ok(), expiresAt: NOW + (MAX_EXPIRY_DAYS + 1) * 86_400 }, NOW)).toMatch(/at most/);
  });

  it("refuses duplicate, empty or too many allowed agents", () => {
    expect(rulesError({ ...ok(), allowedAgents: ["a", "a"] }, NOW)).toMatch(/twice/);
    expect(rulesError({ ...ok(), allowedAgents: ["a", " "] }, NOW)).toMatch(/empty/);
    const many = Array.from({ length: MAX_ALLOWED_AGENTS + 1 }, (_, i) => `agent-${i}`);
    expect(rulesError({ ...ok(), allowedAgents: many }, NOW)).toMatch(/At most/);
  });

  it("refuses a token the contract will not hold", () => {
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    expect(rulesError({ ...ok(), token: AXON }, NOW)).toMatch(/token/);
  });
});

describe("keys the contract uses", () => {
  it("are the keccak256 of the id, stable and trimmed", () => {
    expect(agentKey("research-agent")).toBe(agentKey(" research-agent "));
    expect(agentKey("research-agent")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(taskKey("t1")).not.toBe(taskKey("t2"));
  });

  it("the day is the UTC calendar day", () => {
    expect(utcDay(86_400 * 3 - 1)).toBe(2);
    expect(utcDay(86_400 * 3)).toBe(3);
  });
});
