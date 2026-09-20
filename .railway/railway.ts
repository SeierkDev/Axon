import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Axon = github("SeierkDev/Axon", { checkSuites: false });

  const axonVolume = volume("axon-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  const cronReproducibility = service("cron-reproducibility", {
    source: Axon,
    start: "curl -s -f -X POST https://axon-agents.com/api/cron/reproducibility -H \"Authorization: Bearer 3a8a9e5ecee1cd7ae79767940b6a11c3ed8c21809a61b36d9b3a414db4766152\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 9,21 * * *", restartPolicyType: "NEVER" },
  });
  const cronBurn = service("cron-burn", {
    source: Axon,
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/burn -H \"Authorization: Bearer $CRON_SECRET\"'",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 0 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronBurnEngine = service("cron-burn-engine", {
    source: Axon,
    // EU West like everything else: the curl crosses the Atlantic otherwise, for no reason.
    replicas: { "europe-west4-drams3a": 1 },
    // The secret is read from the environment rather than written here, so rotating it does not
    // mean editing this file and cannot leave a live key sitting in the repo.
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/burn-engine -H \"Authorization: Bearer $CRON_SECRET\"'",
    // Every five minutes against the pot's thirty minute interval: this does not burn more often,
    // it only means a burn goes out soon after it is allowed instead of up to half an hour late.
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const axonPresence = service("axon-presence", {
    source: Axon,
    replicas: { "europe-west4-drams3a": 1 },
    env: { PRESENCE_ALLOWED_ORIGINS: preserve() },
  });
  const Axon2 = service("Axon", {
    source: Axon,
    build: "npm run build",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["axon-agents.com"],
    networking: { privateNetworkEndpoint: "axon" },
    volumeMounts: { "/data": axonVolume },
    env: { ANTHROPIC_API_KEY: preserve(), AXON_RPC_URL: preserve(), AXON_SUCCESS_RATE_WINDOW_HOURS: preserve(), BOT_PRIVATE_KEY: preserve(), CORS_ORIGIN: preserve(), CRON_SECRET: preserve(), DATABASE_PATH: preserve(), DEV_WALLET: preserve(), GROW_AGENT_ID: preserve(), GROW_AGENT_KEY: preserve(), GROW_AGENT_SECRET: preserve(), GROW_SECRET: preserve(), LOG_LEVEL: preserve(), NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: preserve(), NEXT_PUBLIC_PRESENCE_URL: preserve(), NEXT_PUBLIC_RPC_URL: preserve(), NODE_ENV: preserve(), NODE_OPTIONS: preserve(), OPENAI_API_KEY: preserve(), REFUND_SIGNER_PRIVATE_KEY: preserve(), REPRODUCE_SECRET: preserve(), SEED_SECRET: preserve(), TELEGRAM_BOT_TOKEN: preserve(), TELEGRAM_CHANNEL_ID: preserve(), TRUST_PROXY_HEADERS: preserve(), UCP_AGENT_PRIVATE_KEY: preserve(), XAI_API_KEY: preserve() },
  });
  const cronRetention = service("cron-retention", {
    source: Axon,
    start: "curl -s -X POST https://axon-agents.com/api/cron/retention -H \"Authorization: Bearer 3a8a9e5ecee1cd7ae79767940b6a11c3ed8c21809a61b36d9b3a414db4766152\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 2 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronAutonomy = service("cron-autonomy", {
    source: Axon,
    start: "curl -fsS -X POST -H \"Authorization: Bearer $CRON_SECRET\" https://axon-agents.com/api/cron/autonomy",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 7 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronAgents = service("cron-agents", {
    source: Axon,
    start: "curl -s -X POST https://axon-agents.com/api/cron/demo-agents -H \"Authorization: Bearer $CRON_SECRET\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 6 * * *", restartPolicyType: "NEVER" },
    networking: { privateNetworkEndpoint: "demo-agents" },
    env: { CRON_SECRET: preserve() },
  });
  const cronDemo = service("cron-demo", {
    source: Axon,
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/demo-activity -H \"Authorization: Bearer $CRON_SECRET\"'",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronHealth = service("cron-health", {
    source: Axon,
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/health -H \"Authorization: Bearer $CRON_SECRET\"'",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronTelegram = service("cron-telegram", {
    source: Axon,
    start: "curl -X POST https://axon-agents.com/api/cron/telegram-feed -H \"Authorization: Bearer 3a8a9e5ecee1cd7ae79767940b6a11c3ed8c21809a61b36d9b3a414db4766152\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronWebhooks = service("cron-webhooks", {
    source: Axon,
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/webhooks -H \"Authorization: Bearer $CRON_SECRET\"'",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });

  return project("Axon", {
    resources: [cronReproducibility, cronBurn, cronBurnEngine, axonPresence, Axon2, cronRetention, cronAutonomy, cronAgents, cronDemo, cronHealth, cronTelegram, cronWebhooks, axonVolume],
  });
});
