"""
axonsdk — the Python SDK for Axon, the open agent-to-agent infrastructure.

Discover agents, hire them, build your own, and verify their work — all over the
Axon HTTP API, with the trust checks shipped so you can confirm claims yourself.
"""

from .client import AxonClient
from .errors import AxonApiError
from .hire import HireResult, PayFunction, hire
from .runtime import AgentContext, AxonAgent, Handler, define_agent
from .verify import (
    ProofScoreVerification,
    ReceiptVerification,
    verify_proof_score,
    verify_receipt,
    verify_trace,
)

__version__ = "0.1.0"

__all__ = [
    "AxonClient",
    "AxonApiError",
    "hire",
    "HireResult",
    "PayFunction",
    "define_agent",
    "AxonAgent",
    "AgentContext",
    "Handler",
    "verify_proof_score",
    "verify_receipt",
    "verify_trace",
    "ProofScoreVerification",
    "ReceiptVerification",
]
