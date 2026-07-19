"""
Axon connection for ZerePy.

Gives a ZerePy agent one high-leverage power: when it hits a task outside its own
skills, it hires a proven specialist on the Axon marketplace, pays from its own
Solana wallet, and brings back the result — plus a public receipt whose proof it
can recompute itself.

Drop this file into `src/connections/` in your ZerePy repo and add an "axon"
entry to your agent config (see `agents/axon-example.json`). Discovery and receipt
verification are public — no API key. Paid hires authorize themselves with an
on-chain USDC payment (the x402 pattern) signed by your Solana wallet, so there is
no account to create.

Actions
-------
- search-agents   : discover agents for a capability, ranked by Proof Score
- hire-agent      : hire one (free lane runs now; paid returns payment terms)
- get-result      : fetch the private output with the claim token from the hire
- verify-receipt  : recompute a receipt's hash-chained trace locally
"""

import base64
import json
import logging
import time
from typing import Any, Dict, Optional

import requests

from src.connections.base_connection import Action, ActionParameter, BaseConnection
from src.connections.axon_verify import verify_trace

logger = logging.getLogger("connections.axon_connection")

DEFAULT_BASE_URL = "https://axon-agents.com"


class AxonConnectionError(Exception):
    """Raised on a hard failure talking to Axon."""


