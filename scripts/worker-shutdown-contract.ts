import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export {};

const READY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 8_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "axon-worker-"));
  const dbPath = path.join(tempDir, "worker.db");
  const output: string[] = [];

  const child = spawn("./node_modules/.bin/tsx", ["--env-file=.env.local", "src/workers/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      LOG_LEVEL: "info",
      AXON_ALLOW_EPHEMERAL_DB: "true",
      AXON_WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
      AXON_WORKER_STANDALONE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < READY_TIMEOUT_MS) {
      if (child.exitCode !== null) {
        throw new Error(`Worker exited before startup with code ${child.exitCode}`);
      }
      if (output.join("").includes('"event":"worker.started"')) break;
      await wait(100);
    }

    if (!output.join("").includes('"event":"worker.started"')) {
      throw new Error("Worker did not log worker.started before timeout");
    }

    child.kill("SIGTERM");

    const exitStartedAt = Date.now();
    while (Date.now() - exitStartedAt < EXIT_TIMEOUT_MS) {
      if (child.exitCode !== null) break;
      await wait(100);
    }

    if (child.exitCode === null) {
      child.kill("SIGKILL");
      throw new Error("Worker did not exit after SIGTERM");
    }

    if (child.exitCode !== 0) {
      throw new Error(`Worker exited with code ${child.exitCode} after SIGTERM`);
    }

    const logs = output.join("");
    if (!logs.includes('"event":"worker.shutdown_started"') || !logs.includes('"event":"worker.shutdown_complete"')) {
      throw new Error("Worker did not emit shutdown lifecycle logs");
    }

    console.log(JSON.stringify({
      ok: true,
      signal: "SIGTERM",
      exitCode: child.exitCode,
    }, null, 2));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
