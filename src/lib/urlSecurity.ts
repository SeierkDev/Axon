import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set(["localhost"]);
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:db8::") ||
    normalized === "2001:db8::" ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:10:") ||
    normalized.startsWith("100:") ||
    !/^[23]/.test(normalized)
  );
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

interface ResolvedPublicUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function resolvePublicHttpUrl(rawUrl: string): Promise<ResolvedPublicUrl | string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "endpoint must be a valid URL";
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return "endpoint must use http or https";
  }

  const hostname = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return "endpoint host is not allowed";
  }

  if (isIP(hostname)) {
    return isBlockedAddress(hostname)
      ? "endpoint host is not allowed"
      : { url, address: hostname, family: isIP(hostname) as 4 | 6 };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return "endpoint host could not be resolved";
  }

  if (records.length === 0 || records.some((record) => isBlockedAddress(record.address))) {
    return "endpoint host resolves to a private or reserved address";
  }

  const record = records[0];
  if (!record || (record.family !== 4 && record.family !== 6)) {
    return "endpoint host could not be resolved";
  }
  return { url, address: record.address, family: record.family };
}

export async function validatePublicHttpUrl(rawUrl: string): Promise<string | null> {
  const resolved = await resolvePublicHttpUrl(rawUrl);
  return typeof resolved === "string" ? resolved : null;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k, v]));
  return headers;
}

function bodyToBuffer(body?: BodyInit | null): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("publicHttpFetch only supports string, URLSearchParams, ArrayBuffer, or typed-array request bodies");
}

export interface PublicHttpFetchInit extends RequestInit {
  maxResponseBytes?: number;
}

export async function publicHttpFetch(rawUrl: string, init: PublicHttpFetchInit = {}): Promise<Response> {
  const resolved = await resolvePublicHttpUrl(rawUrl);
  if (typeof resolved === "string") {
    throw new Error(resolved);
  }

  const { url, address, family } = resolved;
  const headers = headersToRecord(init.headers);
  const body = bodyToBuffer(init.body);
  const client = url.protocol === "https:" ? https : http;
  const method = init.method ?? "GET";
  const maxResponseBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }

    const req = client.request(
      url,
      {
        method,
        headers,
        signal: init.signal ?? undefined,
        servername: url.hostname,
        // Pin the connection to the address validated above (SSRF guard: the
        // socket must connect to what we checked, not a second DNS answer).
        // Node 20+'s happy-eyeballs path calls lookup with { all: true } and
        // expects an ARRAY — returning a bare string there makes net read
        // addresses[0].address as undefined and throw ERR_INVALID_IP_ADDRESS
        // ("Invalid IP address: undefined"), so honor both callback shapes.
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(
              null,
              [{ address, family }],
            );
          } else {
            callback(null, address, family);
          }
        },
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value));
          }
        }

        let bytesRead = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => {
              bytesRead += chunk.byteLength;
              if (bytesRead > maxResponseBytes) {
                const err = new Error(`Response exceeded ${maxResponseBytes} byte limit`);
                controller.error(err);
                res.destroy(err);
                req.destroy(err);
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on("end", () => {
              controller.close();
            });
            res.on("error", (err) => {
              controller.error(err);
            });
          },
          cancel() {
            res.destroy();
            req.destroy();
          },
        });

        resolve(new Response(stream, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage,
          headers: responseHeaders,
        }));
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
