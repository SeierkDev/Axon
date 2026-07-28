"""
Agent checkout, from the owner's side.

An agent with the ``commerce`` grant can search real businesses and propose a
purchase. It has no tool that buys. Between the proposal and the charge sits one
thing: a signature from the owner's wallet over a message naming this exact cart
at this exact price.

That signature is non-repudiable, which cuts both ways — it is proof you agreed,
so signing something you did not read is the whole risk of this feature.
Everything here is built so you never have to: :meth:`CommerceApi.approve`
fetches the real authorisation, parses it, holds it against what you say you
expect, and only then signs.
"""

import base64
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Union
from urllib.parse import quote, urlencode

from .errors import AxonApiError

#: Signs an authorisation message, returning a base64 Ed25519 signature.
SignMandate = Callable[[str], str]

def _seg(value: str) -> str:
    """Escape a value going into a path segment.

    ``quote`` leaves ``/`` alone by default, and requests normalises ``..``
    before sending — so an id carrying either would quietly redirect the call to
    a different endpoint than the one this method names. Escape everything.
    """
    return quote(str(value), safe="")


_HEADER = "Axon purchase authorisation"
_FIELDS = ("intent", "business", "items", "amount", "ceiling", "expires")


class CommerceRefused(Exception):
    """A purchase that was stopped rather than made.

    ``reason`` is the machine-readable cause, so callers can tell "the price
    moved" from "you have no budget left" without matching on prose.
    """

    def __init__(self, message: str, reason: str, intent_id: Optional[str] = None):
        super().__init__(message)
        self.reason = reason
        self.intent_id = intent_id


@dataclass
class Authorisation:
    """The authorisation, broken into fields you can check before signing."""

    intent_id: str
    business: str
    items_hash: str
    amount: float
    currency: str
    ceiling: float
    expires_at: str


def parse_authorisation(message: str) -> Authorisation:
    """Read the authorisation the server will verify.

    Deliberately rigid: exactly the header and exactly these six fields, in this
    order, once each. A lenient parser here would be the weak point of the whole
    feature — search for a field and take the first hit, and a value carrying a
    newline could shadow the real one, so a signature meant for 5 covers 5 000.
    """
    lines = [line.strip() for line in message.split("\n") if line.strip()]
    if not lines or lines[0] != _HEADER:
        raise CommerceRefused(
            "this is not an Axon purchase authorisation — refusing to sign it",
            "UNRECOGNISED_MESSAGE",
        )
    if len(lines) != len(_FIELDS) + 1:
        raise CommerceRefused(
            f"the authorisation has {len(lines) - 1} fields, expected {len(_FIELDS)} — refusing to sign it",
            "MALFORMED_MESSAGE",
        )

    values: Dict[str, str] = {}
    for i, name in enumerate(_FIELDS):
        line = lines[i + 1]
        if not line.startswith(f"{name}: "):
            raise CommerceRefused(
                f"expected '{name}' at line {i + 2} of the authorisation — refusing to sign it",
                "MALFORMED_MESSAGE",
            )
        values[name] = line[len(name) + 2 :].strip()

    def money(name: str) -> "tuple[float, str]":
        parts = values[name].split()
        if len(parts) != 2:
            raise CommerceRefused(
                f"could not read the {name} in the authorisation — refusing to sign it",
                "MALFORMED_MESSAGE",
            )
        try:
            return float(parts[0]), parts[1].upper()
        except ValueError:
            raise CommerceRefused(
                f"could not read the {name} in the authorisation — refusing to sign it",
                "MALFORMED_MESSAGE",
            ) from None

    amount, currency = money("amount")
    ceiling, _ = money("ceiling")
    if not values["intent"] or not values["business"]:
        raise CommerceRefused(
            "the authorisation is missing its subject — refusing to sign it", "MALFORMED_MESSAGE"
        )
    if _parse_iso(values["expires"]) is None:
        raise CommerceRefused(
            "the authorisation has no readable expiry — refusing to sign it", "MALFORMED_MESSAGE"
        )
    return Authorisation(
        intent_id=values["intent"],
        business=values["business"],
        items_hash=values["items"],
        amount=amount,
        currency=currency,
        ceiling=ceiling,
        expires_at=values["expires"],
    )


