"""Offline verification tests — the receipt verifier against a real captured
production trace + every tamper class, plus JS-number and Proof-Score helpers."""

import json
import os

from axon.verify import _curve, _js_math_round, _js_number, _js_round, _proven_work_factor, verify_trace

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "trace-valid.json")


def _load():
    with open(FIX) as f:
        return json.load(f)


def test_valid_trace_recomputes():
    r = verify_trace(_load())
    assert r.chain_valid is True and r.broken_at is None
    assert r.event_count == len(_load()["events"])
    assert r.chain_valid == r.platform_claim  # agrees with the platform, but recomputed


def test_catches_edited_field():
    t = _load()
    v = next((e for e in t["events"] if e["seq"] == 2), t["events"][1])
    v["outputTokens"] = (v.get("outputTokens") or 0) + 1
    r = verify_trace(t)
    assert r.chain_valid is False and r.broken_at == 2


def test_catches_reorder():
    t = _load()
    if len(t["events"]) >= 3:
        t["events"][1], t["events"][2] = t["events"][2], t["events"][1]
    assert verify_trace(t).chain_valid is False


def test_catches_deletion():
    t = _load()
    t["events"] = [e for e in t["events"] if e["seq"] != 2]
    assert verify_trace(t).chain_valid is False


def test_empty_trace_not_valid():
    t = _load()
    t["events"] = []
    r = verify_trace(t)
    assert r.chain_valid is False and r.event_count == 0


def test_js_number_matches_javascript():
    # byte-exact with JSON.stringify across the tricky cases (incl. 9-decimal SOL)
    cases = {
        0.123456789: "0.123456789", 0.1: "0.1", 0.25: "0.25", 5.0: "5",
        100000.0: "100000", 0.000001: "0.000001", 0.0000001: "1e-7",
        1e-9: "1e-9", 0.05: "0.05", 123.456: "123.456", 0.0: "0",
    }
    for value, expected in cases.items():
        assert _js_number(value) == expected, f"{value!r} -> {_js_number(value)} != {expected}"
    assert _js_number(7) == "7" and _js_number(True) == "true"


def test_proof_score_helpers():
    assert _curve(0, 30) == 0.0
    assert _curve(10_000, 30) == 1.0  # saturates
    v = _proven_work_factor(40, 120)
    assert 0.0 < v <= 1.0


def test_js_math_round_matches_javascript():
    # ties round toward +Infinity; the ULP just below .5 rounds DOWN — where a naive
    # floor(x + 0.5) would wrongly give 1 and cause a spurious score mismatch.
    assert _js_math_round(0.49999999999999994) == 0.0
    assert _js_math_round(0.5) == 1.0
    assert _js_math_round(2.5) == 3.0
    assert _js_math_round(-0.5) == 0.0
    assert _js_round(977.6, 0) == 978.0
    assert _js_round(0.1234565, 6) == 0.123457
