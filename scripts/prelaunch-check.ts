import { existsSync } from "fs";
import { dirname, isAbsolute } from "path";
import { PublicKey } from "@solana/web3.js";

type Level = "error" | "warn";
type Mode = "local" | "production";

interface Finding {
  level: Level;
  message: string;
}

const findings: Finding[] = [];
const mode = parseMode();

function parseMode(): Mode {
  const raw = process.argv[2] ?? "--production";
  if (raw === "--local") return "local";
  if (raw === "--production") return "production";
  console.error(`Unknown check mode: ${raw}`);
  console.error("Use --local or --production");
  process.exit(1);
}

function add(level: Level, message: string) {
  findings.push({ level, message });
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string, reason: string) {
  if (!env(name)) add("error", `${name} is required: ${reason}`);
}

function warnEnv(name: string, reason: string) {
  if (!env(name)) add("warn", `${name} is not set: ${reason}`);
}

function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function checkDatabase() {
  const dbPath = env("DATABASE_PATH");
  if (!dbPath) {
    if (mode === "production") {
      add("error", "DATABASE_PATH is required in production; set it to a durable absolute path such as a mounted volume");
    }
    return;
  }

  if (mode === "production" && !isAbsolute(dbPath)) {
    add("error", "DATABASE_PATH is relative; use an absolute durable volume path in production");
  }

  const dir = dirname(dbPath);
  if (mode === "production" && !existsSync(dir)) {
    add("warn", `DATABASE_PATH directory does not exist yet: ${dir}`);
  }
}

function checkPayments() {
  if (mode === "production") {
    requireEnv("HELIUS_API_KEY", "paid task, x402, and MPP payment verification need Solana RPC access");
    requireEnv("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS", "x402 and MPP payment requirements need a payment receiver wallet");
  }

  const wallet = env("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS");
  if (wallet && !isValidPublicKey(wallet)) {
    add("error", "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS must be a valid Solana public key");
  }

  if (env("NEXT_PUBLIC_WALLET_ADDRESS")) {
    add("warn", "NEXT_PUBLIC_WALLET_ADDRESS is deprecated; use NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS");
  }

  const network = env("SOLANA_NETWORK") || "mainnet-beta";
  if (!["mainnet-beta", "mainnet", "devnet"].includes(network)) {
    add("warn", `SOLANA_NETWORK is '${network}'; expected mainnet-beta or devnet`);
  }

  const refundKey = env("REFUND_SIGNER_PRIVATE_KEY");
  if (!refundKey) {
    return;
  }

  try {
    const parsed = JSON.parse(refundKey) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      add("error", "REFUND_SIGNER_PRIVATE_KEY must be a JSON array of 64 bytes");
      return;
    }
  } catch {
    add("error", "REFUND_SIGNER_PRIVATE_KEY must be valid JSON");
  }
}

function checkInference() {
  if (mode === "production") {
    requireEnv("ANTHROPIC_API_KEY", "seeded built-in agents default to Anthropic and the worker needs this to process paid hosted tasks");
    warnEnv("OPENAI_API_KEY", "only needed if you register OpenAI-backed agents");
  }
}

function checkSecrets() {
  const seedSecret = env("SEED_SECRET");
  if (!seedSecret) {
    if (mode === "production") {
      add("warn", "SEED_SECRET is not set; /api/seed/daily will be disabled");
    }
  } else if (seedSecret === "axon-daily-seed-2026" || seedSecret.length < 32) {
    add(
      mode === "production" ? "error" : "warn",
      "SEED_SECRET must be a long random production secret, not the local placeholder"
    );
  }

  if (mode === "production" && env("TRUST_PROXY_HEADERS") !== "true") {
    add("warn", "TRUST_PROXY_HEADERS is not true; rate limits will group proxied traffic as 'direct'");
  }
}

function printResults() {
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");

  for (const finding of findings) {
    const prefix = finding.level === "error" ? "ERROR" : "WARN";
    console.log(`${prefix}: ${finding.message}`);
  }

  if (findings.length === 0) {
    console.log(`${mode} check passed with no findings.`);
  } else {
    console.log(`${mode} check found ${errors.length} error(s), ${warnings.length} warning(s).`);
  }

  if (errors.length > 0) process.exit(1);
}

checkDatabase();
checkPayments();
checkInference();
checkSecrets();
printResults();