def _parse_iso(value: str) -> Optional[float]:
    """Epoch seconds for an ISO-8601 timestamp, or None if it isn't one."""
    from datetime import datetime, timezone

    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def assert_authorisation_matches(
    auth: Authorisation,
    *,
    max_amount: Optional[float] = None,
    currency: Optional[str] = None,
    business: Optional[Union[str, Sequence[str]]] = None,
    intent_id: Optional[str] = None,
) -> None:
    """Hold an authorisation against what the caller believes they are approving.

    Raises rather than returning False: the only safe default when a purchase
    does not match its description is to not sign it.
    """
    import time as _time

    def refuse(message: str, reason: str) -> None:
        raise CommerceRefused(message, reason, intent_id or auth.intent_id)

    if currency and auth.currency != currency.upper():
        refuse(
            f"this purchase is priced in {auth.currency}, not the {currency.upper()} you expected"
            " — nothing was signed",
            "CURRENCY_MISMATCH",
        )
    if max_amount is not None and auth.amount > max_amount:
        refuse(
            f"this purchase is {auth.amount:.2f} {auth.currency}, above the {max_amount:.2f}"
            " you expected — nothing was signed",
            "OVER_EXPECTED_AMOUNT",
        )
    if business:
        allowed = [business] if isinstance(business, str) else list(business)
        if auth.business.strip().lower() not in [h.strip().lower() for h in allowed]:
            refuse(
                f"this purchase is from {auth.business}, which is not one you expected"
                " — nothing was signed",
                "UNEXPECTED_BUSINESS",
            )
    expires = _parse_iso(auth.expires_at)
    if expires is not None and expires <= _time.time():
        refuse("this authorisation has already expired — nothing was signed", "EXPIRED")


def _as_refusal(exc: BaseException, intent_id: Optional[str] = None) -> Optional[CommerceRefused]:
    """Pull the machine-readable cause out of a failed request.

    The server refuses purchases for reasons the caller needs to branch on — the
    price moved, the currency changed, the budget is committed elsewhere. Those
    arrive as an API error carrying a ``reason``, which is the same thing this
    module's own guard produces, so they are worth presenting as the same type.
    """
    if not isinstance(exc, AxonApiError):
        return None
    body = exc.body if isinstance(exc.body, dict) else {}
    # Structured Axon errors nest it under `details`; the checkout routes return
    # it at the top level. Both are refusals and both should read as one.
    sources = (body, body.get("details"), getattr(exc, "details", None))
    reason = next(
        (s["reason"] for s in sources if isinstance(s, dict) and isinstance(s.get("reason"), str)),
        None,
    )
    if reason is None:
        return None
    detail = body.get("purchaseError")
    return CommerceRefused(detail or str(exc), reason, intent_id)


class WatchHandle:
    """Stop a running watcher, or wait on it. Safe to stop more than once."""

    def __init__(self, stop: Callable[[], None], stopped: "threading.Event"):
        self._stop = stop
        self._stopped = stopped

    def stop(self) -> None:
        self._stop()

    def wait(self, timeout: Optional[float] = None) -> None:
        """Block until the watcher is stopped.

        The poll runs on a daemon thread, so it dies with the process — which
        means a script whose whole job is watching exits the moment it starts
        unless it waits here. Ctrl-C stops it.
        """
        try:
            while not self._stopped.wait(timeout if timeout is not None else 0.5):
                if timeout is not None:
                    return
        except KeyboardInterrupt:
            self.stop()

    def __enter__(self) -> "WatchHandle":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.stop()


