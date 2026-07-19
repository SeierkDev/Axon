"""
Offline tests for the Axon ZerePy connection.

- Loads the real AxonConnection with a stubbed ZerePy base, so the connection
  class (validate_config, register_actions, action metadata) is exercised as-is.
- Verifies the trustless receipt verifier against a captured production trace and
  every tamper class — no network.

Run:  python3 test/test_axon.py
"""

import copy
import importlib.util
import json
import os
import sys
import types
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
CONN = os.path.join(os.path.dirname(HERE), "connections")


# ── faithful stub of ZerePy's src.connections.base_connection ────────────────
# Mirrors the real base: Action metadata carries validate_params, __init__ sets
# self.actions before validate_config + register_actions, and the base's default
# perform_action treats self.actions[name] as a CALLABLE — so a connection that
# stores Action metadata (as ZerePy connections do) MUST override perform_action.
# Keeping this faithful is what lets the test catch a missing/broken dispatch.
@dataclass
class ActionParameter:
    name: str
    required: bool
    type: type
    description: str


@dataclass
class Action:
    name: str
    parameters: List[ActionParameter]
    description: str

    def validate_params(self, params: Dict[str, Any]) -> List[str]:
        errors = []
        for p in self.parameters:
            if p.required and p.name not in params:
                errors.append(f"Missing required parameter: {p.name}")
            elif p.name in params:
                try:
                    params[p.name] = p.type(params[p.name])
                except ValueError:
                    errors.append(f"Invalid type for {p.name}")
        return errors


class BaseConnection(ABC):
    def __init__(self, config):
        self.actions: Dict[str, Any] = {}
        self.config = self.validate_config(config)
        self.register_actions()

    @property
    @abstractmethod
    def is_llm_provider(self):
        ...

    @abstractmethod
    def validate_config(self, config):
        ...

    @abstractmethod
    def configure(self, **kwargs):
        ...

    @abstractmethod
    def is_configured(self, verbose=False):
        ...

    @abstractmethod
    def register_actions(self):
        ...

    def perform_action(self, action_name: str, **kwargs) -> Any:
        # Base default — subclasses that store Action metadata override this.
        if action_name not in self.actions:
            raise KeyError(f"Unknown action: {action_name}")
        return self.actions[action_name](**kwargs)


def _install_stubs():
    base = types.ModuleType("src.connections.base_connection")
    base.BaseConnection = BaseConnection
    base.Action = Action
    base.ActionParameter = ActionParameter
    sys.modules["src"] = types.ModuleType("src")
    sys.modules["src.connections"] = types.ModuleType("src.connections")
    sys.modules["src.connections.base_connection"] = base


def _load(modname, filename):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(CONN, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    _install_stubs()
    verify = _load("src.connections.axon_verify", "axon_verify.py")
    axon = _load("src.connections.axon_connection", "axon_connection.py")

    # 1) the connection loads, validates config, and registers its actions
    conn = axon.AxonConnection({"base_url": "https://axon-agents.com"})
    assert conn.is_llm_provider is False
    assert set(conn.actions.keys()) == {"search-agents", "hire-agent", "get-result", "verify-receipt"}
    assert conn.actions["hire-agent"].parameters[0].name == "agent_id"
    # is_configured is keyless and network-free (ZerePy calls it before every action)
    assert conn.is_configured() is True
    print("connection loads + registers 4 actions: OK")

    # 2) perform_action dispatches (validates params, routes to the handler).
    # This is what real ZerePy calls — it fails loudly if the override is missing.
    conn.verify_receipt = lambda task_id: f"ROUTED:{task_id}"  # avoid network
    assert conn.perform_action("verify-receipt", {"task_id": "abc"}) == "ROUTED:abc"
    print("perform_action dispatches to the handler: OK")

    try:
        conn.perform_action("verify-receipt", {})  # missing required task_id
        raise AssertionError("missing required param should raise")
    except ValueError:
        print("perform_action validates required params: OK")

    try:
        conn.perform_action("no-such-action", {})
        raise AssertionError("unknown action should raise")
    except KeyError:
        print("perform_action rejects unknown actions: OK")

    # 3) bad config is rejected
    try:
        axon.AxonConnection({"base_url": "not-a-url"})
        raise AssertionError("bad base_url should have raised")
    except ValueError:
        print("rejects invalid base_url: OK")

    # 3) verifier: valid production trace recomputes byte-exact
    trace = json.load(open(os.path.join(HERE, "trace-valid.json")))
    r = verify.verify_trace(trace)
    assert r["chain_valid"] is True and r["broken_at"] is None, r
    assert r["chain_valid"] == r["platform_claim"]
    print(f"verifier: valid trace recomputes ({r['event_count']} events): OK")

    # 4) verifier: every tamper class is caught
    edited = copy.deepcopy(trace)
    v = next((e for e in edited["events"] if e["seq"] == 2), edited["events"][1])
    v["outputTokens"] = (v.get("outputTokens") or 0) + 1
    assert verify.verify_trace(edited)["chain_valid"] is False
    print("verifier: catches an edited field: OK")

    reordered = copy.deepcopy(trace)
    if len(reordered["events"]) >= 3:
        reordered["events"][1], reordered["events"][2] = reordered["events"][2], reordered["events"][1]
    assert verify.verify_trace(reordered)["chain_valid"] is False
    print("verifier: catches reordering: OK")

    dropped = copy.deepcopy(trace)
    dropped["events"] = [e for e in dropped["events"] if e["seq"] != 2]
    assert verify.verify_trace(dropped)["chain_valid"] is False
    print("verifier: catches a dropped event: OK")

    print("\nALL PASS")


if __name__ == "__main__":
    main()
