"""
The Axon agent runtime — the batteries-included worker.

Register a handler and the runtime polls for queued work, runs it, and settles
each task, on a background thread. Building an earning agent goes from wiring the
task primitives by hand to:

    agent = define_agent(
        client,
        agent_id="my-agent", name="My Agent", capabilities=["research"],
        public_key=pk, wallet_address=wallet,
        handler=lambda ctx: do_work(ctx.task["task"]),
    )
    agent.start()
    ...
    agent.stop()
"""

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Union

from .client import AxonClient
from .errors import AxonApiError

# handler(ctx) -> output string, or {"output": str, "success": bool}
HandlerResult = Union[str, Dict[str, Any]]
Handler = Callable[["AgentContext"], HandlerResult]


def _is_not_found(err: Exception) -> bool:
    return isinstance(err, AxonApiError) and (err.status == 404 or err.code == "NOT_FOUND")


def _is_state_conflict(err: Exception) -> bool:
    return isinstance(err, AxonApiError) and (err.status == 409 or err.code == "TASK_STATE_CONFLICT")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class AgentContext:
    task: Dict[str, Any]
    _agent: "AxonAgent"

    def progress(self, message: str) -> None:
        """Emit an intermediate progress message — best-effort, never fails the task."""
        try:
            self._agent.client.emit_progress(self.task["taskId"], message)
        except Exception:  # noqa: BLE001
            pass

    @property
    def stopping(self) -> bool:
        return self._agent._stopping


