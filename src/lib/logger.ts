import { sendDiscordAlert } from "./discord";
import { getRequestId } from "./requestContext";
import { getTraceId } from "./tracing";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[redacted]";
// Solana base58 addresses: 32-44 chars, no 0/O/I/l
const BASE58_WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AXON_KEY_PREFIX = "axon_sk";

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("keyhash") ||
    normalized.includes("key_hash") ||
    normalized.includes("token")
  );
}

function scrubStringValue(value: string): string {
  if (value.startsWith(`${AXON_KEY_PREFIX}_`) || value.startsWith(`${AXON_KEY_PREFIX}-`)) {
    return `${value.slice(0, 12)}[redacted]`;
  }
  if (BASE58_WALLET_RE.test(value)) {
    return `${value.slice(0, 8)}…`;
  }
  return value;
}

function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
    };
  }
  return { message: String(err) };
}

function sanitize(value: unknown, parentKey = ""): unknown {
  if (parentKey && shouldRedactKey(parentKey)) return REDACTED;
  if (value instanceof Error) return serializeError(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return scrubStringValue(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));

  const output: LogFields = {};
  for (const [key, nested] of Object.entries(value as LogFields)) {
    output[key] = sanitize(nested, key);
  }
  return output;
}

function write(level: LogLevel, event: string, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel()]) return;

  const requestId = getRequestId();
  const traceId = getTraceId();
  const sanitizedFields = fields ? (sanitize(fields) as LogFields) : undefined;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    msg: message,
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(sanitizedFields ?? {}),
  };

  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
    void sendDiscordAlert(event, message, sanitizedFields).catch(() => {});
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, message: string, fields?: LogFields) => write("debug", event, message, fields),
  info: (event: string, message: string, fields?: LogFields) => write("info", event, message, fields),
  warn: (event: string, message: string, fields?: LogFields) => write("warn", event, message, fields),
  error: (event: string, message: string, fields?: LogFields) => write("error", event, message, fields),
};
