"""
Trustless receipt verification for Axon, in pure Python (no ZerePy dependency).

Recomputes a receipt's execution trace with the same canonical-JSON + SHA-256
scheme Axon writes it with, so tamper-evidence holds without trusting Axon's own
"verified" flag. Detects any edit, reorder, insertion, or interior deletion.

Caveat, inherent to any head-less hash chain: truncating the TAIL (dropping the
most recent events) leaves a shorter, still-valid chain — so `chain_valid` means
the chain shown is intact, not provably complete.
"""

import hashlib
import json
from typing import Any, Dict, List, Optional


def _js_number(n: Any) -> str:
    """Serialize a number byte-identically to JavaScript's JSON.stringify, i.e. the
    ECMAScript Number-to-string algorithm. The trace was hashed on the JS side, so
    any field (including SOL meta amounts with up to 9 decimals) must reproduce
    exactly — a fixed-precision format would false-flag a valid receipt."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if not isinstance(n, float):
        return "null"
    if n != n or n == float("inf") or n == float("-inf"):
        return "null"  # JSON.stringify → null
    if n == 0:
        return "0"  # JS: -0 also prints "0"

    sign = "-" if n < 0 else ""
    r = repr(abs(n))  # Python's shortest round-tripping decimal, like V8's
    if "e" in r or "E" in r:
        mant, exp_s = r.replace("E", "e").split("e")
        exp = int(exp_s)
    else:
        mant, exp = r, 0
    int_part, frac_part = (mant.split(".") + [""])[:2]

    all_digits = int_part + frac_part
    stripped = all_digits.lstrip("0")
    if not stripped:
        return "0"
    s = stripped.rstrip("0")          # the minimal significant digits
    trailing = len(stripped) - len(s)
    k = len(s)
    # value == s * 10^(n_pos - k), where n_pos is the ECMAScript exponent
    n_pos = (exp - len(frac_part) + trailing) + k

    if k <= n_pos <= 21:
        out = s + "0" * (n_pos - k)
    elif 0 < n_pos <= 21:
        out = s[:n_pos] + "." + s[n_pos:]
    elif -6 < n_pos <= 0:
        out = "0." + "0" * (-n_pos) + s
    else:
        e = n_pos - 1
        mant_out = s[0] + ("." + s[1:] if k > 1 else "")
        out = mant_out + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def canonical(value: Any) -> str:
    """Deterministic JSON: recursively key-sorted, byte-identical to the scheme the
    trace was hashed with on write."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    return "null"


def _sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def verify_trace(trace: Dict[str, Any]) -> Dict[str, Any]:
    """Recompute the whole chain locally.

    Returns {chain_valid, event_count, broken_at, platform_claim}. `broken_at` is
    the seq of the first event that fails to recompute/link, or None if intact.
    `platform_claim` is what Axon says — reported, never relied on.
    """
    trace_id = trace.get("traceId")
    events: List[Dict[str, Any]] = trace.get("events") or []
    prev_hash: Optional[str] = None
    expected_seq = 1
    broken_at: Optional[int] = None

    for e in events:
        meta = e.get("meta")
        meta_str = None if meta is None else canonical(meta)
        fields = {
            "traceId": trace_id,
            "seq": e.get("seq"),
            "taskId": e.get("taskId"),
            "kind": e.get("kind"),
            "fromAgent": e.get("fromAgent"),
            "toAgent": e.get("toAgent"),
            "workflowId": e.get("workflowId"),
            "stepIndex": e.get("stepIndex"),
            "inputHash": e.get("inputHash"),
            "outputHash": e.get("outputHash"),
            "model": e.get("model"),
            "inputTokens": e.get("inputTokens"),
            "outputTokens": e.get("outputTokens"),
            "costUsd": e.get("costUsd"),
            "latencyMs": e.get("latencyMs"),
            "meta": meta_str,
            "createdAt": e.get("createdAt"),
            "prevHash": e.get("prevHash"),
        }
        recomputed = _sha256hex(canonical(fields))
        if e.get("seq") != expected_seq or e.get("prevHash") != prev_hash or e.get("hash") != recomputed:
            broken_at = e.get("seq")
            break
        prev_hash = e.get("hash")
        expected_seq += 1

    return {
        "chain_valid": broken_at is None and len(events) > 0,
        "event_count": len(events),
        "broken_at": broken_at,
        "platform_claim": trace.get("verified"),
    }