class AxonAgent:
    def __init__(
        self,
        client: AxonClient,
        registration: Dict[str, Any],
        handler: Handler,
        poll_interval_seconds: float = 2.0,
        auto_register: bool = True,
        concurrency: int = 1,
        on_error: Optional[Callable[..., None]] = None,
        on_task_start: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_task_complete: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.client = client
        self.registration = registration
        self.agent_id = registration["agentId"]
        self.handler = handler
        self.poll_interval = poll_interval_seconds
        self.auto_register = auto_register
        self.concurrency = max(1, concurrency)
        self.on_error = on_error
        self.on_task_start = on_task_start
        self.on_task_complete = on_task_complete

        self._running = False
        self._stopping = False
        self._thread: Optional[threading.Thread] = None
        self._executor = ThreadPoolExecutor(max_workers=self.concurrency)
        self._inflight: "set[Future]" = set()
        self._claiming: "set[str]" = set()
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        with self._lock:  # atomic check-and-set — a concurrent start() is a no-op
            if self._running:
                return
            self._running = True
            # Fresh executor each run so the agent is restartable after stop()
            # (stop() shuts the previous one down).
            self._executor = ThreadPoolExecutor(max_workers=self.concurrency)
        self._stopping = False
        try:
            self._ensure_registered()
        except Exception:
            self._running = False
            raise
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping = True
        self._running = False
        if self._thread:
            self._thread.join()
        with self._lock:
            pending = list(self._inflight)
        for fut in pending:  # drain in-flight handlers before shutting down
            try:
                fut.result()
            except Exception:  # noqa: BLE001
                pass
        self._executor.shutdown(wait=True)

    # ── internals ────────────────────────────────────────────────────────────
    def _safe(self, fn: Optional[Callable], *args: Any) -> None:
        if fn is None:
            return
        try:
            fn(*args)
        except Exception:  # noqa: BLE001
            pass

    def _ensure_registered(self) -> None:
        if not self.auto_register:
            return
        try:
            self.client.get_agent(self.agent_id)
        except Exception as err:
            if _is_not_found(err):
                self.client.register(self.registration)
                return
            raise

    def _loop(self) -> None:
        while self._running:
            launched = 0
            try:
                with self._lock:
                    slots = self.concurrency - len(self._inflight)
                if slots > 0:
                    queued: List[Dict[str, Any]] = self.client.get_task_history(
                        self.agent_id, role="recipient", status="queued", limit=slots
                    )
                    for t in queued:
                        if not self._running:
                            break
                        tid = t["taskId"]
                        with self._lock:
                            if tid in self._claiming or len(self._inflight) >= self.concurrency:
                                continue
                            self._claiming.add(tid)
                            fut = self._executor.submit(self._run_one, t)
                            self._inflight.add(fut)
                        # add_done_callback OUTSIDE the lock: on an already-finished
                        # future it runs _on_done synchronously, which needs the lock.
                        fut.add_done_callback(lambda f, tid=tid: self._on_done(f, tid))
                        launched += 1
            except Exception as err:  # noqa: BLE001
                self._safe(self.on_error, err, None)
            if launched == 0:
                time.sleep(self.poll_interval)

    def _on_done(self, fut: Future, task_id: str) -> None:
        with self._lock:
            self._inflight.discard(fut)
            self._claiming.discard(task_id)

    def _settle(self, task_id: str, ok: bool, text: str) -> bool:
        """Settle with a bounded retry; a state conflict means an earlier settle
        already landed (lost response), so treat it as success."""
        attempts = 4
        for i in range(attempts):
            try:
                if ok:
                    self.client.complete_task(task_id, text)
                else:
                    self.client.fail_task(task_id, text)
                return True
            except Exception as err:  # noqa: BLE001
                if _is_state_conflict(err):
                    return True
                if i == attempts - 1:
                    self._safe(self.on_error, err, {"taskId": task_id})
                    return False
                time.sleep(min(2.0, 0.2 * (2 ** i)))
        return False

    def _run_one(self, task: Dict[str, Any]) -> None:
        try:
            started = self.client.start_task(task["taskId"])
        except Exception as err:  # noqa: BLE001
            if _is_state_conflict(err):
                return
            self._safe(self.on_error, err, task)
            return

        self._safe(self.on_task_start, started)
        ctx = AgentContext(task=started, _agent=self)

        try:
            result = self.handler(ctx)
            if isinstance(result, str):
                ok, text = True, result
            else:
                ok = result.get("success", True) is not False
                text = result.get("output", "") if ok else (result.get("output") or "Task failed")
        except Exception as err:  # noqa: BLE001
            ok, text = False, str(err)
            self._safe(self.on_error, err, started)

        settled = self._settle(started["taskId"], ok, text)
        if settled:
            self._safe(self.on_task_complete, {
                "taskId": started["taskId"],
                "success": ok,
                "output": text if ok else "",
                "error": None if ok else text,
                "completedAt": _now(),
            })


def define_agent(
    client: AxonClient,
    handler: Handler,
    agent_id: str,
    name: str,
    capabilities: List[str],
    public_key: str,
    wallet_address: Optional[str] = None,
    price: Optional[str] = None,
    provider: Optional[str] = None,
    poll_interval_seconds: float = 2.0,
    auto_register: bool = True,
    concurrency: int = 1,
    on_error: Optional[Callable[..., None]] = None,
    on_task_start: Optional[Callable[[Dict[str, Any]], None]] = None,
    on_task_complete: Optional[Callable[[Dict[str, Any]], None]] = None,
    **extra_registration: Any,
) -> AxonAgent:
    """Define a long-running Axon agent. Call ``start()`` to register (if needed)
    and begin processing queued tasks, ``stop()`` to drain and shut down."""
    registration: Dict[str, Any] = {
        "agentId": agent_id,
        "name": name,
        "capabilities": capabilities,
        "publicKey": public_key,
    }
    if wallet_address:
        registration["walletAddress"] = wallet_address
    if price:
        registration["price"] = price
    if provider:
        registration["provider"] = provider
    registration.update(extra_registration)

    return AxonAgent(
        client, registration, handler,
        poll_interval_seconds=poll_interval_seconds,
        auto_register=auto_register, concurrency=concurrency,
        on_error=on_error, on_task_start=on_task_start, on_task_complete=on_task_complete,
    )
