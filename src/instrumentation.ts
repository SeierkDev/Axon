// Next.js instrumentation hook — runs once on server startup before any
// requests are served. Validates required env vars so the process fails fast
// with a clear checklist instead of crashing mid-request.

export async function register() {
  // Only run in the Node.js server context, not in the Edge runtime
  if (process.env.NEXT_RUNTIME !== "edge") {
    assertReadyConfig();
    const { initTursoSync } = await import("./lib/db-turso");
    await initTursoSync();

    // Run the background worker in-process (unless explicitly disabled), so a
    // single-container deployment processes queued tasks and reports its
    // heartbeat without a separate worker service. Fire-and-forget so it doesn't
    // block the server from serving requests.
    if (process.env.AXON_DISABLE_INLINE_WORKER !== "1") {
      const { startWorkerLoops } = await import("./workers/index");
      void startWorkerLoops();
    }
  }
}

interface ConfigCheck {
  name: string;
  required: boolean;
  present: boolean;
  hint: string;
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export function assertReadyConfig(): void {
  // In test or CI environments, skip startup validation
  if (process.env.NODE_ENV !== "production") return;

  const useMockPayments = process.env.AXON_PAYMENT_VERIFIER === "mock";
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const isTurso = databaseUrl.startsWith("libsql://") || databaseUrl.startsWith("libsqls://");

  const checks: ConfigCheck[] = [
    {
      name: "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS",
      required: true,
      present: hasEnv("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS"),
      hint: "Set to the Solana wallet address that receives x402 payments (e.g. your treasury wallet).",
    },
    {
      name: "HELIUS_API_KEY",
      required: !useMockPayments,
      present: hasEnv("HELIUS_API_KEY") || useMockPayments,
      hint: "Get a free API key at https://helius.dev. Skip by setting AXON_PAYMENT_VERIFIER=mock (dev only).",
    },
    {
      name: "SEED_SECRET",
      required: true,
      present: hasEnv("SEED_SECRET"),
      hint: "Generate with: openssl rand -hex 32  — used as the scrypt salt for API key hashing.",
    },
    {
      name: "DATABASE_PATH or DATABASE_URL",
      required: true,
      present: hasEnv("DATABASE_PATH") || hasEnv("DATABASE_URL"),
      hint: "Set DATABASE_PATH to an absolute path on a persistent volume (e.g. /data/axon.db), or DATABASE_URL=libsql://... for Turso.",
    },
    {
      name: "DATABASE_AUTH_TOKEN",
      required: isTurso,
      present: hasEnv("DATABASE_AUTH_TOKEN"),
      hint: "Required when DATABASE_URL is a Turso libsql endpoint. Get it from the Turso dashboard.",
    },
    {
      name: "DATABASE_PATH (absolute path required for Turso replica)",
      required: isTurso,
      present: isTurso
        ? hasEnv("DATABASE_PATH") && process.env.DATABASE_PATH!.trim().startsWith("/")
        : true,
      hint: "When using Turso, DATABASE_PATH must be an absolute path for the local replica file (e.g. /data/axon-replica.db).",
    },
  ];

  const failing = checks.filter((c) => c.required && !c.present);
  if (failing.length === 0) return;

  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║          Axon startup failed: missing configuration          ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    "The following required environment variables are not set:",
    "",
    ...failing.map((c) => [
      `  ✗ ${c.name}`,
      `    ${c.hint}`,
      "",
    ].join("\n")),
    "Set these in your .env.local (development) or deployment environment (production).",
    "",
  ];

  throw new Error(lines.join("\n"));
}
