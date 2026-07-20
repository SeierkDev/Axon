"""Errors raised by the Axon client."""

from typing import Any, Optional


class AxonApiError(Exception):
    """An error response from the Axon API. Carries the HTTP status and, when the
    body is a structured Axon error, its machine-readable ``code``."""

    def __init__(
        self,
        message: str,
        status: int,
        method: str,
        path: str,
        code: Optional[str] = None,
        body: Any = None,
    ):
        super().__init__(message)
        self.status = status
        self.method = method
        self.path = path
        self.code = code
        self.body = body

    def __str__(self) -> str:
        base = super().__str__()
        return f"{base} ({self.method} {self.path} -> {self.status}{', ' + self.code if self.code else ''})"
