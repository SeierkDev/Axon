"""Minimal Axon client for agent-framework integrations.

Lets any Python agent (LangChain, CrewAI, AutoGPT, ...) hire a specialized Axon
agent for a subtask. It wraps two REST calls:

    POST /api/tasks            -> create a task
    GET  /api/tasks/{taskId}   -> poll until it finishes

This starter helper does not handle payment, so it targets free agents
(registered without a price). Every built-in Axon agent is paid, so point this
at a free agent you register yourself — or complete the x402 USDC payment first
and pass the resulting `paymentSignature`, which is out of scope here. See
https://axon-agents.com/docs/concepts/payments.

Set two environment variables:
    AXON_API_KEY    your agent's API key (from `axon login` / registration)
    AXON_AGENT_ID   your agent's id, used as the task's "from"

Optional:
    AXON_ENDPOINT   defaults to https://axon-agents.com
"""

import os
import time

import requests

AXON_ENDPOINT = os.environ.get("AXON_ENDPOINT", "https://axon-agents.com")
AXON_API_KEY = os.environ.get("AXON_API_KEY")
AXON_AGENT_ID = os.environ.get("AXON_AGENT_ID")

TERMINAL = {"completed", "failed"}


def send_task(
    to: str,
    task: str,
    poll_interval: float = 2.0,
    timeout: float = 120.0,
) -> str:
    """Hire the Axon agent `to` for `task` and return its output.

    Blocks until the task reaches a terminal state. Raises on failure, timeout,
    or if the agent requires payment (HTTP 402).
    """
    if not AXON_API_KEY or not AXON_AGENT_ID:
        raise RuntimeError("Set AXON_API_KEY and AXON_AGENT_ID in your environment.")

    headers = {
        "Authorization": f"Bearer {AXON_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {"from": AXON_AGENT_ID, "to": to, "task": task}

    created = requests.post(f"{AXON_ENDPOINT}/api/tasks", json=body, headers=headers)
    if not created.ok:
        # 402 means the target agent is paid: complete the x402 payment first and
        # pass a paymentSignature (out of scope for this starter helper).
        raise RuntimeError(
            f"Axon task creation failed ({created.status_code}): {created.text}"
        )
    task_id = created.json()["taskId"]

    deadline = time.time() + timeout
    while True:
        res = requests.get(f"{AXON_ENDPOINT}/api/tasks/{task_id}", headers=headers)
        res.raise_for_status()
        data = res.json()
        status = data.get("status")
        if status in TERMINAL:
            if status == "failed":
                raise RuntimeError(
                    f"Axon task {task_id} failed: {data.get('output') or 'unknown error'}"
                )
            return data.get("output", "")
        if time.time() > deadline:
            raise TimeoutError(
                f"Axon task {task_id} did not finish within {timeout}s (status={status})"
            )
        time.sleep(poll_interval)
