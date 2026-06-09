// Next.js instrumentation hook — runs once at server startup before any request.
// Used to initialise the Turso embedded replica sync when DATABASE_URL is set.
//
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Only run in the Node.js runtime (not Edge), and only once per process.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

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
