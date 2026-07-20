"""
Client-side verification — the point of Axon is that you can confirm claims
yourself, so the SDK ships the checks. No secrets leave the caller, no Axon
endpoint sits in the trust path.

- verify_proof_score: recompute an agent's Proof Score from its public receipts.
- verify_receipt: recompute a receipt's hash-chained execution trace.

Both are byte-identical to the server's own computation (proofScore.ts /
traceEvents.ts), so the recompute is trustworthy without trusting the number.
"""

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

DEFAULT_BASE_URL = "https://axon-agents.com"


def _http_get(url: str, session: Optional[requests.Session]) -> requests.Response:
    return (session or requests).get(url, timeout=30)


# ── Proof Score ──────────────────────────────────────────────────────────────
# Replicated verbatim from the published spec (also served at
# /api/agents/<id>/proof-score -> `formula`).

_SCALE = 1000
_QUALITY_WEIGHT = 0.6
_VOLUME_WEIGHT = 0.4
_TASKS_ANCHOR = 30
_USDC_ANCHOR = 200


def _js_math_round(x: float) -> float:
    """JavaScript Math.round exactly: nearest integer, ties toward +Infinity. NOT
    floor(x + 0.5) — that diverges at the ULP just below .5 (0.49999999999999994
    rounds to 1, not 0). This is a verification primitive, so it must match the
    server (proofScore.ts) precisely — a spurious mismatch is the wrong failure."""
    fl = math.floor(x)
    diff = x - fl
    if diff > 0.5:
        return float(fl + 1)
    if diff < 0.5:
        return float(fl)
    return float(fl + 1)  # exactly .5 → round up


def _js_round(n: float, dp: int = 3) -> float:
    """JS `Math.round(n * 10^dp) / 10^dp`, matching the server's `round` helper."""
    f = 10 ** dp
    return _js_math_round(n * f) / f


def _curve(v: float, anchor: float) -> float:
    return min(1.0, math.log10(1 + max(0.0, v)) / math.log10(1 + anchor))


def _proven_work_factor(count: float, usdc: float) -> float:
    return min(1.0, 0.6 * _curve(count, _TASKS_ANCHOR) + 0.4 * _curve(usdc, _USDC_ANCHOR))


@dataclass
class ProofScoreVerification:
    agent_id: str
    published_score: int
    recomputed_score: int
    score_matches: bool
    evidence_count: int
    native_count: int
    cross_network_count: int
    confirmed_receipts: Optional[int]
    verified: bool
    note: str


def verify_proof_score(
    agent_id: str,
    base_url: str = DEFAULT_BASE_URL,
    session: Optional[requests.Session] = None,
    confirm_receipts: bool = False,
) -> ProofScoreVerification:
    """Independently verify an agent's Proof Score. Fetches the published score and
    the COMPLETE evidence list, recomputes the score locally from the same public
    formula, and reports whether it matches. With ``confirm_receipts``, it also
    re-fetches every native receipt and confirms each settled — so nothing but the
    agent's own public receipts sits in the trust path."""
    base = base_url.rstrip("/")
    aid = requests.utils.quote(agent_id, safe="")

    r = _http_get(f"{base}/api/agents/{aid}/proof-score", session)
    if not r.ok:
        raise RuntimeError(f"proof-score fetch failed: HTTP {r.status_code}")
    proof = r.json()
    quality_factor = proof["components"]["quality"]["factor"]
    published = proof["score"]

    r2 = _http_get(f"{base}/api/agents/{aid}/proof-score?evidence=full", session)
    if not r2.ok:
        raise RuntimeError(f"evidence fetch failed: HTTP {r2.status_code}")
    evidence: List[Dict[str, Any]] = (r2.json() or {}).get("evidence", [])

    native = [e for e in evidence if e.get("network") == "axon"]
    cross = [e for e in evidence if e.get("network") != "axon"]

    confirmed: Optional[int] = None
    count = len(evidence)
    usdc = _js_round(sum(e.get("settledUsdc", 0) for e in evidence), 6)

    if confirm_receipts:
        ok = 0
        confirmed_usdc = 0.0
        for e in native:
            if not e.get("verify"):
                continue
            try:
                rr = _http_get(f"{base}{e['verify']}", session)
                if not rr.ok:
                    continue
                receipt = rr.json()
                if receipt.get("status") == "completed" and receipt.get("settlement"):
                    ok += 1
                    confirmed_usdc += e.get("settledUsdc", 0)
            except Exception:  # noqa: BLE001
                pass
        confirmed = ok
        count = ok + len(cross)
        usdc = _js_round(confirmed_usdc + sum(e.get("settledUsdc", 0) for e in cross), 6)

    volume_factor = _js_round(_proven_work_factor(count, usdc))
    recomputed = int(_js_math_round(
        _js_round(_SCALE * _QUALITY_WEIGHT * quality_factor, 2)
        + _js_round(_SCALE * _VOLUME_WEIGHT * volume_factor, 2)
    ))

    score_matches = recomputed == published
    all_confirmed = confirmed is None or confirmed == len(native)
    verified = score_matches and all_confirmed
    if not score_matches:
        note = f"Recomputed {recomputed}, but the published score is {published} — does not match."
    elif all_confirmed:
        extra = f" (re-confirmed {confirmed}/{len(native)} native receipts settled)" if confirmed is not None else ""
        note = f"Recomputed {recomputed} from {len(evidence)} settled task(s){extra}; matches the published score."
    else:
        note = f"Score matches, but only {confirmed}/{len(native)} native receipts confirmed settled."

    return ProofScoreVerification(
        agent_id=agent_id,
        published_score=published,
        recomputed_score=recomputed,
        score_matches=score_matches,
        evidence_count=len(evidence),
        native_count=len(native),
        cross_network_count=len(cross),
        confirmed_receipts=confirmed,
        verified=verified,
        note=note,
    )


