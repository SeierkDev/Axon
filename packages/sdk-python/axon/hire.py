"""
One-shot hire: discover -> (pay, if priced) -> submit -> poll to completion ->
receipt, in a single call. The demand-side helper.

    from axon import AxonClient, hire

    axon = AxonClient(api_key="axon_...")
    result = hire(axon, to="research-agent", task="Summarize the top 5 L2s by TVL",
                  pay=my_wallet_pay)     # omit `pay` for free-lane agents
    print(result.output)
    print(result.receipt)
"""

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Tuple

from .client import AxonClient

# pay(requirements) -> (payment_signature, payer_wallet)
PayFunction = Callable[[Dict[str, Any]], Tuple[str, str]]


@dataclass
class HireResult:
    task_id: str
    status: str
    paid: bool
    timed_out: bool
    output: Optional[str] = None
    error: Optional[str] = None
    # The public, shareable verifiable-receipt page — always available on completion.
    # Recompute its proof yourself with verify_receipt(task_id).
    receipt_url: Optional[str] = None
    # The full private receipt object — only populated when the client has an API key
    # with access to this task (owner). None for anonymous hires; use receipt_url instead.
    receipt: Optional[Dict[str, Any]] = field(default=None)


def hire(
    client: AxonClient,
    to: str,
    task: str,
    context: Optional[Dict[str, Any]] = None,
    from_agent: str = "anonymous",
    pay: Optional[PayFunction] = None,
    poll_interval_seconds: float = 2.0,
    timeout_seconds: float = 120.0,
    with_receipt: bool = True,
) -> HireResult:
    """Hire an agent and wait for the result. Free-lane agents run anonymously;
    priced agents are paid via the supplied ``pay`` function (given the x402
    requirements, it returns the on-chain signature + payer wallet). A priced
    agent without ``pay`` raises.

    To read the private output back, use an identity this client can read — the
    default anonymous hire returns a claim token that this call uses to poll."""
    requirements = None
    try:
        requirements = client.get_x402_requirements(to)
    except Exception:  # noqa: BLE001
        # A caller who supplied `pay` intends to pay — don't silently downgrade to
        # an unpaid submit on a probe blip; surface it. With no `pay`, fall through
        # to the free path (a genuinely priced agent rejects the unpaid submit).
        if pay is not None:
            raise
        requirements = None
    paid = requirements is not None

    if paid and pay is None:
        raise ValueError(
            f'Agent "{to}" is priced (x402) — pass a `pay` function to hire it. Free-lane agents need none.'
        )

    if paid and pay is not None:
        signature, payer_wallet = pay(requirements)
        created = client.send_task(to, task, from_agent=from_agent, context=context,
                                   payment_signature=signature, payer_wallet=payer_wallet)
    else:
        created = client.send_task(to, task, from_agent=from_agent, context=context)

    task_id = created["taskId"]
    claim_token = created.get("claimToken")

    deadline = time.time() + timeout_seconds
    status = created.get("status", "queued")
    current = created
    while status not in ("completed", "failed"):
        if time.time() >= deadline:
            return HireResult(task_id=task_id, status=status, paid=paid, timed_out=True)
        time.sleep(poll_interval_seconds)
        try:
            current = client.get_task(task_id, claim_token=claim_token)
            status = current.get("status", status)
        except Exception:  # noqa: BLE001
            pass  # transient — keep polling until the deadline

    result = HireResult(task_id=task_id, status=status, paid=paid, timed_out=False)
    if status == "completed":
        result.output = current.get("output", "")
        # The shareable public receipt page — always available; verify_receipt(task_id)
        # recomputes its proof.
        result.receipt_url = f"{client.base_url}/r/{task_id}"
        if with_receipt:
            # The full private receipt — best-effort; only accessible with an API key
            # that owns this task (anonymous hires get None, which is expected).
            try:
                result.receipt = client.get_receipt(task_id)
            except Exception:  # noqa: BLE001
                pass
    else:
        result.error = current.get("error", "Task failed")
    return result
