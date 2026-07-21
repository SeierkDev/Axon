"""hire() tests against a fake client — free lane, paid (x402), guard, timeout."""

import pytest

from axon import hire


class FakeClient:
    base_url = "https://x"

    def __init__(self, requirements, task_states, receipt=None):
        self._requirements = requirements
        self._states = list(task_states)  # successive get_task returns
        self._receipt = receipt
        self.sent = None
        self.paid_with = None

    def get_x402_requirements(self, to):
        return self._requirements

    def send_task(self, to, task, from_agent="anonymous", context=None, payment_signature=None, payer_wallet=None, payment_method=None):
        self.sent = {"to": to, "task": task, "from_agent": from_agent, "payment_signature": payment_signature, "payer_wallet": payer_wallet, "payment_method": payment_method}
        return {"taskId": "t1", "status": "queued", "claimToken": "tok"}

    def get_task(self, task_id, claim_token=None):
        return self._states.pop(0) if self._states else {"status": "queued"}

    def get_receipt(self, task_id):
        return self._receipt


def test_free_lane_polls_to_completion():
    c = FakeClient(None, [{"status": "running"}, {"status": "completed", "output": "the answer"}], receipt={"taskId": "t1"})
    r = hire(c, to="agent", task="do it", poll_interval_seconds=0.001)
    assert r.paid is False and r.status == "completed"
    assert r.output == "the answer" and r.receipt == {"taskId": "t1"}
    assert r.receipt_url == "https://x/r/t1"  # public shareable proof, always set
    assert c.sent["payment_signature"] is None


def test_paid_lane_pays_and_hires():
    reqs = {"accepts": [{"maxAmountRequired": "250000", "payToAddress": "TREASURY"}]}
    c = FakeClient(reqs, [{"status": "completed", "output": "done"}])
    calls = {}

    def pay(requirements):
        calls["req"] = requirements
        return ("sig", "PAYER")

    r = hire(c, to="code-agent", task="audit", pay=pay, poll_interval_seconds=0.001)
    assert r.paid is True and r.output == "done"
    assert c.sent["payment_signature"] == "sig" and c.sent["payer_wallet"] == "PAYER"
    assert calls["req"] == reqs


def test_paid_without_pay_raises():
    c = FakeClient({"accepts": []}, [])
    with pytest.raises(ValueError, match="priced"):
        hire(c, to="code-agent", task="audit")


def test_balance_funds_from_earned_balance():
    # A priced agent, but funded from the caller's balance — no probe, no pay.
    c = FakeClient({"accepts": [{"maxAmountRequired": "250000"}]}, [{"status": "completed", "output": "done"}])
    r = hire(c, to="code-agent", task="audit", from_agent="my-agent", payment_method="balance", poll_interval_seconds=0.001)
    assert r.status == "completed" and r.paid is True
    assert c.sent["payment_method"] == "balance"
    assert c.sent["from_agent"] == "my-agent"
    assert c.sent["payment_signature"] is None  # no on-chain payment


def test_balance_requires_authenticated_from():
    c = FakeClient(None, [])
    with pytest.raises(ValueError, match="authenticated from_agent"):
        hire(c, to="code-agent", task="audit", payment_method="balance")  # default anonymous


def test_timeout_returns_timed_out():
    c = FakeClient(None, [{"status": "running"}] * 50)
    r = hire(c, to="agent", task="x", poll_interval_seconds=0.001, timeout_seconds=0.02)
    assert r.timed_out is True and r.status == "running" and r.receipt is None


def test_probe_failure_with_pay_reraises():
    # A willing-to-pay caller must not be silently downgraded to an unpaid submit.
    class Boom:
        def get_x402_requirements(self, to):
            raise RuntimeError("probe blip")

    with pytest.raises(RuntimeError, match="probe blip"):
        hire(Boom(), to="a", task="x", pay=lambda r: ("s", "w"))


def test_probe_failure_without_pay_tries_free():
    class C:
        base_url = "https://x"

        def get_x402_requirements(self, to):
            raise RuntimeError("probe blip")

        def send_task(self, to, task, from_agent="anonymous", context=None, payment_signature=None, payer_wallet=None):
            return {"taskId": "t1", "status": "queued", "claimToken": "tok"}

        def get_task(self, task_id, claim_token=None):
            return {"status": "completed", "output": "ok"}

        def get_receipt(self, task_id):
            return {}

    r = hire(C(), to="a", task="x", poll_interval_seconds=0.001)
    assert r.paid is False and r.status == "completed" and r.output == "ok"


def test_failed_task_surfaces_error():
    c = FakeClient(None, [{"status": "failed", "error": "could not comply"}])
    r = hire(c, to="agent", task="x", poll_interval_seconds=0.001)
    assert r.status == "failed" and r.error == "could not comply"
