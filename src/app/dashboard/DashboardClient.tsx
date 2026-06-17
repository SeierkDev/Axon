"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";

type Agent = {
  agentId: string;
  name: string;
  capabilities: string[];
  price?: string;
  reputation?: number;
  walletAddress?: string;
  endpoint?: string;
  provider: string;
};

type Task = {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  status: "payment_pending" | "queued" | "running" | "completed" | "failed";
  payment?: string;
  output?: string;
  error?: string;
  createdAt: string;
};

type WorkflowStep = {
  stepIndex: number;
  agentId: string;
  taskId: string;
  status: Task["status"];
  input: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

type Workflow = {
  workflowId: string;
  fromAgent: string;
  agents: string[];
  initialTask: string;
  status: "running" | "completed" | "failed";
  currentStep: number;
  steps: WorkflowStep[];
  finalOutput?: string;
  createdAt: string;
  completedAt?: string;
};

type Balance = {
  totalEarned: number;
  totalSpent: number;
  totalEscrow: number;
  netBalance: number;
  tasksPaid: number;
};

type Channel = {
  channelId: string;
  ownerAddress: string;
  balanceUsdc: number;
  status: string;
  createdAt: string;
};

type ApiKey = {
  keyId: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type BudgetStatus = {
  budgetId: string;
  agentId: string;
  maxPerCallUsdc?: number;
  maxPerDayUsdc?: number;
  spentTodayUsdc: number;
  remainingTodayUsdc: number | null;
  status: string;
};

type SpendThreshold = {
  thresholdId: string;
  agentId: string;
  thresholdUsdc: number;
  windowHours: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type SpendAlert = {
  alertId: string;
  agentId: string;
  amountUsdc: number;
  thresholdUsdc: number;
  windowHours: number;
  firedAt: string;
};

type ThresholdStatus = {
  threshold: SpendThreshold;
  windowSpendUsdc: number;
  lastAlert: SpendAlert | null;
};

type DashboardData = {
  walletAddress: string;
  keyId: string;
  agents: Agent[];
  tasksByAgent: Record<string, Task[]>;
  workflowsByAgent: Record<string, Workflow[]>;
  balances: Record<string, Balance>;
  channels: Channel[];
  keys: ApiKey[];
  budgets: Record<string, BudgetStatus | null>;
  thresholds: Record<string, ThresholdStatus | null>;
};

type Toast = { id: string; type: "success" | "error"; message: string };

const STORAGE_KEY = "axon.dashboard.apiKey";
const TASK_STATUS_STYLE = {
  payment_pending: "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900 dark:bg-purple-950/30 dark:text-purple-400",
  queued: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400",
  running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
  completed: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400",
  failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
};
const WORKFLOW_STATUS_STYLE = {
  running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
  completed: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400",
  failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
};

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "0.0000";
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

export default function DashboardClient() {
  const [apiKey, setApiKey] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const apiKeyRef = useRef("");
  const agentsRef = useRef<Agent[]>([]);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [requeueing, setRequeueing] = useState<Set<string>>(new Set());
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, { maxPerCall: string; maxPerDay: string }>>({});
  const [savingBudget, setSavingBudget] = useState<Set<string>>(new Set());
  const [clearingBudget, setClearingBudget] = useState<Set<string>>(new Set());
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<string, { amount: string; hours: string }>>({});
  const [savingThreshold, setSavingThreshold] = useState<Set<string>>(new Set());
  const [clearingThreshold, setClearingThreshold] = useState<Set<string>>(new Set());
  const [editExpanded, setEditExpanded] = useState<Set<string>>(new Set());
  const [editDrafts, setEditDrafts] = useState<Record<string, { name: string; capabilities: string; price: string; endpoint: string }>>({});
  const [savingEdit, setSavingEdit] = useState<Set<string>>(new Set());
  const [taskDisplayLimit, setTaskDisplayLimit] = useState(8);
  const [taskFetchLimit, setTaskFetchLimit] = useState(8);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyReveal, setNewKeyReveal] = useState<string | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);

  function addToast(type: Toast["type"], message: string) {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  const loadKey = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const me = await apiGet<{ walletAddress: string; keyId: string; agents: Agent[] }>("/api/auth/me", key);
      const taskEntries = await Promise.all(
        me.agents.map(async (agent) => {
          const res = await apiGet<{ tasks: Task[] }>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/tasks?role=both&limit=8`,
            key
          );
          return [agent.agentId, res.tasks] as const;
        })
      );
      const balanceEntries = await Promise.all(
        me.agents.map(async (agent) => {
          const balance = await apiGet<Balance>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/balance`,
            key
          );
          return [agent.agentId, balance] as const;
        })
      );
      const workflowEntries = await Promise.all(
        me.agents.map(async (agent) => {
          const res = await apiGet<{ workflows: Workflow[] }>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/workflows?limit=8`,
            key
          );
          return [agent.agentId, res.workflows] as const;
        })
      );
      const channelRes = await apiGet<{ channels: Channel[] }>(
        `/api/mpp/channels?owner=${encodeURIComponent(me.walletAddress)}`,
        key
      );
      const keysRes = await apiGet<{ keys: ApiKey[] }>("/api/auth/keys", key);
      const [budgetEntries, thresholdEntries] = await Promise.all([
        Promise.all(
          me.agents.map(async (agent) => {
            try {
              const res = await apiGet<{ budget: BudgetStatus | null }>(
                `/api/agents/${encodeURIComponent(agent.agentId)}/budget`,
                key
              );
              return [agent.agentId, res.budget] as const;
            } catch {
              return [agent.agentId, null] as const;
            }
          })
        ),
        Promise.all(
          me.agents.map(async (agent) => {
            try {
              const res = await apiGet<ThresholdStatus & { threshold: SpendThreshold | null }>(
                `/api/agents/${encodeURIComponent(agent.agentId)}/threshold`,
                key
              );
              return [agent.agentId, res.threshold ? res : null] as const;
            } catch {
              return [agent.agentId, null] as const;
            }
          })
        ),
      ]);

      const budgets = Object.fromEntries(budgetEntries);
      const thresholds = Object.fromEntries(thresholdEntries);
      setBudgetDrafts(
        Object.fromEntries(
          me.agents.map((agent) => {
            const b = budgets[agent.agentId];
            return [agent.agentId, {
              maxPerCall: b?.maxPerCallUsdc != null ? String(b.maxPerCallUsdc) : "",
              maxPerDay: b?.maxPerDayUsdc != null ? String(b.maxPerDayUsdc) : "",
            }];
          })
        )
      );
      setThresholdDrafts(
        Object.fromEntries(
          me.agents.map((agent) => {
            const t = thresholds[agent.agentId];
            return [agent.agentId, {
              amount: t?.threshold ? String(t.threshold.thresholdUsdc) : "",
              hours: t?.threshold ? String(t.threshold.windowHours) : "24",
            }];
          })
        )
      );

      setData({
        walletAddress: me.walletAddress,
        keyId: me.keyId,
        agents: me.agents,
        tasksByAgent: Object.fromEntries(taskEntries),
        workflowsByAgent: Object.fromEntries(workflowEntries),
        balances: Object.fromEntries(balanceEntries),
        channels: channelRes.channels,
        keys: keysRes.keys,
        budgets,
        thresholds,
      });
      agentsRef.current = me.agents;
      setLastRefreshed(new Date());
    } catch (err) {
      setData(null);
      const msg = err instanceof Error ? err.message : "Dashboard could not load";
      setError(msg);
      addToast("error", msg.length > 60 ? msg.slice(0, 58) + "…" : msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { apiKeyRef.current = apiKey; }, [apiKey]);

  const refreshLive = useCallback(async () => {
    const key = apiKeyRef.current;
    const agents = agentsRef.current;
    if (!key || !agents.length) return;
    setAutoRefreshing(true);
    try {
      const [taskEntries, workflowEntries, balanceEntries] = await Promise.all([
        Promise.all(agents.map(async (agent) => {
          const res = await apiGet<{ tasks: Task[] }>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/tasks?role=both&limit=8`, key
          );
          return [agent.agentId, res.tasks] as const;
        })),
        Promise.all(agents.map(async (agent) => {
          const res = await apiGet<{ workflows: Workflow[] }>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/workflows?limit=8`, key
          );
          return [agent.agentId, res.workflows] as const;
        })),
        Promise.all(agents.map(async (agent) => {
          const balance = await apiGet<Balance>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/balance`, key
          );
          return [agent.agentId, balance] as const;
        })),
      ]);
      setData((prev) => prev ? {
        ...prev,
        tasksByAgent: Object.fromEntries(taskEntries),
        workflowsByAgent: Object.fromEntries(workflowEntries),
        balances: Object.fromEntries(balanceEntries),
      } : prev);
      setLastRefreshed(new Date());
    } catch {
      // silent — auto-refresh failures don't disrupt the UI
    } finally {
      setAutoRefreshing(false);
    }
  }, []);

  // Polling fallback — reduced to 30s since SSE handles the fast path
  useEffect(() => {
    const timer = setInterval(() => void refreshLive(), 30_000);
    return () => clearInterval(timer);
  }, [refreshLive]);

  // SSE subscription — push task updates without waiting for the poll interval.
  // Reconnects with exponential backoff (1s → 2s → 4s → … capped at 30s) so a
  // server restart or brief network drop self-heals without a page refresh.
  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    let backoffMs = 1_000;

    const connect = () => {
      if (cancelled) return;
      const controller = new AbortController();

      void (async () => {
        try {
          const res = await fetch("/api/events", {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            scheduleReconnect(controller);
            return;
          }
          // Connected — reset backoff
          backoffMs = 1_000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const chunks = buf.split("\n\n");
            buf = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const line = chunk.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const event = JSON.parse(line.slice(6)) as { type: string };
                if (event.type === "task.updated") void refreshLive();
              } catch { /* ignore malformed SSE frames */ }
            }
          }
          // Stream ended cleanly — reconnect
          scheduleReconnect(controller);
        } catch {
          // AbortError on cleanup is expected; everything else reconnects
          scheduleReconnect(controller);
        }
      })();

      return controller;
    };

    const scheduleReconnect = (prev: AbortController) => {
      prev.abort();
      if (cancelled) return;
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      window.setTimeout(() => { if (!cancelled) connect(); }, delay);
    };

    connect();
    return () => { cancelled = true; };
  }, [apiKey, refreshLive]);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) ?? "";
    if (!saved) return;
    const id = window.setTimeout(() => {
      setApiKey(saved);
      setDraftKey(saved);
      void loadKey(saved);
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadKey]);

  function saveKey() {
    const next = draftKey.trim();
    window.localStorage.setItem(STORAGE_KEY, next);
    setApiKey(next);
    window.setTimeout(() => {
      void loadKey(next);
    }, 0);
  }

  function clearKey() {
    window.localStorage.removeItem(STORAGE_KEY);
    setApiKey("");
    setDraftKey("");
    setData(null);
    setError(null);
  }

  async function revokeKey(keyId: string) {
    if (!apiKey) return;
    setRevoking((prev) => new Set(prev).add(keyId));
    try {
      const res = await fetch(`/api/auth/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        setData((prev) => prev ? { ...prev, keys: prev.keys.filter((k) => k.keyId !== keyId) } : prev);
        addToast("success", "API key revoked");
      } else {
        addToast("error", "Failed to revoke key");
      }
    } catch {
      addToast("error", "Failed to revoke key");
    } finally {
      setRevoking((prev) => { const next = new Set(prev); next.delete(keyId); return next; });
    }
  }

  async function retryTask(taskId: string) {
    if (!apiKey) return;
    setRequeueing((prev) => new Set(prev).add(taskId));
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/requeue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const updated = await res.json() as Task;
        setData((prev) => {
          if (!prev) return prev;
          const tasksByAgent = { ...prev.tasksByAgent };
          for (const agentId of Object.keys(tasksByAgent)) {
            tasksByAgent[agentId] = tasksByAgent[agentId].map((t) =>
              t.taskId === taskId ? updated : t
            );
          }
          return { ...prev, tasksByAgent };
        });
        addToast("success", "Task requeued");
      } else {
        addToast("error", "Failed to requeue task");
      }
    } catch {
      addToast("error", "Failed to requeue task");
    } finally {
      setRequeueing((prev) => { const next = new Set(prev); next.delete(taskId); return next; });
    }
  }

  async function saveBudget(agentId: string) {
    if (!apiKey) return;
    const draft = budgetDrafts[agentId];
    if (!draft) return;
    setSavingBudget((prev) => new Set(prev).add(agentId));
    try {
      const body: Record<string, number> = {};
      const perCall = parseFloat(draft.maxPerCall);
      const perDay = parseFloat(draft.maxPerDay);
      if (!isNaN(perCall) && perCall > 0) body.maxPerCallUsdc = perCall;
      if (!isNaN(perDay) && perDay > 0) body.maxPerDayUsdc = perDay;
      if (Object.keys(body).length === 0) return;
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/budget`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const { budget } = await res.json() as { budget: BudgetStatus };
        setData((prev) => prev ? { ...prev, budgets: { ...prev.budgets, [agentId]: budget } } : prev);
        addToast("success", "Spend limit saved");
      } else {
        addToast("error", "Failed to save spend limit");
      }
    } catch {
      addToast("error", "Failed to save spend limit");
    } finally {
      setSavingBudget((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }

  function toggleEdit(agent: Agent) {
    setEditExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agent.agentId)) {
        next.delete(agent.agentId);
      } else {
        next.add(agent.agentId);
        setEditDrafts((d) => ({
          ...d,
          [agent.agentId]: {
            name: agent.name,
            capabilities: agent.capabilities.join(", "),
            price: agent.price ?? "",
            endpoint: agent.endpoint ?? "",
          },
        }));
      }
      return next;
    });
  }

  async function saveEdit(agentId: string) {
    if (!apiKey) return;
    const draft = editDrafts[agentId];
    if (!draft) return;

    const current = data?.agents.find((a) => a.agentId === agentId);
    const body: Record<string, unknown> = {};

    if (draft.name.trim() !== (current?.name ?? "")) body.name = draft.name.trim();

    const caps = draft.capabilities.split(",").map((c) => c.trim()).filter(Boolean);
    if (JSON.stringify(caps) !== JSON.stringify(current?.capabilities ?? [])) body.capabilities = caps;

    const price = draft.price.trim() || null;
    if (price !== (current?.price ?? null)) body.price = price;

    const endpoint = draft.endpoint.trim() || null;
    if (endpoint !== (current?.endpoint ?? null)) body.endpoint = endpoint;

    if (Object.keys(body).length === 0) {
      addToast("success", "No changes to save");
      setEditExpanded((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
      return;
    }

    setSavingEdit((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json() as Agent;
        setData((prev) => prev ? {
          ...prev,
          agents: prev.agents.map((a) => a.agentId === agentId ? updated : a),
        } : prev);
        setEditExpanded((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
        addToast("success", "Agent updated");
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string };
        addToast("error", err.error ?? "Failed to update agent");
      }
    } catch {
      addToast("error", "Failed to update agent");
    } finally {
      setSavingEdit((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }

  async function clearBudget(agentId: string) {
    if (!apiKey) return;
    setClearingBudget((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/budget`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        setData((prev) => prev ? { ...prev, budgets: { ...prev.budgets, [agentId]: null } } : prev);
        setBudgetDrafts((prev) => ({ ...prev, [agentId]: { maxPerCall: "", maxPerDay: "" } }));
        addToast("success", "Spend limit cleared");
      } else {
        addToast("error", "Failed to clear spend limit");
      }
    } catch {
      addToast("error", "Failed to clear spend limit");
    } finally {
      setClearingBudget((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }

  async function saveThreshold(agentId: string) {
    if (!apiKey) return;
    const draft = thresholdDrafts[agentId];
    if (!draft) return;
    const amount = parseFloat(draft.amount);
    const hours = parseInt(draft.hours, 10);
    if (isNaN(amount) || amount <= 0) { addToast("error", "Enter a valid USDC amount"); return; }
    if (isNaN(hours) || hours < 1) { addToast("error", "Enter a valid window in hours"); return; }
    setSavingThreshold((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/threshold`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ thresholdUsdc: amount, windowHours: hours, enabled: true }),
      });
      if (res.ok) {
        const { threshold } = await res.json() as { threshold: SpendThreshold };
        setData((prev) => {
          if (!prev) return prev;
          const existing = prev.thresholds[agentId];
          const newStatus: ThresholdStatus = {
            threshold,
            windowSpendUsdc: existing?.windowSpendUsdc ?? 0,
            lastAlert: existing?.lastAlert ?? null,
          };
          return { ...prev, thresholds: { ...prev.thresholds, [agentId]: newStatus } };
        });
        addToast("success", "Spend alert saved");
      } else {
        addToast("error", "Failed to save spend alert");
      }
    } catch {
      addToast("error", "Failed to save spend alert");
    } finally {
      setSavingThreshold((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }

  async function clearThreshold(agentId: string) {
    if (!apiKey) return;
    setClearingThreshold((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/threshold`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        setData((prev) => prev ? { ...prev, thresholds: { ...prev.thresholds, [agentId]: null } } : prev);
        setThresholdDrafts((prev) => ({ ...prev, [agentId]: { amount: "", hours: "24" } }));
        addToast("success", "Spend alert cleared");
      } else {
        addToast("error", "Failed to clear spend alert");
      }
    } catch {
      addToast("error", "Failed to clear spend alert");
    } finally {
      setClearingThreshold((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }

  async function createNewKey() {
    if (!apiKey) return;
    setCreatingKey(true);
    try {
      const res = await fetch("/api/auth/keys", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const result = await res.json() as { keyId: string; apiKey: string; keyPrefix: string };
        setNewKeyReveal(result.apiKey);
        // Refresh the keys list
        const keysRes = await apiGet<{ keys: ApiKey[] }>("/api/auth/keys", apiKey);
        setData((prev) => prev ? { ...prev, keys: keysRes.keys } : prev);
        addToast("success", "New key created — copy it now, it won't be shown again");
      } else {
        addToast("error", "Failed to create key");
      }
    } catch {
      addToast("error", "Failed to create key");
    } finally {
      setCreatingKey(false);
    }
  }

  async function loadMoreTasks() {
    if (!apiKey || !data) return;
    const nextDisplay = taskDisplayLimit + 8;

    // Already have enough fetched — just show more
    if (nextDisplay <= allFetchedTasks.length) {
      setTaskDisplayLimit(nextDisplay);
      return;
    }

    // Need to fetch more from the server
    const nextFetch = Math.min(taskFetchLimit + 16, 200);
    setLoadingMoreTasks(true);
    try {
      const taskEntries = await Promise.all(
        data.agents.map(async (agent) => {
          const res = await apiGet<{ tasks: Task[] }>(
            `/api/agents/${encodeURIComponent(agent.agentId)}/tasks?role=both&limit=${nextFetch}`,
            apiKey
          );
          return [agent.agentId, res.tasks] as const;
        })
      );
      setData((prev) => prev ? { ...prev, tasksByAgent: Object.fromEntries(taskEntries) } : prev);
      setTaskFetchLimit(nextFetch);
      setTaskDisplayLimit(nextDisplay);
    } catch {
      addToast("error", "Failed to load more tasks");
    } finally {
      setLoadingMoreTasks(false);
    }
  }

  const totals = useMemo(() => {
    const tasks = data?.agents.flatMap((agent) => data.tasksByAgent[agent.agentId] ?? []) ?? [];
    const uniqueTasks = new Map(tasks.map((task) => [task.taskId, task]));
    const balances = Object.values(data?.balances ?? {});
    const workflows = data?.agents.flatMap((agent) => data.workflowsByAgent[agent.agentId] ?? []) ?? [];
    const uniqueWorkflows = new Map(workflows.map((workflow) => [workflow.workflowId, workflow]));
    return {
      agents: data?.agents.length ?? 0,
      queued: [...uniqueTasks.values()].filter((task) => task.status === "queued").length,
      running: [...uniqueTasks.values()].filter((task) => task.status === "running").length,
      activeWorkflows: [...uniqueWorkflows.values()].filter((workflow) => workflow.status === "running").length,
      earned: balances.reduce((sum, balance) => sum + balance.totalEarned, 0),
    };
  }, [data]);

  const allFetchedTasks = useMemo(() => {
    if (!data) return [];
    const tasks = data.agents.flatMap((agent) => data.tasksByAgent[agent.agentId] ?? []);
    return [...new Map(tasks.map((task) => [task.taskId, task])).values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [data]);

  const recentTasks = useMemo(
    () => allFetchedTasks.slice(0, taskDisplayLimit),
    [allFetchedTasks, taskDisplayLimit]
  );

  const recentWorkflows = useMemo(() => {
    if (!data) return [];
    const workflows = data.agents.flatMap((agent) => data.workflowsByAgent[agent.agentId] ?? []);
    return [...new Map(workflows.map((workflow) => [workflow.workflowId, workflow])).values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 6);
  }, [data]);

  const firstAgentId = data?.agents[0]?.agentId ?? "my-agent";

  return (
    <div className="space-y-6">
      {/* Toast stack */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium animate-fade-up ${
              t.type === "success"
                ? "bg-white dark:bg-gray-900 border-green-200 dark:border-green-800 text-green-800 dark:text-green-400"
                : "bg-white dark:bg-gray-900 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400"
            }`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${t.type === "success" ? "bg-green-500" : "bg-red-500"}`} />
            {t.message}
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5">
        <div className="flex flex-col xl:flex-row xl:items-end gap-4">
          <div className="flex-1">
            <label htmlFor="api-key" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              API key
            </label>
            <input
              id="api-key"
              value={draftKey}
              onChange={(event) => setDraftKey(event.target.value)}
              placeholder="axon_..."
              type="password"
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500 dark:focus:border-gray-500"
            />
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Stored in this browser for this dashboard.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveKey}
              className="px-4 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors"
            >
              Load
            </button>
            <button
              type="button"
              onClick={() => loadKey(apiKey)}
              disabled={!apiKey || loading}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-40 transition-colors"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={clearKey}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 text-sm font-medium hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
            >
              Clear
            </button>
            <Link
              href="/docs/getting-started"
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              API key setup
            </Link>
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>

      {loading && <DashboardSkeleton />}

      {!loading && !data && !error && (
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8">
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">FIRST RUN</p>
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-3">Get to a completed task</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xl mb-6">
              Create an API key with wallet auth, register one free agent, then process its first queued task from your agent process.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Link
                href="/onboarding"
                className="mb-4 flex items-center justify-between rounded-lg border border-gray-900 bg-gray-900 dark:border-white dark:bg-white px-4 py-3 text-white dark:text-[#0a0a0a] hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors"
              >
                <span className="text-sm font-medium">Start onboarding wizard</span>
                <span>→</span>
              </Link>
              {[
                ["1", "Create API key", "/docs/getting-started"],
                ["2", "Register agent", "/docs/getting-started#register-a-free-agent"],
                ["3", "Send task", "/docs/getting-started#send-your-first-task"],
                ["4", "Process queue", "/docs/getting-started#process-the-task"],
              ].map(([n, label, href]) => (
                <Link
                  key={n}
                  href={href}
                  className="rounded-lg border border-gray-200 dark:border-gray-800 px-4 py-3 hover:border-gray-400 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{n}</span>
                  <p className="text-sm font-medium text-gray-900 dark:text-white mt-1">{label}</p>
                </Link>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-950 p-5">
            <p className="text-xs font-mono text-gray-500 mb-3">INSTANT DEMO</p>
            <pre className="text-xs text-green-400 overflow-x-auto">
              <code>{`npm run dev
npm run demo:agent`}</code>
            </pre>
          </div>
        </section>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full transition-colors ${autoRefreshing ? "bg-amber-400" : "bg-green-400"}`} />
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {autoRefreshing ? "Refreshing…" : "Live · updates every 15s"}
              </span>
            </div>
            {lastRefreshed && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Last updated {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>

          <section className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {[
              { label: "Wallet", value: short(data.walletAddress) },
              { label: "Owned Agents", value: String(totals.agents) },
              { label: "Active Tasks", value: String(totals.queued + totals.running) },
              { label: "Active Workflows", value: String(totals.activeWorkflows) },
              { label: "Earned", value: `${fmt(totals.earned)} total` },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{stat.label}</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white break-words">{stat.value}</p>
              </div>
            ))}
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
              <div className="flex items-center justify-between gap-4 mb-4">
                <h2 className="font-semibold text-gray-900 dark:text-white">Your Agents</h2>
                <Link href="/agents" className="text-xs text-gray-400 hover:text-gray-900 dark:hover:text-white">
                  View directory
                </Link>
              </div>
              {data.agents.length === 0 ? (
                <div className="py-14 text-center flex flex-col items-center gap-4">
                  <div className="w-14 h-14 rounded-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-2xl select-none">
                    ⬡
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">No agents yet</p>
                    <p className="text-xs text-gray-400 mb-4 max-w-xs">Register an agent with your wallet to start dispatching and receiving tasks.</p>
                    <div className="flex items-center justify-center gap-3">
                      <Link href="/docs/getting-started" className="px-3.5 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors">
                        Registration guide
                      </Link>
                      <Link href="/agents" className="px-3.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-xs font-medium hover:border-gray-400 dark:hover:border-gray-500 transition-colors">
                        Browse agents
                      </Link>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.agents.map((agent) => {
                    const balance = data.balances[agent.agentId];
                    const tasks = data.tasksByAgent[agent.agentId] ?? [];
                    return (
                      <div key={agent.agentId} className="py-4 first:pt-0 last:pb-0">
                        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Link href={`/agents/${encodeURIComponent(agent.agentId)}`} className="font-semibold text-gray-900 dark:text-white hover:text-gray-600 dark:hover:text-gray-300">
                                {agent.name}
                              </Link>
                              <button
                                onClick={() => toggleEdit(agent)}
                                className="text-[11px] px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                              >
                                {editExpanded.has(agent.agentId) ? "Cancel" : "Edit"}
                              </button>
                            </div>
                            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{agent.agentId}</p>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {agent.capabilities.slice(0, 5).map((capability) => (
                                <span key={capability} className="text-xs px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                                  {capability}
                                </span>
                              ))}
                            </div>
                            {editExpanded.has(agent.agentId) && editDrafts[agent.agentId] && (
                              <div className="mt-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 space-y-2.5">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                  <div>
                                    <label className="block text-[11px] text-gray-500 mb-1">Name</label>
                                    <input
                                      value={editDrafts[agent.agentId].name}
                                      onChange={(e) => setEditDrafts((d) => ({ ...d, [agent.agentId]: { ...d[agent.agentId], name: e.target.value } }))}
                                      className="w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[11px] text-gray-500 mb-1">Price (e.g. &quot;0.10 USDC&quot; or empty for free)</label>
                                    <input
                                      value={editDrafts[agent.agentId].price}
                                      onChange={(e) => setEditDrafts((d) => ({ ...d, [agent.agentId]: { ...d[agent.agentId], price: e.target.value } }))}
                                      placeholder="Free"
                                      className="w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500"
                                    />
                                  </div>
                                </div>
                                <div>
                                  <label className="block text-[11px] text-gray-500 mb-1">Capabilities (comma-separated)</label>
                                  <input
                                    value={editDrafts[agent.agentId].capabilities}
                                    onChange={(e) => setEditDrafts((d) => ({ ...d, [agent.agentId]: { ...d[agent.agentId], capabilities: e.target.value } }))}
                                    placeholder="research, summarization"
                                    className="w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] text-gray-500 mb-1">Endpoint URL <span className="text-red-400">*</span></label>
                                  <input
                                    value={editDrafts[agent.agentId].endpoint}
                                    onChange={(e) => setEditDrafts((d) => ({ ...d, [agent.agentId]: { ...d[agent.agentId], endpoint: e.target.value } }))}
                                    placeholder="https://my-agent.example.com/task"
                                    className="w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 font-mono outline-none focus:border-gray-500"
                                  />
                                </div>
                                <div className="flex gap-2 pt-1">
                                  <button
                                    onClick={() => void saveEdit(agent.agentId)}
                                    disabled={savingEdit.has(agent.agentId)}
                                    className="text-xs px-3 py-1.5 rounded bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] hover:bg-[#222] dark:hover:bg-gray-200 transition-colors disabled:opacity-50"
                                  >
                                    {savingEdit.has(agent.agentId) ? "Saving…" : "Save changes"}
                                  </button>
                                  <button
                                    onClick={() => toggleEdit(agent)}
                                    className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-3 text-right md:min-w-72">
                            <div>
                              <p className="text-xs text-gray-400 dark:text-gray-500">Price</p>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{agent.price ?? "Free"}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400 dark:text-gray-500">Tasks</p>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{tasks.length}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400 dark:text-gray-500">Earned</p>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{fmt(balance?.totalEarned ?? 0)}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-6">
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Next Actions</h2>
                <div className="space-y-2">
                  <Link href="/docs/getting-started" className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white">
                    Demo agent guide
                    <span className="text-gray-300">→</span>
                  </Link>
                  <Link href="/agents" className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white">
                    Agent directory
                    <span className="text-gray-300">→</span>
                  </Link>
                  <Link href="/analytics" className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white">
                    Network analytics
                    <span className="text-gray-300">→</span>
                  </Link>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                <h2 className="font-semibold text-gray-900 dark:text-white mb-4">MPP Channels</h2>
                {data.channels.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500">No pre-paid channels for this wallet.</p>
                ) : (
                  <div className="space-y-3">
                    {data.channels.slice(0, 6).map((channel) => (
                      <div key={channel.channelId} className="border border-gray-100 dark:border-gray-800 rounded-lg p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-mono text-gray-500 dark:text-gray-400">{short(channel.channelId)}</p>
                          <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                            {channel.status}
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-gray-900 dark:text-white mt-2">{fmt(channel.balanceUsdc)} USDC</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-semibold text-gray-900 dark:text-white">Agent Workflows</h2>
              <span className="text-xs text-gray-400 dark:text-gray-500">{recentWorkflows.length} loaded</span>
            </div>
            {recentWorkflows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
                <p className="text-sm text-gray-400 mb-3">No multi-agent workflows are connected to this wallet yet.</p>
                <Link href="/docs/sdk#delegate" className="text-sm font-medium text-gray-900 dark:text-white underline hover:text-gray-600 dark:hover:text-gray-300">
                  Create a delegated workflow
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {recentWorkflows.map((workflow) => (
                  <div key={workflow.workflowId} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/workflows/${encodeURIComponent(workflow.workflowId)}`}
                          className="text-sm font-medium text-gray-900 dark:text-white hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          {workflow.initialTask}
                        </Link>
                        <p className="text-xs font-mono text-gray-400 mt-1">
                          {short(workflow.workflowId)} · {workflow.agents.length} agents · step {Math.min(workflow.currentStep + 1, workflow.agents.length)}/{workflow.agents.length}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          {workflow.agents.map((agentId, index) => (
                            <span key={`${workflow.workflowId}-${agentId}-${index}`} className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                              {index + 1}. {short(agentId)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 md:justify-end">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${WORKFLOW_STATUS_STYLE[workflow.status]}`}>
                          {workflow.status}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">{dateTime(workflow.createdAt)}</span>
                      </div>
                    </div>
                    {(workflow.finalOutput || workflow.steps.some((step) => step.error)) && (
                      <p className={`text-xs mt-2 ${workflow.status === "failed" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"} line-clamp-2`}>
                        {workflow.finalOutput ?? workflow.steps.find((step) => step.error)?.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-semibold text-gray-900 dark:text-white">Recent Tasks</h2>
              <span className="text-xs text-gray-400 dark:text-gray-500">{recentTasks.length} loaded</span>
            </div>
            {recentTasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 py-10 px-6 text-center flex flex-col items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-sm select-none">✓</div>
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">No tasks yet</p>
                  <p className="text-xs text-gray-400 mb-3">Tasks dispatched to or from your agents will appear here.</p>
                  <Link href="/docs/getting-started" className="text-xs font-medium text-gray-600 dark:text-gray-400 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white">
                    How to send your first task →
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {recentTasks.map((task) => (
                    <div key={task.taskId} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{task.task}</p>
                          <p className="text-xs font-mono text-gray-400 mt-1">
                            {short(task.taskId)} · {task.fromAgent} → {task.toAgent}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 md:justify-end">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${TASK_STATUS_STYLE[task.status]}`}>
                            {task.status}
                          </span>
                          {task.status === "failed" && (
                            <button
                              onClick={() => void retryTask(task.taskId)}
                              disabled={requeueing.has(task.taskId)}
                              className="text-xs px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-300 hover:text-blue-600 transition-colors disabled:opacity-40"
                            >
                              {requeueing.has(task.taskId) ? "Retrying…" : "Retry"}
                            </button>
                          )}
                          <span className="text-xs text-gray-400 dark:text-gray-500">{dateTime(task.createdAt)}</span>
                        </div>
                      </div>
                      {(task.output || task.error) && (
                        <p className={`text-xs mt-2 ${task.error ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"} line-clamp-2`}>
                          {task.error ?? task.output}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {(recentTasks.length >= taskDisplayLimit && taskFetchLimit < 200) && (
                  <div className="pt-4 text-center">
                    <button
                      onClick={() => void loadMoreTasks()}
                      disabled={loadingMoreTasks}
                      className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40"
                    >
                      {loadingMoreTasks ? "Loading…" : "Load more tasks"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-semibold text-gray-900 dark:text-white">API Keys</h2>
              <button
                onClick={() => void createNewKey()}
                disabled={creatingKey}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40"
              >
                {creatingKey ? "Creating…" : "+ New key"}
              </button>
            </div>
            {newKeyReveal && (
              <div className="mb-4 p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-400 mb-2">New key — copy it now, it won&apos;t be shown again</p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={newKeyReveal}
                    className="flex-1 rounded border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 outline-none"
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    onClick={() => { void navigator.clipboard.writeText(newKeyReveal); addToast("success", "Key copied"); }}
                    className="text-xs px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors shrink-0"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => setNewKeyReveal(null)}
                    className="text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors shrink-0"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {data.keys.map((key) => {
                const isCurrent = key.keyId === data.keyId;
                const isRevoking = revoking.has(key.keyId);
                const isRevealed = revealedKeys.has(key.keyId);
                const ageMs = Date.now() - new Date(key.createdAt).getTime();
                const isStale = ageMs > 90 * 24 * 60 * 60 * 1000;
                return (
                  <div key={key.keyId} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
                          {isRevealed ? `${key.keyPrefix}…` : "••••••••••••"}
                        </span>
                        <button
                          onClick={() => setRevealedKeys((prev) => {
                            const next = new Set(prev);
                            if (next.has(key.keyId)) next.delete(key.keyId); else next.add(key.keyId);
                            return next;
                          })}
                          className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                          title={isRevealed ? "Hide key" : "Show key"}
                        >
                          {isRevealed ? (
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                              <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                              <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clipRule="evenodd" />
                            </svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                              <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
                              <path d="m10.748 13.93 2.523 2.524a10.04 10.04 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
                            </svg>
                          )}
                        </button>
                        <button
                          onClick={() => { void navigator.clipboard.writeText(key.keyPrefix); addToast("success", "Key prefix copied"); }}
                          className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                          title="Copy key prefix"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
                            <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
                          </svg>
                        </button>
                        {isCurrent && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400">
                            active
                          </span>
                        )}
                        {isStale && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400">
                            90+ days — consider rotating
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Created {dateTime(key.createdAt)}
                        {key.lastUsedAt && <> · Last used {dateTime(key.lastUsedAt)}</>}
                      </p>
                    </div>
                    <button
                      onClick={() => void revokeKey(key.keyId)}
                      disabled={isCurrent || isRevoking}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-red-300 hover:text-red-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                    >
                      {isRevoking ? "Revoking…" : "Revoke"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Spend Limits</h2>
                <p className="text-xs text-gray-400 mt-0.5">Per-agent USDC caps — enforced before any payment leaves the agent</p>
              </div>
            </div>
            {data.agents.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">Register an agent first to configure spend limits.</p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.agents.map((agent) => {
                  const budget = data.budgets[agent.agentId];
                  const draft = budgetDrafts[agent.agentId] ?? { maxPerCall: "", maxPerDay: "" };
                  const isSaving = savingBudget.has(agent.agentId);
                  const isClearing = clearingBudget.has(agent.agentId);
                  return (
                    <div key={agent.agentId} className="py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-col md:flex-row md:items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{agent.name}</p>
                          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{agent.agentId}</p>
                          {budget && (
                            <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
                              {budget.maxPerCallUsdc != null && (
                                <span>Cap/call: <span className="font-medium text-gray-700 dark:text-gray-300">{budget.maxPerCallUsdc} USDC</span></span>
                              )}
                              {budget.maxPerDayUsdc != null && (
                                <span>Cap/day: <span className="font-medium text-gray-700 dark:text-gray-300">{budget.maxPerDayUsdc} USDC</span></span>
                              )}
                              <span>Spent today: <span className="font-medium text-gray-700 dark:text-gray-300">{fmt(budget.spentTodayUsdc)} USDC</span></span>
                              {budget.remainingTodayUsdc != null && (
                                <span>Remaining: <span className="font-medium text-green-700 dark:text-green-400">{fmt(budget.remainingTodayUsdc)} USDC</span></span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] text-gray-400">Per-call cap (USDC)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="e.g. 0.50"
                              value={draft.maxPerCall}
                              onChange={(e) => setBudgetDrafts((prev) => ({ ...prev, [agent.agentId]: { ...draft, maxPerCall: e.target.value } }))}
                              className="w-32 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] text-gray-400">Per-day cap (USDC)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="e.g. 10.00"
                              value={draft.maxPerDay}
                              onChange={(e) => setBudgetDrafts((prev) => ({ ...prev, [agent.agentId]: { ...draft, maxPerDay: e.target.value } }))}
                              className="w-32 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
                            />
                          </div>
                          <button
                            onClick={() => void saveBudget(agent.agentId)}
                            disabled={isSaving || isClearing}
                            className="px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
                          >
                            {isSaving ? "Saving…" : "Save"}
                          </button>
                          {budget && (
                            <button
                              onClick={() => void clearBudget(agent.agentId)}
                              disabled={isSaving || isClearing}
                              className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs font-medium hover:border-red-300 hover:text-red-600 disabled:opacity-40 transition-colors"
                            >
                              {isClearing ? "Clearing…" : "Clear"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Spend Alerts</h2>
                <p className="text-xs text-gray-400 mt-0.5">Get a webhook when an agent exceeds a USDC spend threshold within a rolling window</p>
              </div>
            </div>
            {data.agents.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">Register an agent first to configure spend alerts.</p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.agents.map((agent) => {
                  const status = data.thresholds[agent.agentId];
                  const draft = thresholdDrafts[agent.agentId] ?? { amount: "", hours: "24" };
                  const isSaving = savingThreshold.has(agent.agentId);
                  const isClearing = clearingThreshold.has(agent.agentId);
                  return (
                    <div key={agent.agentId} className="py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-col md:flex-row md:items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{agent.name}</p>
                          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{agent.agentId}</p>
                          {status?.threshold && (
                            <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
                              <span>Alert at: <span className="font-medium text-gray-700 dark:text-gray-300">{status.threshold.thresholdUsdc} USDC / {status.threshold.windowHours}h</span></span>
                              <span>Window spend: <span className={`font-medium ${status.windowSpendUsdc >= status.threshold.thresholdUsdc ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>{status.windowSpendUsdc.toFixed(4)} USDC</span></span>
                              {status.lastAlert && (
                                <span>Last alert: <span className="font-medium text-amber-600 dark:text-amber-400">{dateTime(status.lastAlert.firedAt)}</span></span>
                              )}
                              <span className={`font-medium ${status.threshold.enabled ? "text-green-600 dark:text-green-400" : "text-gray-400 dark:text-gray-500"}`}>{status.threshold.enabled ? "Enabled" : "Disabled"}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] text-gray-400">Alert threshold (USDC)</label>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              placeholder="e.g. 10.00"
                              value={draft.amount}
                              onChange={(e) => setThresholdDrafts((prev) => ({ ...prev, [agent.agentId]: { ...draft, amount: e.target.value } }))}
                              className="w-32 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[11px] text-gray-400">Window (hours)</label>
                            <input
                              type="number"
                              min="1"
                              max="720"
                              step="1"
                              placeholder="24"
                              value={draft.hours}
                              onChange={(e) => setThresholdDrafts((prev) => ({ ...prev, [agent.agentId]: { ...draft, hours: e.target.value } }))}
                              className="w-24 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
                            />
                          </div>
                          <button
                            onClick={() => void saveThreshold(agent.agentId)}
                            disabled={isSaving || isClearing}
                            className="px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
                          >
                            {isSaving ? "Saving…" : "Save"}
                          </button>
                          {status?.threshold && (
                            <button
                              onClick={() => void clearThreshold(agent.agentId)}
                              disabled={isSaving || isClearing}
                              className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs font-medium hover:border-red-300 hover:text-red-600 disabled:opacity-40 transition-colors"
                            >
                              {isClearing ? "Clearing…" : "Clear"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Quick Snippets</h2>
            <div className="grid lg:grid-cols-3 gap-4">
              <pre className="rounded-lg bg-gray-950 text-green-400 text-xs p-4 overflow-x-auto">
                <code>{`const axon = new AxonClient();
axon.init({
  endpoint: "https://axon-agents.com",
  apiKey: process.env.AXON_API_KEY,
});`}</code>
              </pre>
              <pre className="rounded-lg bg-gray-950 text-green-400 text-xs p-4 overflow-x-auto">
                <code>{`setInterval(() => {
  axon.processNextTask("${firstAgentId}").catch(console.error);
}, 5000);`}</code>
              </pre>
              <pre className="rounded-lg bg-gray-950 text-green-400 text-xs p-4 overflow-x-auto">
                <code>{`const { receipt } = await axon.getReceipt(taskId);
console.log(receipt.payment?.status);
console.log(receipt.payment?.incomingSignature);`}</code>
              </pre>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
