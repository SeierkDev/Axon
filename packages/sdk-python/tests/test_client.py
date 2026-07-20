"""AxonClient tests against a fake HTTP session — parsing, error mapping, retry."""

import pytest

from axon import AxonApiError, AxonClient


class FakeResp:
    def __init__(self, status, json_data=None, text="", headers=None):
        self.status_code = status
        self._json = json_data
        self.text = text
        self.headers = headers or {}
        self.reason = "reason"
        self.content = b"x" if (json_data is not None or text) else b""

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((method, url, headers, json))
        return self.responses.pop(0)

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("GET", url, headers))
        return self.responses.pop(0)


def client(responses, **kw):
    return AxonClient(base_url="https://x", session=FakeSession(responses), retry_base_seconds=0.001, **kw)


def test_search_agents_parses_and_ranks():
    c = client([FakeResp(200, {"agents": [{"agentId": "a", "proofScore": 900}]})])
    agents = c.search_agents(capability="research", sort="proven", limit=3)
    assert agents[0]["agentId"] == "a"
    # query built correctly
    assert "capability=research" in c._session.calls[0][1]
    assert "sort=proven" in c._session.calls[0][1]


def test_api_error_carries_status_and_code():
    c = client([FakeResp(400, {"error": "bad input", "code": "VALIDATION_ERROR"})])
    with pytest.raises(AxonApiError) as ei:
        c.get_agent("nope")
    assert ei.value.status == 400 and ei.value.code == "VALIDATION_ERROR"


def test_retries_transient_5xx_on_get():
    c = client([FakeResp(503), FakeResp(200, {"name": "A"})])
    agent = c.get_agent("a")
    assert agent["name"] == "A"
    assert len(c._session.calls) == 2  # retried once


def test_does_not_retry_post():
    c = client([FakeResp(500, {"error": "boom", "code": "INTERNAL_ERROR"})])
    with pytest.raises(AxonApiError):
        c.send_task(to="a", task="x")
    assert len(c._session.calls) == 1  # POST not retried


def test_task_lifecycle_and_register_paths_and_bodies():
    # Lock the exact route + JSON body for every runtime/settle call (this is the
    # bug class that recurred: wrong endpoint or wrong body key).
    c = client([
        FakeResp(200, {"taskId": "t1", "status": "running"}),
        FakeResp(200, {"taskId": "t1", "status": "completed"}),
        FakeResp(200, {"taskId": "t1", "status": "failed"}),
        FakeResp(200, {"progress": {}}),
        FakeResp(201, {"agentId": "a"}),
    ])
    c.start_task("t1")
    c.complete_task("t1", "the output")
    c.fail_task("t1", "the error")
    c.emit_progress("t1", "working")
    c.register({"agentId": "a", "name": "A", "capabilities": ["x"], "publicKey": "pk"})
    calls = c._session.calls
    assert calls[0][:2] == ("POST", "https://x/api/tasks/t1/start")
    assert calls[1][:2] == ("POST", "https://x/api/tasks/t1/complete") and calls[1][3] == {"output": "the output"}
    assert calls[2][:2] == ("POST", "https://x/api/tasks/t1/fail") and calls[2][3] == {"error": "the error"}
    assert calls[3][:2] == ("POST", "https://x/api/tasks/t1/progress") and calls[3][3] == {"message": "working"}
    assert calls[4][:2] == ("POST", "https://x/api/agents") and calls[4][3]["agentId"] == "a"


def test_get_task_history_hits_agent_scoped_endpoint():
    # agentId is a PATH segment (/api/agents/<id>/tasks), NOT a query param — the
    # runtime's poll depends on this exact route existing (a GET /api/tasks 405s).
    c = client([FakeResp(200, {"tasks": [{"taskId": "t1"}]})])
    tasks = c.get_task_history("worker", role="recipient", status="queued", limit=5)
    assert tasks[0]["taskId"] == "t1"
    url = c._session.calls[0][1]
    assert "/api/agents/worker/tasks" in url and "agentId=" not in url
    assert "role=recipient" in url and "status=queued" in url


def test_send_task_idempotency_key_header_and_retry():
    # POST with an Idempotency-Key is retryable, and the header is sent.
    c = client([FakeResp(503), FakeResp(201, {"taskId": "t1", "claimToken": "tok"})])
    r = c.send_task(to="a", task="x", idempotency_key="k1")
    assert r["taskId"] == "t1"
    assert len(c._session.calls) == 2  # retried thanks to the idempotency key
    assert c._session.calls[0][2]["Idempotency-Key"] == "k1"


def test_error_mapping_tolerates_non_dict_body():
    c = client([FakeResp(400, json_data=["not", "an", "object"])])
    with pytest.raises(AxonApiError) as ei:
        c.get_agent("a")
    assert ei.value.status == 400 and ei.value.code is None  # didn't crash on a list body


def test_get_task_sends_claim_token_header():
    captured = {}

    class S(FakeSession):
        def request(self, method, url, json=None, headers=None, timeout=None):
            captured["headers"] = headers
            return FakeResp(200, {"status": "completed", "output": "done"})

    c = AxonClient(base_url="https://x", session=S([]))
    t = c.get_task("t1", claim_token="tok")
    assert t["output"] == "done"
    assert captured["headers"]["x-claim-token"] == "tok"