class AxonConnection(BaseConnection):
    def __init__(self, config: Dict[str, Any]):
        logger.info("Initializing Axon connection...")
        super().__init__(config)
        self.base_url = str(config.get("base_url", DEFAULT_BASE_URL)).rstrip("/")

    @property
    def is_llm_provider(self) -> bool:
        return False

    # ── config lifecycle ─────────────────────────────────────────────────────
    def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        base_url = config.get("base_url", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.startswith("http"):
            raise ValueError("Axon: base_url must be an http(s) URL")
        return config

    def configure(self, **kwargs) -> bool:
        # Nothing to store: discovery and receipts are public, and paid hires
        # authorize with an on-chain payment rather than an account.
        logger.info("Axon needs no credentials — discovery and receipts are public.")
        return True

    def is_configured(self, verbose: bool = False) -> bool:
        # There are no credentials to check — discovery and receipts are public and
        # paid hires authorize on-chain, so the connection is ready as soon as a
        # valid base_url is set (validated in __init__). Deliberately NOT coupled to
        # a live /api/status probe: ZerePy calls is_configured() before every
        # action, and a status blip must not block actions whose own endpoints are
        # fine (each action handles its own network errors).
        if verbose:
            logger.info(f"Axon connection ready (base_url={self.base_url}).")
        return bool(self.base_url)

    def register_actions(self) -> None:
        self.actions = {
            "search-agents": Action(
                name="search-agents",
                parameters=[
                    ActionParameter("capability", True, str, "Capability to search for, e.g. 'research'"),
                    ActionParameter("limit", False, int, "Max agents to return (default 5)"),
                ],
                description="Find agents for a capability on the Axon marketplace, ranked by Proof Score",
            ),
            "hire-agent": Action(
                name="hire-agent",
                parameters=[
                    ActionParameter("agent_id", True, str, "Agent to hire (from search-agents)"),
                    ActionParameter("task", True, str, "The work to do"),
                    ActionParameter("payment_signature", False, str, "Solana tx signature of the USDC payment (paid agents)"),
                    ActionParameter("payer_wallet", False, str, "The wallet that signed the payment (paid agents)"),
                ],
                description="Hire an agent. Free-lane agents run immediately; paid agents return payment terms to settle with your wallet",
            ),
            "get-result": Action(
                name="get-result",
                parameters=[
                    ActionParameter("task_id", True, str, "Task id from hire-agent"),
                    ActionParameter("claim_token", True, str, "Claim token from hire-agent"),
                    ActionParameter("wait_seconds", False, int, "How long to poll for completion (default 90)"),
                ],
                description="Fetch a hired task's result. The output is private to the hirer, gated by the claim token",
            ),
            "verify-receipt": Action(
                name="verify-receipt",
                parameters=[
                    ActionParameter("task_id", True, str, "Task id whose receipt to verify"),
                ],
                description="Recompute a receipt's hash-chained execution trace locally and report whether it is intact",
            ),
        }

    def perform_action(self, action_name: str, kwargs) -> Any:
        """Validate params against the Action, then dispatch to the handler
        (action-name → method with hyphens replaced by underscores). Matches the
        dispatch every shipped ZerePy connection implements."""
        if action_name not in self.actions:
            raise KeyError(f"Unknown action: {action_name}")
        action = self.actions[action_name]
        errors = action.validate_params(kwargs)
        if errors:
            raise ValueError(f"Invalid parameters: {', '.join(errors)}")
        method = getattr(self, action_name.replace("-", "_"))
        return method(**kwargs)

    # ── actions ──────────────────────────────────────────────────────────────
    def search_agents(self, capability: str, limit: int = 5, **kwargs) -> str:
        params = {"capability": capability, "sort": "proven", "limit": str(limit)}
        r = requests.get(f"{self.base_url}/api/agents", params=params, timeout=20)
        if not r.ok:
            raise AxonConnectionError(f"search failed: HTTP {r.status_code}")
        agents = (r.json() or {}).get("agents", [])
        if not agents:
            return f"No agents found for capability '{capability}'."
        lines = [f"Top {len(agents)} agents for '{capability}' (by Proof Score):"]
        for a in agents:
            price = a.get("price") or "free"
            score = a.get("proofScore")
            score_s = f", proof {score}" if score is not None else ""
            lines.append(f"  - {a.get('agentId')}  ({a.get('name')}) — {price}{score_s}")
        return "\n".join(lines)

    def hire_agent(
        self,
        agent_id: str,
        task: str,
        payment_signature: Optional[str] = None,
        payer_wallet: Optional[str] = None,
        **kwargs,
    ) -> str:
        body: Dict[str, Any] = {"from": "anonymous", "to": agent_id, "task": task}
        if payment_signature:
            body["paymentSignature"] = payment_signature
        if payer_wallet:
            body["payerWallet"] = payer_wallet

        r = requests.post(f"{self.base_url}/api/tasks", json=body, timeout=30)

        # Paid agent, no payment yet → surface the terms so the agent can pay with
        # its Solana wallet and call again with payment_signature + payer_wallet.
        if r.status_code == 402 and not payment_signature:
            terms = self._payment_terms(agent_id)
            if terms:
                return (
                    f"'{agent_id}' is a paid agent. Pay {terms['amount']} {terms['currency']} to "
                    f"{terms['pay_to']} on Solana with your wallet, then call hire-agent again with "
                    f"payment_signature (the tx signature) and payer_wallet (your address)."
                )
            return "This agent requires an on-chain USDC payment (x402). Pay, then retry with payment_signature and payer_wallet."

        # Free-lane demo quota reached — return the guidance rather than throwing.
        if r.status_code == 429:
            try:
                msg = (r.json() or {}).get("error", "")
            except Exception:  # noqa: BLE001
                msg = ""
            return msg or "Free demo limit reached for this agent. Hire a paid agent, or try again later."

        if not r.ok:
            detail = ""
            try:
                detail = (r.json() or {}).get("error", "")
            except Exception:  # noqa: BLE001
                pass
            raise AxonConnectionError(f"hire failed: HTTP {r.status_code} {detail}".strip())

        data = r.json() or {}
        task_id = data.get("taskId")
        claim_token = data.get("claimToken")
        return (
            f"Hired {agent_id}. task_id={task_id} claim_token={claim_token}\n"
            f"Call get-result with these to collect the output; receipt at {self.base_url}/r/{task_id}"
        )

    def get_result(self, task_id: str, claim_token: str, wait_seconds: int = 90, **kwargs) -> str:
        deadline = time.time() + max(0, wait_seconds)
        headers = {"x-claim-token": claim_token}
        last_status = "queued"
        while True:
            try:
                r = requests.get(f"{self.base_url}/api/tasks/{task_id}", headers=headers, timeout=20)
                if r.status_code == 403:
                    return "Wrong claim token for this task — the output is private to the hirer."
                if r.status_code == 404:
                    return f"No task found with id {task_id}."
                if r.ok:
                    t = r.json() or {}
                    last_status = t.get("status", last_status)
                    if last_status == "completed":
                        return f"Result:\n{t.get('output', '')}\n\nReceipt: {self.base_url}/r/{task_id}"
                    if last_status == "failed":
                        return f"The agent could not complete this task. Receipt: {self.base_url}/r/{task_id}"
                # any other status (5xx, transient) → fall through and retry
            except requests.exceptions.RequestException:
                pass  # transient network blip — keep polling until the deadline
            if time.time() >= deadline:
                return f"Still {last_status} after {wait_seconds}s — check the receipt shortly: {self.base_url}/r/{task_id}"
            time.sleep(2)

    def verify_receipt(self, task_id: str, **kwargs) -> str:
        r = requests.get(f"{self.base_url}/api/receipts/{task_id}/trace", timeout=20)
        if r.status_code == 404:
            return f"No execution trace found for task {task_id}."
        if not r.ok:
            raise AxonConnectionError(f"trace fetch failed: HTTP {r.status_code}")
        res = verify_trace(r.json() or {})
        if res["event_count"] == 0:
            return "Trace has no events to verify."
        if res["chain_valid"]:
            return f"Verified: recomputed all {res['event_count']} events locally — the hash chain is intact."
        return f"TAMPERED: the hash chain breaks at event #{res['broken_at']} — recomputed hash or link does not match."

    # ── helpers ──────────────────────────────────────────────────────────────
    def _payment_terms(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Read an agent's x402 payment requirement (amount + address)."""
        try:
            r = requests.get(f"{self.base_url}/api/agents/{agent_id}/x402", timeout=15)
            if r.status_code != 402:
                return None
            raw = r.headers.get("x-payment-required")
            if not raw:
                return None
            # The requirement is a base64-encoded JSON payload (x402 pattern).
            req = json.loads(base64.b64decode(raw).decode("utf-8"))
            opt = (req.get("accepts") or [{}])[0]
            units = int(opt.get("maxAmountRequired", 0))
            return {
                "amount": units / 1_000_000,  # USDC has 6 decimals
                "currency": "USDC",
                "pay_to": opt.get("payToAddress"),
            }
        except Exception:  # noqa: BLE001
            return None
