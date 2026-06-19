// Next.js instrumentation hook — runs once at server startup before any request.
// Used to initialise the Turso embedded replica sync when DATABASE_URL is set.
//
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Only run in the Node.js runtime (not Edge), and only once per process.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Global crash guard. A background Axon Build makes 6+ long streaming LLM calls
  // over several minutes; a single stray unhandled promise rejection (e.g. a socket
  // hiccup mid-stream) would otherwise crash the entire Node process on Node 15+,
  // killing every in-flight build with a 502. Log it — so the root cause is still
  // visible in the Railway logs — but keep the server (and the build) alive.
  const g = globalThis as typeof globalThis & { __axonCrashGuard?: boolean };
  if (!g.__axonCrashGuard) {
    g.__axonCrashGuard = true;
    process.on("unhandledRejection", (reason) => {
      console.error(
        "[process] unhandledRejection (kept alive):",
        reason instanceof Error ? (reason.stack ?? reason.message) : reason,
      );
    });
    process.on("uncaughtException", (err) => {
      console.error("[process] uncaughtException (kept alive):", err.stack ?? err.message);
    });
  }

  const { isTursoConfigured, initTursoSync } = await import("./src/lib/db-turso");

  if (isTursoConfigured()) {
    try {
      await initTursoSync();
      console.log("[db] Turso embedded replica synced and ready");
    } catch (err) {
      // Log but don't crash the app — local replica may still have usable data
      console.error("[db] Turso sync failed at startup:", err instanceof Error ? err.message : err);
    }
  }
}
