import { spawn, type ChildProcess } from "node:child_process";

const PORT = Number.parseInt(process.env.AXON_VERIFY_PORT ?? "3100", 10);
const ENDPOINT = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = 20_000;
const MOCK_PAYMENT_RECEIVER = "11111111111111111111111111111111";

function run(
  label: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(env ?? {}) },
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function startServer(): ChildProcess {
  console.log(`\n==> start temporary server on ${ENDPOINT}`);
  return spawn("npm", ["run", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      AXON_PAYMENT_VERIFIER: "mock",
      AXON_ALLOW_EPHEMERAL_DB: "true",
      NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS:
        process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS || MOCK_PAYMENT_RECEIVER,
    },
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
}

async function waitForServer(server: ChildProcess): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (server.exitCode !== null) {
      throw new Error(`Temporary server exited early with code ${server.exitCode}`);
    }

    try {
      const res = await fetch(`${ENDPOINT}/api/capabilities`);
      if (res.ok) return;
    } catch {
      // Server is still warming up.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Temporary server did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;

  console.log(`\n==> stop temporary server on ${ENDPOINT}`);
  server.kill("SIGINT");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (server.exitCode === null) server.kill("SIGTERM");
      resolve();
    }, 5_000);

    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  let server: ChildProcess | null = null;

  try {
    await run("check local environment", "npm", ["run", "check:local"]);
    await run("database migrations", "npm", ["run", "migrate:db"]);
    await run("worker shutdown contract", "npm", ["run", "contract:worker-shutdown"]);
    await run("webhook health contract", "npm", ["run", "contract:webhook-health"]);
    await run("build", "npm", ["run", "build"]);

    server = startServer();
    await waitForServer(server);

    const endpointEnv = {
      AXON_CONTRACT_ENDPOINT: ENDPOINT,
      AXON_SMOKE_ENDPOINT: ENDPOINT,
      AXON_PAYMENT_VERIFIER: "mock",
      AXON_ALLOW_EPHEMERAL_DB: "true",
      NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS:
        process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS || MOCK_PAYMENT_RECEIVER,
    };

    await run("health contract", "npm", ["run", "contract:health"], endpointEnv);
    await run("API error contract", "npm", ["run", "contract:api-errors"], endpointEnv);
    await run("auth/task contract", "npm", ["run", "contract:auth-task"], endpointEnv);
    await run("payment contract", "npm", ["run", "contract:payments"], endpointEnv);
    await run("first task smoke", "npm", ["run", "smoke:first-task"], endpointEnv);
  } finally {
    if (server) await stopServer(server);
    await run("cleanup demo and smoke data", "npm", ["run", "cleanup:demo"]);
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint: ENDPOINT,
    note: "Temporary server stopped and demo/smoke data cleanup ran.",
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
