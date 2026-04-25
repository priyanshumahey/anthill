"""HTTP client for the collab agent-bridge.

Agents on this backend mutate the live document by POSTing edit ops to the
bridge over plain HTTP. The bridge applies them as Yjs transactions on a
warm DirectConnection, so all connected editors see the change live.

Auth model:
- Shared secret in `X-Agent-Token` (matches `ANTHILL_AGENT_BRIDGE_SECRET`
  on the collab side, surfaced here as `bridge_token` in Settings).
- Per-call identity in `X-Agent-Id` (the agent name, e.g. "citation_inserter")
  and optionally `X-Agent-Run-Id`.

Idempotency: every edit call can include an `Idempotency-Key`. We default to
`run_id:op_seq` so retried agent steps don't double-apply edits.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


class BridgeError(RuntimeError):
    """Raised when the bridge returns a non-2xx response."""

    def __init__(
        self, status: int, code: str, message: str, details: dict[str, Any] | None = None
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


class BridgeClient:
    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        agent_id: str,
        run_id: str | None = None,
        agent_name: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._agent_id = agent_id
        self._run_id = run_id
        self._agent_name = agent_name or agent_id
        self._timeout = timeout

    def _headers(self, *, idempotency_key: str | None = None) -> dict[str, str]:
        h = {
            "X-Agent-Id": self._agent_id,
            "X-Agent-Name": self._agent_name,
            "Content-Type": "application/json",
        }
        if self._token:
            h["X-Agent-Token"] = self._token
        if self._run_id:
            h["X-Agent-Run-Id"] = self._run_id
        if idempotency_key:
            h["Idempotency-Key"] = idempotency_key
        return h

    async def snapshot(self, document_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self._base_url}/documents/{document_id}/snapshot",
                headers=self._headers(),
            )
            return _parse(resp)

    async def state(self, document_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self._base_url}/documents/{document_id}/state",
                headers=self._headers(),
            )
            return _parse(resp)

    async def edit(
        self,
        document_id: str,
        ops: list[dict[str, Any]],
        *,
        base_revision: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"ops": ops}
        if base_revision:
            body["baseRevision"] = base_revision
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self._base_url}/documents/{document_id}/edit",
                headers=self._headers(idempotency_key=idempotency_key),
                json=body,
            )
            return _parse(resp)

    async def presence(
        self, document_id: str, status: str, message: str | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"status": status}
        if message is not None:
            body["message"] = message
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self._base_url}/documents/{document_id}/presence",
                headers=self._headers(),
                json=body,
            )
            return _parse(resp)


def _parse(resp: httpx.Response) -> dict[str, Any]:
    if resp.is_success:
        return resp.json() if resp.content else {}
    body: dict[str, Any] = {}
    try:
        body = resp.json()
    except Exception:
        body = {"error": "INTERNAL_ERROR", "message": resp.text or resp.reason_phrase}
    raise BridgeError(
        status=resp.status_code,
        code=str(body.get("error") or "INTERNAL_ERROR"),
        message=str(body.get("message") or "bridge call failed"),
        details=body.get("details"),
    )


def get_client(
    *, agent_id: str, run_id: str | None = None, agent_name: str | None = None
) -> BridgeClient:
    """Build a `BridgeClient` from settings.

    `bridge_url` and `bridge_token` come from the same `Settings` object that
    powers the embedding service so a single `.env` configures everything.
    Falls back to env vars when running outside FastAPI (e.g. unit tests).
    """
    try:
        from main import get_settings  # type: ignore[import-not-found]

        s = get_settings()
        base_url = s.bridge_url
        token = s.bridge_token
    except Exception:
        base_url = os.environ.get("ANTHILL_BRIDGE_URL", "http://localhost:8889")
        token = os.environ.get("ANTHILL_BRIDGE_TOKEN", "")
    return BridgeClient(
        base_url=base_url, token=token, agent_id=agent_id, run_id=run_id, agent_name=agent_name
    )


__all__ = ["BridgeClient", "BridgeError", "get_client"]
