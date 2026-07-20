"""Agent runtime tests against a fake client — settlement, failure, lost-response
conflict, auto-register."""

import time

from axon import AxonApiError, define_agent


def _task(tid):
    return {"taskId": tid, "toAgent": "worker", "task": f"do {tid}", "status": "queued"}


class FakeClient:
    def __init__(self, queue, get_agent_error=None, complete_error=None):
        self._queue = list(queue)
        self._served = False
        self._get_agent_error = get_agent_error
        self._complete_error = complete_error
        self.settled = {}
        self.registered = False

    def get_agent(self, agent_id):
        if self._get_agent_error:
            raise self._get_agent_error
        return {"agentId": agent_id}

    def register(self, options):
        self.registered = True
        return options

    def get_task_history(self, agent_id, role=None, status=None, limit=None):
        if self._served:
            return []
        self._served = True
        return self._queue

    def start_task(self, task_id):
        return {"taskId": task_id, "status": "running"}

    def emit_progress(self, task_id, message):
        return {}

    def complete_task(self, task_id, output):
        if self._complete_error:
            raise self._complete_error
        self.settled[task_id] = ("complete", output)
        return {"taskId": task_id, "status": "completed"}

    def fail_task(self, task_id, error):
        self.settled[task_id] = ("fail", error)
        return {"taskId": task_id, "status": "failed"}


def _until(pred, timeout=2.0):
    end = time.time() + timeout
    while not pred() and time.time() < end:
        time.sleep(0.01)


def _agent(client, handler, **kw):
    return define_agent(client, handler=handler, agent_id="worker", name="Worker",
                        capabilities=["research"], public_key="pk", poll_interval_seconds=0.01, **kw)


def test_runs_and_completes():
    c = FakeClient([_task("t1")])
    a = _agent(c, lambda ctx: f"answer for {ctx.task['taskId']}")
    a.start()
    _until(lambda: "t1" in c.settled)
    a.stop()
    assert c.settled["t1"] == ("complete", "answer for t1")
    assert a.running is False


def test_throwing_handler_fails_task():
    c = FakeClient([_task("boom")])

    def h(ctx):
        raise RuntimeError("handler exploded")

    a = _agent(c, h)
    a.start()
    _until(lambda: "boom" in c.settled)
    a.stop()
    assert c.settled["boom"][0] == "fail" and "exploded" in c.settled["boom"][1]


def test_explicit_failure_return():
    c = FakeClient([_task("nope")])
    a = _agent(c, lambda ctx: {"output": "can't do it", "success": False})
    a.start()
    _until(lambda: "nope" in c.settled)
    a.stop()
    assert c.settled["nope"] == ("fail", "can't do it")


def test_settle_conflict_treated_as_settled():
    conflict = AxonApiError("not running", 409, "POST", "/complete", code="TASK_STATE_CONFLICT")
    c = FakeClient([_task("c1")], complete_error=conflict)
    errors, completes = [], []
    a = _agent(c, lambda ctx: "done", on_error=lambda *a: errors.append(a),
               on_task_complete=lambda r: completes.append(r))
    a.start()
    _until(lambda: len(completes) > 0)
    a.stop()
    assert len(completes) == 1  # settled despite the conflict
    assert len(errors) == 0     # no false orphan error


def test_concurrent_tasks_each_claimed_once():
    c = FakeClient([_task("a"), _task("b")])
    starts = []
    orig = c.start_task

    def counting(tid):
        starts.append(tid)
        return orig(tid)

    c.start_task = counting
    a = _agent(c, lambda ctx: f"out-{ctx.task['taskId']}", concurrency=2)
    a.start()
    _until(lambda: "a" in c.settled and "b" in c.settled)
    a.stop()
    assert c.settled["a"] == ("complete", "out-a")
    assert c.settled["b"] == ("complete", "out-b")
    assert sorted(starts) == ["a", "b"]  # each task claimed/started exactly once


def test_auto_registers_when_missing():
    not_found = AxonApiError("not found", 404, "GET", "/api/agents/worker", code="NOT_FOUND")
    c = FakeClient([], get_agent_error=not_found)
    a = _agent(c, lambda ctx: "x")
    a.start()
    a.stop()
    assert c.registered is True


def test_restartable_after_stop():
    c = FakeClient([_task("r1")])
    a = _agent(c, lambda ctx: "done")
    a.start()
    _until(lambda: "r1" in c.settled)
    a.stop()
    # start again with fresh work — a dead executor would raise here
    c._queue = [_task("r2")]
    c._served = False
    c.settled.clear()
    a.start()
    _until(lambda: "r2" in c.settled)
    a.stop()
    assert c.settled["r2"] == ("complete", "done")
