"""
Agent checkout, from the owner's side.

The centre of gravity is refusing to sign. A signature over a purchase is
non-repudiable, so the tests that matter most are the ones proving nothing gets
signed when the purchase isn't what the caller said it was.
"""

import base64
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from axon import AxonClient, CommerceRefused, assert_authorisation_matches, parse_authorisation
from axon.commerce import mandate_signer
from axon.errors import AxonApiError

EXPIRES = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")


def message(**over):
    fields = {
        "intent": "pi_1",
        "business": "shop.example",
        "items": "9f2c",
        "amount": "128.00 USD",
        "ceiling": "150.00 USD",
        "expires": EXPIRES,
    }
    fields.update(over)
    return "\n".join(
        ["Axon purchase authorisation"] + [f"{k}: {v}" for k, v in fields.items()]
    )


class FakeServer:
    """Stands in for the Axon API, recording what the SDK actually sent."""

    def __init__(self, get=None, post=None, raises=None):
        self._get = get
        self._post = post
        self._raises = raises
        self.calls = []

    def _request(self, method, path, *, body=None, headers=None):
        self.calls.append((method, path, body))
        if self._raises is not None:
            raise self._raises
        if method == "GET":
            return self._get(path) if callable(self._get) else self._get
        return self._post(path, body) if callable(self._post) else self._post


def api(server):
    from axon.commerce import CommerceApi

    return CommerceApi(server)


# ── The parser is the security boundary ──────────────────────────────────────


def test_parses_every_field_the_server_verifies():
    auth = parse_authorisation(message())
    assert (auth.intent_id, auth.business, auth.amount, auth.currency, auth.ceiling) == (
        "pi_1",
        "shop.example",
        128.0,
        "USD",
        150.0,
    )


def test_refuses_a_message_it_does_not_recognise():
    with pytest.raises(CommerceRefused, match="not an Axon purchase authorisation"):
        parse_authorisation("please sign this\nintent: pi_1")


def test_refuses_a_duplicated_field_instead_of_taking_the_first():
    # Take the first match and an injected line shadows the real amount, so a
    # signature the buyer thinks covers 1.00 actually covers 4999.00.
    shadowed = "\n".join(
        [
            "Axon purchase authorisation",
            "intent: pi_1",
            "business: shop.example",
            "items: 9f",
            "amount: 1.00 USD",
            "amount: 4999.00 USD",
            "ceiling: 5000.00 USD",
            f"expires: {EXPIRES}",
        ]
    )
    with pytest.raises(CommerceRefused, match="7 fields, expected 6"):
        parse_authorisation(shadowed)


def test_refuses_fields_out_of_order():
    swapped = "\n".join(
        [
            "Axon purchase authorisation",
            "business: shop.example",
            "intent: pi_1",
            "items: 9f",
            "amount: 128.00 USD",
            "ceiling: 150.00 USD",
            f"expires: {EXPIRES}",
        ]
    )
    with pytest.raises(CommerceRefused, match="expected 'intent' at line 2"):
        parse_authorisation(swapped)


def test_refuses_trailing_junk_and_unreadable_expiry():
    with pytest.raises(CommerceRefused, match="could not read the amount"):
        parse_authorisation(message(amount="128.00 USD and a pony"))
    with pytest.raises(CommerceRefused, match="no readable expiry"):
        parse_authorisation(message(expires="whenever"))


# ── Holding a purchase against what you expected ─────────────────────────────


def test_a_reprice_into_another_currency_is_refused_not_compared():
    eur = parse_authorisation(message(amount="120.00 EUR", ceiling="150.00 EUR"))
    # 120 < 150, so a bare numeric check would wave this through.
    with pytest.raises(CommerceRefused) as exc:
        assert_authorisation_matches(eur, max_amount=150, currency="USD")
    assert exc.value.reason == "CURRENCY_MISMATCH"


