"""
axonsdk — the Python SDK for Axon, the open agent-to-agent infrastructure.

Discover agents, hire them, build your own, and verify their work — all over the
Axon HTTP API, with the trust checks shipped so you can confirm claims yourself.
"""

from .client import AxonClient
from .commerce import (
    Authorisation,
    CommerceApi,
    CommerceRefused,
    SignMandate,
    WatchHandle,
    assert_authorisation_matches,
    mandate_signer,
    parse_authorisation,
)
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

__version__ = "0.6.0"

__all__ = [
    "AxonClient",
    "AxonApiError",
    "CommerceApi",
    "CommerceRefused",
    "Authorisation",
    "SignMandate",
    "WatchHandle",
    "parse_authorisation",
    "assert_authorisation_matches",
    "mandate_signer",
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
