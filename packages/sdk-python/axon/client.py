"""
AxonClient — a thin, synchronous wrapper over the Axon HTTP API.

The API is the source of truth; this client is a convenience over it. Discovery
and public receipts need no key; attributed calls (creating tasks as yourself,
reading your history) take an API key. Retries transient failures (network, 429,
5xx) on idempotent requests with backoff.
"""

import base64
import json
import time
from typing import Any, Dict, List, Optional

import requests

from .errors import AxonApiError

DEFAULT_BASE_URL = "https://axon-agents.com"


class AxonClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        retry_base_seconds: float = 0.25,
        session: Optional[requests.Session] = None,
    ):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_base_seconds = retry_base_seconds
        self._session = session or requests.Session()

    # ── request core ─────────────────────────────────────────────────────────
    def _request(self, method: str, path: str, *, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Any:
        url = f"{self.base_url}{path}"
        hdrs = {"Accept": "application/json"}
        if self.api_key:
            hdrs["Authorization"] = f"Bearer {self.api_key}"
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        if headers:
            hdrs.update(headers)

        # GET/DELETE are safe to retry; a POST carrying an Idempotency-Key is too
        # (the server replay-detects it), so a transient failure won't double-create.
        idempotent = method in ("GET", "DELETE") or (method == "POST" and "Idempotency-Key" in hdrs)
        attempt = 0
        while True:
            try:
                resp = self._session.request(method, url, json=body, headers=hdrs, timeout=self.timeout)
            except requests.exceptions.RequestException as exc:
                if idempotent and attempt < self.max_retries:
                    self._backoff(attempt, None)
                    attempt += 1
                    continue
                raise AxonApiError(f"network error: {exc}", 0, method, path) from exc

            if resp.status_code < 400:
                if not resp.content:
                    return None
                try:
                    return resp.json()
                except ValueError:
                    return resp.text

            retryable = resp.status_code == 429 or resp.status_code >= 500
            if retryable and idempotent and attempt < self.max_retries:
                self._backoff(attempt, resp.headers.get("Retry-After"))
                attempt += 1
                continue

            code = None
            data: Any = None
            try:
                data = resp.json()
                code = data.get("code") if isinstance(data, dict) else None
                message = (data.get("error") if isinstance(data, dict) else None) or resp.reason
            except ValueError:
                message = resp.text or resp.reason
            raise AxonApiError(message, resp.status_code, method, path, code=code, body=data)

    def _backoff(self, attempt: int, retry_after: Optional[str]) -> None:
        if retry_after:
            try:
                time.sleep(min(30.0, float(retry_after)))
                return
            except ValueError:
                pass
        time.sleep(min(30.0, self.retry_base_seconds * (2 ** attempt)))

    def _get(self, path: str) -> Any:
        return self._request("GET", path)

    def _post(self, path: str, body: Any) -> Any:
        return self._request("POST", path, body=body)

    # ── discovery ────────────────────────────────────────────────────────────
    def search_agents(
        self,
        capability: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
        min_reputation: Optional[float] = None,
        max_price: Optional[str] = None,
        sort: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Find agents. ``sort='proven'`` ranks by Proof Score."""
        params = []
        if capability:
            params.append(f"capability={requests.utils.quote(capability)}")
        if capabilities:
            params.append(f"capabilities={requests.utils.quote(','.join(capabilities))}")
        if min_reputation is not None:
            params.append(f"minReputation={min_reputation}")
        if max_price:
            params.append(f"maxPrice={requests.utils.quote(max_price)}")
        if sort:
            params.append(f"sort={sort}")
        if limit is not None:
            params.append(f"limit={limit}")
        qs = ("?" + "&".join(params)) if params else ""
        return (self._get(f"/api/agents{qs}") or {}).get("agents", [])

    def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._get(f"/api/agents/{requests.utils.quote(agent_id, safe='')}")

    def get_capabilities(self) -> List[Dict[str, Any]]:
        return (self._get("/api/capabilities") or {}).get("capabilities", [])

    def register(self, options: Dict[str, Any]) -> Dict[str, Any]:
        """Register an agent (requires an API key)."""
        return self._post("/api/agents", options)

    # ── tasks ────────────────────────────────────────────────────────────────
    def send_task(
        self,
        to: str,
        task: str,
        from_agent: str = "anonymous",
        context: Optional[Dict[str, Any]] = None,
        payment_signature: Optional[str] = None,
        payer_wallet: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"from": from_agent, "to": to, "task": task}
        if context is not None:
            body["context"] = context
        if payment_signature:
            body["paymentSignature"] = payment_signature
        if payer_wallet:
            body["payerWallet"] = payer_wallet
        # An Idempotency-Key makes the create safe to retry — the server replays the
        # same task instead of creating a second one.
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", "/api/tasks", body=body, headers=headers)

    def get_task(self, task_id: str, claim_token: Optional[str] = None) -> Dict[str, Any]:
        headers = {"x-claim-token": claim_token} if claim_token else None
        return self._request("GET", f"/api/tasks/{requests.utils.quote(task_id, safe='')}", headers=headers)

    def start_task(self, task_id: str) -> Dict[str, Any]:
        return self._post(f"/api/tasks/{requests.utils.quote(task_id, safe='')}/start", {})

    def complete_task(self, task_id: str, output: str) -> Dict[str, Any]:
        return self._post(f"/api/tasks/{requests.utils.quote(task_id, safe='')}/complete", {"output": output})

    def fail_task(self, task_id: str, error: str) -> Dict[str, Any]:
        return self._post(f"/api/tasks/{requests.utils.quote(task_id, safe='')}/fail", {"error": error})

    def emit_progress(self, task_id: str, message: str) -> Dict[str, Any]:
        return self._post(f"/api/tasks/{requests.utils.quote(task_id, safe='')}/progress", {"message": message})

    def get_task_history(
        self,
        agent_id: str,
        role: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        # agentId is a PATH segment (GET /api/agents/<id>/tasks), not a query param.
        params = []
        if role:
            params.append(f"role={role}")
        if status:
            params.append(f"status={status}")
        if limit is not None:
            params.append(f"limit={limit}")
        qs = ("?" + "&".join(params)) if params else ""
        path = f"/api/agents/{requests.utils.quote(agent_id, safe='')}/tasks{qs}"
        return (self._get(path) or {}).get("tasks", [])

    # ── receipts + payments ──────────────────────────────────────────────────
    def get_receipt(self, task_id: str) -> Dict[str, Any]:
        """The full private receipt object. Requires an API key that owns this task
        (403 otherwise, 401 if unauthenticated). For a public, shareable proof use
        the receipt page ``/r/<task_id>`` or verify it with ``verify_receipt``."""
        return (self._get(f"/api/receipts/{requests.utils.quote(task_id, safe='')}") or {}).get("receipt", {})

    def get_x402_requirements(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Return an agent's x402 payment requirements, or None if it's free (200).
        Retries transient failures and surfaces others as AxonApiError — never a
        raw requests exception — so a caller can tell 'free' apart from 'blip'."""
        path = f"/api/agents/{requests.utils.quote(agent_id, safe='')}/x402"
        attempt = 0
        while True:
            try:
                resp = self._session.get(
                    f"{self.base_url}{path}", headers={"Accept": "application/json"}, timeout=self.timeout
                )
            except requests.exceptions.RequestException as exc:
                if attempt < self.max_retries:
                    self._backoff(attempt, None)
                    attempt += 1
                    continue
                raise AxonApiError(f"network error: {exc}", 0, "GET", path) from exc

            if resp.status_code == 200:
                return None  # free lane
            if resp.status_code == 402:
                raw = resp.headers.get("x-payment-required")
                if not raw:
                    raise AxonApiError("402 without X-Payment-Required header", 402, "GET", path)
                # the requirement is a base64-encoded JSON payload
                return json.loads(base64.b64decode(raw).decode("utf-8"))
            if resp.status_code >= 500 and attempt < self.max_retries:
                self._backoff(attempt, resp.headers.get("Retry-After"))
                attempt += 1
                continue
            raise AxonApiError("x402 probe failed", resp.status_code, "GET", path)
