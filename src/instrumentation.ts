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

    // The burn fires from here rather than from a cron. A cron starts a container per run, so
    // "due" turned into "due, then some minutes later", which is how three burns in a row came to
    // be fired by hand first. This loop is already awake and goes the second the pot allows it.
    try {
      const { startBurnLoop } = await import("./lib/burnLoop");
      startBurnLoop();
    } catch {
      /* Never block startup on the burn loop */
    }

    // Pick up paid builds a restart interrupted (deploys kill the in-flight
    // pipeline; the job rows are durable). Fire-and-forget: each resumed
    // pipeline runs in the background exactly like a fresh one.
    try {
      const { resumeInterruptedBuilds } = await import("./lib/buildPipeline");
      resumeInterruptedBuilds();
    } catch {
      /* Build resume is best-effort — never block server startup on it */
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

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const isTurso = databaseUrl.startsWith("libsql://") || databaseUrl.startsWith("libsqls://");

  const checks: ConfigCheck[] = [
    {
      name: "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS",
      required: true,
      present: hasEnv("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS"),
      hint: "Set to the EVM address that receives payments (your treasury wallet).",
    },
    {
      name: "AXON_RPC_URL",
      required: false,
      present: hasEnv("AXON_RPC_URL"),
      hint: "Overrides the default Robinhood Chain node. Unset is fine: the public node is used.",
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