class CommerceApi:
    """``client.commerce`` — the owner's side of agent checkout."""

    def __init__(self, client: Any):
        self._client = client

    def _call(self, method: str, path: str, body: Any = None, intent_id: Optional[str] = None) -> Any:
        try:
            return self._client._request(method, path, body=body)
        except AxonApiError as exc:
            refusal = _as_refusal(exc, intent_id)
            if refusal is not None:
                raise refusal from exc
            raise

    # ── Where orders go ──────────────────────────────────────────────────────

    def create_profile(
        self, *, label: str, contact: Dict[str, str], address: Dict[str, str]
    ) -> Dict[str, Any]:
        """Store a delivery destination. Encrypted at rest; never shown to an agent."""
        return self._call(
            "POST", "/api/commerce/profiles", {"label": label, "contact": contact, "address": address}
        )

    def list_profiles(self) -> List[Dict[str, Any]]:
        return self._call("GET", "/api/commerce/profiles")["profiles"]

    def forget_profile(self, profile_id: str) -> Dict[str, Any]:
        """Erase a profile's personal data, keeping the purchase history intact."""
        return self._call("DELETE", f"/api/commerce/profiles?id={_seg(profile_id)}")

    # ── What it may spend ────────────────────────────────────────────────────

    def grant_mandate(
        self,
        *,
        agent_id: str,
        profile_id: str,
        max_per_purchase: float,
        max_per_period: float,
        period: Optional[str] = None,
        currency: Optional[str] = None,
        auto_approve_under: Optional[float] = None,
        allowed_hosts: Optional[Sequence[str]] = None,
        expires_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Give an agent a budget. It must already hold the ``commerce`` grant."""
        body: Dict[str, Any] = {
            "agentId": agent_id,
            "profileId": profile_id,
            "maxPerPurchase": max_per_purchase,
            "maxPerPeriod": max_per_period,
        }
        if period is not None:
            body["period"] = period
        if currency is not None:
            body["currency"] = currency
        if auto_approve_under is not None:
            body["autoApproveUnder"] = auto_approve_under
        if allowed_hosts is not None:
            body["allowedHosts"] = list(allowed_hosts)
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return self._call("POST", "/api/commerce/mandates", body)

    def list_mandates(self) -> List[Dict[str, Any]]:
        return self._call("GET", "/api/commerce/mandates")["mandates"]

    def revoke_mandate(self, mandate_id: str) -> Dict[str, Any]:
        return self._call("DELETE", f"/api/commerce/mandates?id={_seg(mandate_id)}")

    def stop_all_spending(self) -> Dict[str, Any]:
        """Revoke every mandate at once and stop anything in flight."""
        return self._call("POST", "/api/commerce/kill", {})

    # ── What it wants to buy ─────────────────────────────────────────────────

    def list_purchases(
        self, *, status: Optional[str] = None, limit: Optional[int] = None, refresh: bool = False
    ) -> Dict[str, Any]:
        """Purchases and a spend summary.

        The summary's ``pending`` counts everything in flight — proposed *and*
        approved-but-not-yet-charged. That is a different set from
        :meth:`pending`, which is only what still waits on your decision: a
        purchase you just approved leaves that list and stays counted here until
        it settles.
        """
        query: Dict[str, Any] = {}
        if limit is not None:
            query["limit"] = limit
        if status is not None:
            query["status"] = status
        if refresh:
            query["refresh"] = "1"
        suffix = f"?{urlencode(query)}" if query else ""
        return self._call("GET", f"/api/commerce/intents{suffix}")

    def pending(self) -> List[Dict[str, Any]]:
        """The purchases waiting on you.

        Asks for the largest page the server will give: this drives
        :meth:`watch` and :meth:`auto_approve`, and a purchase that falls off the
        end of a page is one nobody is ever shown.
        """
        return self.list_purchases(status="proposed", limit=200)["intents"]

    def get_purchase(self, intent_id: str) -> Dict[str, Any]:
        """One purchase, by id — what a ``purchase.proposed`` webhook gives you."""
        return self._call("GET", f"/api/commerce/intents/{_seg(intent_id)}", intent_id=intent_id)

    def get_approval_request(self, intent_id: str) -> Dict[str, Any]:
        """The exact text the server will verify a signature against."""
        return self._call(
            "GET", f"/api/commerce/intents/{_seg(intent_id)}/decision", intent_id=intent_id
        )

    def get_payment_options(self, intent_id: str) -> Dict[str, Any]:
        """Which payment handler this purchase needs, read live from the business."""
        return self._call(
            "GET", f"/api/commerce/intents/{_seg(intent_id)}/payment", intent_id=intent_id
        )

    def decline(self, intent_id: str) -> Dict[str, Any]:
        return self._call(
            "POST",
            f"/api/commerce/intents/{_seg(intent_id)}/decision",
            {"decision": "decline"},
            intent_id=intent_id,
        )

    def approve(
        self,
        intent_id: str,
        *,
        sign: Optional[SignMandate] = None,
        signature: Optional[str] = None,
        max_amount: Optional[float] = None,
        currency: Optional[str] = None,
        business: Optional[Union[str, Sequence[str]]] = None,
        payment_instrument: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Approve a purchase.

        The authorisation the server will verify is fetched, parsed, and held
        against whatever bounds you state — ``max_amount``, ``currency``,
        ``business`` — and only then signed. A purchase that moved underneath you
        raises :class:`CommerceRefused` and nothing is signed or sent.

        The bounds apply whichever way you sign, including a ``signature`` you
        produced out of band with a hardware wallet or custody service.

        Without a ``payment_instrument`` the approval is recorded and the
        purchase waits: ``awaitingPayment`` comes back true and no money moved.
        """
        if sign is None and signature is None:
            raise CommerceRefused(
                "approving is signing — pass `sign` (a signer) or `signature` (one you made yourself)",
                "NO_SIGNER",
                intent_id,
            )
        if sign is not None and signature is not None:
            raise CommerceRefused(
                "pass either `sign` or `signature`, not both", "AMBIGUOUS_SIGNER", intent_id
            )

        has_expectation = max_amount is not None or currency is not None or business is not None
        authorisation: Optional[Authorisation] = None

        if sign is not None or has_expectation:
            request = self.get_approval_request(intent_id)
            authorisation = parse_authorisation(request["message"])
            if authorisation.intent_id != intent_id:
                raise CommerceRefused(
                    f"the authorisation is for {authorisation.intent_id}, not {intent_id}"
                    " — nothing was approved",
                    "INTENT_MISMATCH",
                    intent_id,
                )
            if has_expectation:
                assert_authorisation_matches(
                    authorisation,
                    max_amount=max_amount,
                    currency=currency,
                    business=business,
                    intent_id=intent_id,
                )
            if sign is not None:
                signature = sign(request["message"])
                if not signature:
                    raise CommerceRefused(
                        "the signer returned no signature", "NO_SIGNATURE", intent_id
                    )

        body: Dict[str, Any] = {"decision": "approve", "signature": signature}
        if payment_instrument is not None:
            body["paymentInstrument"] = payment_instrument

        result = self._call(
            "POST", f"/api/commerce/intents/{_seg(intent_id)}/decision", body, intent_id=intent_id
        )
        if authorisation is not None:
            result["authorisation"] = authorisation
        if result.get("reason") == "NO_PAYMENT_INSTRUMENT" or (
            payment_instrument is None and not result.get("orderId")
        ):
            result["awaitingPayment"] = True
        return result

    # ── Standing over it ─────────────────────────────────────────────────────

    def watch(
        self,
        on_proposed: Callable[[Dict[str, Any]], Any],
        *,
        interval_seconds: float = 15.0,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> WatchHandle:
        """Call ``on_proposed`` once per purchase an agent puts up.

        Runs on a daemon thread, so it dies with the process: a script whose
        only job is watching must call ``wait()`` on the handle, or it exits
        having watched nothing. Use it as a context manager, or call ``stop()``,
        when something else owns the lifecycle. A purchase whose handler raises
        is retried on the next poll rather than dropped — only a decision is
        final.
        """
        seen: set = set()
        stop_event = threading.Event()

        def report(exc: Exception) -> None:
            if on_error is not None:
                on_error(exc)
            else:
                print(f"[axon] watch: purchase poll failed — {exc!r}")

        def loop() -> None:
            while not stop_event.is_set():
                try:
                    pending = self.pending()
                    for intent in pending:
                        if stop_event.is_set():
                            break
                        intent_id = intent["intentId"]
                        if intent_id in seen:
                            continue
                        seen.add(intent_id)
                        try:
                            on_proposed(intent)
                        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                            # Handled-and-failed is not handled. Forget it so the
                            # next poll retries: a store having a bad minute
                            # should not cost a purchase its only chance.
                            seen.discard(intent_id)
                            report(exc)
                    # Forget anything no longer pending, so `seen` stays the size
                    # of the queue rather than growing for the life of the
                    # process. An intent never returns to `proposed`.
                    live = {i["intentId"] for i in pending}
                    seen.intersection_update(live)
                except Exception as exc:  # noqa: BLE001
                    report(exc)
                stop_event.wait(max(1.0, interval_seconds))

        thread = threading.Thread(target=loop, name="axon-commerce-watch", daemon=True)
        thread.start()
        return WatchHandle(stop_event.set, stop_event)

    def auto_approve(
        self,
        *,
        max_amount: float,
        currency: str,
        allowed_hosts: Sequence[str],
        sign: SignMandate,
        payment_instrument: Optional[Callable[[Dict[str, Any], Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
        on_approved: Optional[Callable[[Dict[str, Any]], Any]] = None,
        on_skipped: Optional[Callable[[Dict[str, Any], str], Any]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        interval_seconds: float = 15.0,
    ) -> WatchHandle:
        """Approve matching purchases without a human in the loop.

        Every bound is required. An auto-approver with an open bound is a blank
        cheque signed with your own key, so this refuses to be constructed
        without an amount, a currency, and an explicit list of businesses.
        Anything outside the policy is left alone for you to decide, never
        declined on your behalf.
        """
        if not max_amount or max_amount <= 0:
            raise CommerceRefused("auto_approve needs a positive max_amount", "NO_LIMIT")
        if not allowed_hosts:
            raise CommerceRefused(
                "auto_approve needs an explicit allowed_hosts list — it will not approve"
                " purchases from anywhere",
                "NO_ALLOWED_HOSTS",
            )
        if not currency:
            raise CommerceRefused("auto_approve needs a currency", "NO_CURRENCY")
        if not callable(sign):
            raise CommerceRefused("auto_approve needs a signer", "NO_SIGNER")

        hosts = list(allowed_hosts)

        def handle(intent: Dict[str, Any]) -> None:
            try:
                instrument = None
                if payment_instrument is not None:
                    # Read the handlers before signing, so a purchase that cannot
                    # be paid is skipped rather than left signed and stranded.
                    options = self.get_payment_options(intent["intentId"])
                    instrument = payment_instrument(intent, options)
                result = self.approve(
                    intent["intentId"],
                    sign=sign,
                    max_amount=max_amount,
                    currency=currency,
                    business=hosts,
                    payment_instrument=instrument,
                )
                if on_approved is not None:
                    on_approved(result)
            except CommerceRefused as refused:
                # The policy said no. That answer will not change, so let it
                # stand and leave the purchase for its owner to decide.
                if on_skipped is not None:
                    on_skipped(intent, refused.reason)
                return
            # Anything else — a timeout, a 503, a store having a bad minute — is
            # not a decision. Let it out: watch() reports it and retries.

        return self.watch(handle, interval_seconds=interval_seconds, on_error=on_error)


# ── Signing ───────────────────────────────────────────────────────────────────


def mandate_signer(secret_key: Union[bytes, bytearray, Iterable[int]]) -> SignMandate:
    """Sign purchase authorisations with a raw Solana key, server-side.

        from axon import AxonClient, mandate_signer

        client.commerce.approve(
            intent_id,
            sign=mandate_signer(secret_key),
            max_amount=150, currency="USD", business="shop.example",
        )

    The signature is Ed25519 over the raw message bytes, base64 — the same thing
    a browser wallet's ``signMessage`` produces, and what Axon verifies against
    the buyer's wallet address.

    Needs ``cryptography``: ``pip install "axonsdk[signing]"``. This key
    authorises real money with no prompt in front of it, so state your bounds on
    every :meth:`CommerceApi.approve`; without them you are signing whatever you
    are handed.
    """
    raw = bytes(secret_key)
    if len(raw) != 64:
        raise TypeError(f"expected a 64-byte Solana secret key, got {len(raw)} bytes")
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise ImportError(
            'mandate_signer needs the "cryptography" package — pip install "axonsdk[signing]"'
        ) from exc

    # The seed is the first 32 bytes of a Solana secret key; the rest is the
    # public key, which Ed25519PrivateKey derives for itself.
    key = Ed25519PrivateKey.from_private_bytes(raw[:32])

    def sign(message: str) -> str:
        return base64.b64encode(key.sign(message.encode("utf-8"))).decode("ascii")

    return sign