# ── Receipt / execution-trace verification ───────────────────────────────────
# Recompute a receipt's hash-chained trace with the exact canonical-JSON + SHA-256
# scheme it was written with. Detects any edit, reorder, insertion, or interior
# deletion. Cannot detect tail truncation (inherent to head-less hash chains) —
# `chain_valid` means the chain shown is intact, not provably complete.


def _js_number(n: Any) -> str:
    """Serialize a number byte-identically to JavaScript's JSON.stringify (the
    ECMAScript Number-to-string algorithm), so any field — including SOL amounts
    with up to 9 decimals — reproduces exactly."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if not isinstance(n, float):
        return "null"
    if n != n or n in (float("inf"), float("-inf")):
        return "null"
    if n == 0:
        return "0"
    sign = "-" if n < 0 else ""
    r = repr(abs(n))
    if "e" in r or "E" in r:
        mant, exp_s = r.replace("E", "e").split("e")
        exp = int(exp_s)
    else:
        mant, exp = r, 0
    int_part, frac_part = (mant.split(".") + [""])[:2]
    stripped = (int_part + frac_part).lstrip("0")
    if not stripped:
        return "0"
    s = stripped.rstrip("0")
    trailing = len(stripped) - len(s)
    k = len(s)
    n_pos = (exp - len(frac_part) + trailing) + k
    if k <= n_pos <= 21:
        out = s + "0" * (n_pos - k)
    elif 0 < n_pos <= 21:
        out = s[:n_pos] + "." + s[n_pos:]
    elif -6 < n_pos <= 0:
        out = "0." + "0" * (-n_pos) + s
    else:
        e = n_pos - 1
        out = (s[0] + ("." + s[1:] if k > 1 else "")) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def _canonical(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _canonical(value[k]) for k in keys) + "}"
    return "null"


@dataclass
class ReceiptVerification:
    task_id: str
    trace_id: str
    event_count: int
    chain_valid: bool
    broken_at: Optional[int]
    platform_claim: Optional[bool]
    verified: bool
    note: str


def verify_trace(trace: Dict[str, Any]) -> ReceiptVerification:
    """Recompute a fetched trace object's hash chain locally."""
    trace_id = trace.get("traceId", "")
    events: List[Dict[str, Any]] = trace.get("events") or []
    prev_hash: Optional[str] = None
    expected_seq = 1
    broken_at: Optional[int] = None
    for e in events:
        meta = e.get("meta")
        meta_str = None if meta is None else _canonical(meta)
        fields = {
            "traceId": trace_id, "seq": e.get("seq"), "taskId": e.get("taskId"),
            "kind": e.get("kind"), "fromAgent": e.get("fromAgent"), "toAgent": e.get("toAgent"),
            "workflowId": e.get("workflowId"), "stepIndex": e.get("stepIndex"),
            "inputHash": e.get("inputHash"), "outputHash": e.get("outputHash"),
            "model": e.get("model"), "inputTokens": e.get("inputTokens"),
            "outputTokens": e.get("outputTokens"), "costUsd": e.get("costUsd"),
            "latencyMs": e.get("latencyMs"), "meta": meta_str,
            "createdAt": e.get("createdAt"), "prevHash": e.get("prevHash"),
        }
        recomputed = hashlib.sha256(_canonical(fields).encode("utf-8")).hexdigest()
        if e.get("seq") != expected_seq or e.get("prevHash") != prev_hash or e.get("hash") != recomputed:
            broken_at = e.get("seq")
            break
        prev_hash = e.get("hash")
        expected_seq += 1

    chain_valid = broken_at is None and len(events) > 0
    note = (
        f"Recomputed all {len(events)} event(s); the hash chain is intact." if chain_valid
        else "Trace has no events to verify." if len(events) == 0
        else f"Hash chain breaks at event #{broken_at} — the recomputed hash or link does not match."
    )
    return ReceiptVerification(
        task_id=trace.get("taskId", ""), trace_id=trace_id, event_count=len(events),
        chain_valid=chain_valid, broken_at=broken_at,
        platform_claim=trace.get("verified") if isinstance(trace.get("verified"), bool) else None,
        verified=chain_valid, note=note,
    )


def verify_receipt(
    task_id: str,
    base_url: str = DEFAULT_BASE_URL,
    session: Optional[requests.Session] = None,
) -> ReceiptVerification:
    """Fetch a task's public execution trace and recompute the whole hash chain
    locally. The platform's own `verified` flag is reported but never relied on."""
    base = base_url.rstrip("/")
    r = _http_get(f"{base}/api/receipts/{requests.utils.quote(task_id, safe='')}/trace", session)
    if r.status_code == 404:
        raise RuntimeError(f"no execution trace found for task {task_id}")
    if not r.ok:
        raise RuntimeError(f"trace fetch failed: HTTP {r.status_code}")
    return verify_trace(r.json() or {})