def test_refuses_amount_business_and_expiry():
    auth = parse_authorisation(message())
    with pytest.raises(CommerceRefused, match="above the 100.00"):
        assert_authorisation_matches(auth, max_amount=100)
    with pytest.raises(CommerceRefused, match="not one you expected"):
        assert_authorisation_matches(auth, business=["other.example"])
    assert_authorisation_matches(auth, business=["SHOP.EXAMPLE"])  # case-insensitive
    stale = parse_authorisation(
        message(expires=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"))
    )
    with pytest.raises(CommerceRefused, match="already expired"):
        assert_authorisation_matches(stale)


# ── approve() ────────────────────────────────────────────────────────────────


def test_signs_the_servers_own_message_and_sends_it():
    server = FakeServer(
        get={"intentId": "pi_1", "message": message(), "wallet": "W", "expiresAt": EXPIRES},
        post={"intentId": "pi_1", "status": "purchased", "orderId": "o_1"},
    )
    signed = []
    result = api(server).approve(
        "pi_1",
        sign=lambda m: signed.append(m) or "SIG",
        max_amount=150,
        currency="USD",
        business="shop.example",
        payment_instrument={"id": "i", "handlerId": "h", "type": "card", "credential": {}},
    )
    assert signed == [message()]
    assert result["orderId"] == "o_1"
    assert result["authorisation"].amount == 128.0
    post = [c for c in server.calls if c[0] == "POST"][0]
    assert post[2]["signature"] == "SIG"


def test_does_not_sign_or_post_when_the_purchase_moved():
    server = FakeServer(
        get={"intentId": "pi_1", "message": message(amount="900.00 USD"), "wallet": "W", "expiresAt": EXPIRES}
    )
    calls = []
    with pytest.raises(CommerceRefused) as exc:
        api(server).approve("pi_1", sign=lambda m: calls.append(m) or "SIG", max_amount=150)
    assert exc.value.reason == "OVER_EXPECTED_AMOUNT"
    assert calls == []
    assert all(c[0] == "GET" for c in server.calls)


def test_bounds_apply_to_a_signature_produced_elsewhere():
    # Hardware wallets, remote signers and custody services produce the signature
    # out of band. They state the same bounds, and a bound that only bites when
    # the SDK holds the key reads as a limit while enforcing nothing.
    server = FakeServer(
        get={"intentId": "pi_1", "message": message(amount="4999.00 USD"), "wallet": "W", "expiresAt": EXPIRES},
        post={"intentId": "pi_1", "status": "purchased", "orderId": "o_1"},
    )
    with pytest.raises(CommerceRefused) as exc:
        api(server).approve("pi_1", signature="SIGNED_ELSEWHERE", max_amount=150, currency="USD")
    assert exc.value.reason == "OVER_EXPECTED_AMOUNT"
    assert all(c[0] == "GET" for c in server.calls)


def test_refuses_an_authorisation_for_a_different_purchase():
    server = FakeServer(
        get={"intentId": "pi_2", "message": message(intent="pi_2"), "wallet": "W", "expiresAt": EXPIRES}
    )
    with pytest.raises(CommerceRefused, match="is for pi_2, not pi_1"):
        api(server).approve("pi_1", sign=lambda m: "SIG")


def test_insists_on_a_signer():
    server = FakeServer()
    with pytest.raises(CommerceRefused, match="approving is signing"):
        api(server).approve("pi_1")
    with pytest.raises(CommerceRefused, match="not both"):
        api(server).approve("pi_1", sign=lambda m: "s", signature="s")


def test_no_payment_credential_is_awaiting_payment_not_bought():
    server = FakeServer(
        get={"intentId": "pi_1", "message": message(), "wallet": "W", "expiresAt": EXPIRES},
        post={"intentId": "pi_1", "status": "approved", "reason": "NO_PAYMENT_INSTRUMENT"},
    )
    result = api(server).approve("pi_1", sign=lambda m: "SIG")
    assert result["awaitingPayment"] is True
    assert "orderId" not in result


# ── A refusal is a refusal, whoever made it ──────────────────────────────────


def test_a_server_side_refusal_is_a_commerce_refused():
    # The re-checks at the charge — price moved, currency changed, budget
    # committed — all arrive this way.
    err = AxonApiError(
        "HTTP 502",
        502,
        "POST",
        "/api/commerce/intents/pi_1/decision",
        body={"reason": "CURRENCY_CHANGED", "purchaseError": "The business is now pricing in EUR."},
    )
    server = FakeServer(raises=err)
    with pytest.raises(CommerceRefused) as exc:
        api(server).list_mandates()
    assert exc.value.reason == "CURRENCY_CHANGED"
    assert "pricing in EUR" in str(exc.value)


def test_an_ordinary_failure_is_left_alone():
    server = FakeServer(raises=AxonApiError("network down", 500, "GET", "/x"))
    with pytest.raises(AxonApiError):
        api(server).list_profiles()


# ── Nothing waiting should ever be invisible ─────────────────────────────────


def test_pending_asks_for_the_largest_page():
    server = FakeServer(get={"intents": [], "summary": {}})
    api(server).pending()
    path = server.calls[0][1]
    assert "limit=200" in path and "status=proposed" in path


def test_get_purchase_fetches_one_by_id():
    server = FakeServer(get={"intentId": "pi_9", "status": "proposed"})
    assert api(server).get_purchase("pi_9")["intentId"] == "pi_9"
    assert server.calls[0][1] == "/api/commerce/intents/pi_9"


# ── auto_approve ─────────────────────────────────────────────────────────────


def test_auto_approve_refuses_to_exist_with_any_bound_left_open():
    server = FakeServer()
    base = dict(max_amount=50, currency="USD", allowed_hosts=["shop.example"], sign=lambda m: "s")
    for override, match in [
        ({"max_amount": 0}, "positive max_amount"),
        ({"allowed_hosts": []}, "allowed_hosts"),
        ({"currency": ""}, "currency"),
        ({"sign": None}, "signer"),
    ]:
        with pytest.raises(CommerceRefused, match=match):
            api(server).auto_approve(**{**base, **override})


def test_auto_approve_leaves_a_purchase_outside_the_policy_alone():
    def get(path):
        if path.startswith("/api/commerce/intents?"):
            return {"intents": [{"intentId": "pi_1", "status": "proposed"}], "summary": {}}
        return {"intentId": "pi_1", "message": message(amount="900.00 USD"), "wallet": "W", "expiresAt": EXPIRES}

    server = FakeServer(get=get)
    skipped = []
    handle = api(server).auto_approve(
        max_amount=50,
        currency="USD",
        allowed_hosts=["shop.example"],
        sign=lambda m: "SIG",
        interval_seconds=1,
        on_skipped=lambda intent, reason: skipped.append(reason),
    )
    deadline = time.time() + 3
    while not skipped and time.time() < deadline:
        time.sleep(0.05)
    handle.stop()
    assert skipped == ["OVER_EXPECTED_AMOUNT"]
    # Never posts a decision for something it refused.
    assert all(c[0] == "GET" for c in server.calls)


# ── watch ────────────────────────────────────────────────────────────────────


def test_watch_hands_over_each_purchase_once_and_retries_a_failed_handler():
    server = FakeServer(get={"intents": [{"intentId": "pi_1", "status": "proposed"}], "summary": {}})
    attempts = []

    def on_proposed(intent):
        attempts.append(intent["intentId"])
        if len(attempts) < 2:
            raise RuntimeError("upstream hiccup")

    handle = api(server).watch(on_proposed, interval_seconds=1, on_error=lambda e: None)
    deadline = time.time() + 4
    while len(attempts) < 2 and time.time() < deadline:
        time.sleep(0.05)
    handle.stop()
    # Retried after failing, then delivered once and left alone.
    assert len(attempts) >= 2


# ── Signing ──────────────────────────────────────────────────────────────────


def test_mandate_signer_matches_what_axon_verifies():
    # Axon verifies with Ed25519 against the buyer's wallet bytes. If this
    # round-trip fails, every approval made from Python fails.
    crypto = pytest.importorskip("cryptography")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.exceptions import InvalidSignature

    private = Ed25519PrivateKey.generate()
    from cryptography.hazmat.primitives import serialization

    seed = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    secret_key = seed + public  # a Solana secret key is seed || public

    msg = message()
    signature = base64.b64decode(mandate_signer(secret_key)(msg))
    private.public_key().verify(signature, msg.encode("utf-8"))  # raises if wrong

    with pytest.raises(InvalidSignature):
        private.public_key().verify(signature, message(amount="900.00 USD").encode("utf-8"))


def test_mandate_signer_refuses_a_key_it_cannot_use():
    with pytest.raises(TypeError, match="64-byte"):
        mandate_signer(bytes(32))


# ── What the fifth pass found ────────────────────────────────────────────────


def test_an_id_cannot_redirect_the_call_to_another_endpoint():
    # quote() leaves "/" alone by default and requests normalises "..", so an id
    # carrying either would send the request somewhere this method never named.
    from axon.commerce import _seg

    assert _seg("../../auth/challenge") == "..%2F..%2Fauth%2Fchallenge"
    assert "/" not in _seg("a/b")

    server = FakeServer(get={"intentId": "x"})
    api(server).get_purchase("../mandates")
    assert server.calls[0][1] == "/api/commerce/intents/..%2Fmandates"


def test_a_refusal_nested_under_details_is_still_a_refusal():
    # Structured Axon errors nest it under `details`; the checkout routes return
    # it at the top level. Both are refusals and both should read as one.
    from axon.commerce import _as_refusal

    nested = AxonApiError(
        "signature does not match",
        400,
        "POST",
        "/x",
        code="VALIDATION_ERROR",
        body={"error": "signature does not match", "details": {"reason": "BAD_SIGNATURE"}},
    )
    refusal = _as_refusal(nested, "pi_1")
    assert refusal is not None and refusal.reason == "BAD_SIGNATURE"

    top_level = AxonApiError("HTTP 502", 502, "POST", "/x", body={"reason": "CURRENCY_CHANGED"})
    assert _as_refusal(top_level, "pi_1").reason == "CURRENCY_CHANGED"

    assert _as_refusal(AxonApiError("network down", 500, "GET", "/x"), "pi_1") is None


def test_the_watcher_does_not_swallow_a_keyboard_interrupt():
    # Catching BaseException in a poll loop turns Ctrl-C and sys.exit() into a
    # log line and keeps going.
    import inspect

    from axon import commerce as commerce_module

    source = inspect.getsource(commerce_module.CommerceApi.watch)
    assert "except BaseException" not in source
    assert "except Exception" in source


def test_a_watcher_can_be_waited_on():
    # The poll runs on a daemon thread, so a script whose only job is watching
    # exits having watched nothing unless it waits.
    server = FakeServer(get={"intents": [], "summary": {}})
    handle = api(server).watch(lambda intent: None, interval_seconds=1)
    threading.Timer(0.5, handle.stop).start()
    started = time.time()
    handle.wait()
    assert time.time() - started >= 0.4
