"""Thin async-friendly wrapper around the AgentMail Python SDK.

We deliberately keep this small: the v1 review-response agent only needs to
fetch one message and (optionally) send a reply. Everything heavier (webhooks,
threading, attachments) lives behind the SDK directly.

Lazy-loads `agentmail` so importing this module never crashes the FastAPI
process when the package or `AGENTMAIL_API_KEY` is missing — agents that
don't need email keep working.

Env:
  AGENTMAIL_API_KEY  required to construct the client
  AGENTMAIL_DOMAIN   optional default domain for inbox creation
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

# Mirror nia_client.py: load backend/.env on import so the FastAPI worker
# sees AGENTMAIL_API_KEY even if it was started without env vars in the shell.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if _ENV_FILE.is_file():
    for _line in _ENV_FILE.read_text().splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())


class AgentMailError(RuntimeError):
    """Raised when an AgentMail call fails or the SDK is misconfigured."""


@dataclass(frozen=True)
class InboundMessage:
    message_id: str
    inbox_id: str
    from_: str | None
    to: list[str]
    subject: str | None
    text: str
    html: str | None
    raw: dict[str, Any]


@dataclass(frozen=True)
class InboxInfo:
    inbox_id: str
    address: str | None  # the SDK calls this `email`; we keep `address` for clarity
    raw: dict[str, Any]


def _to_dict(obj: Any) -> dict[str, Any]:
    """Coerce SDK pydantic-ish models into plain dicts for safe field access."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for attr in ("model_dump", "dict", "to_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return fn()  # type: ignore[no-any-return]
            except TypeError:
                try:
                    return fn(by_alias=False)  # type: ignore[call-arg]
                except Exception:
                    pass
    return {k: getattr(obj, k) for k in dir(obj) if not k.startswith("_")}


def _pick(d: dict[str, Any], *keys: str) -> Any:
    """Return the first present non-empty value among `keys` (snake_case or camelCase)."""
    for k in keys:
        if k in d and d[k] not in (None, "", []):
            return d[k]
    return None


@lru_cache
def _get_client() -> Any:
    api_key = os.environ.get("AGENTMAIL_API_KEY", "").strip()
    if not api_key:
        raise AgentMailError(
            "AGENTMAIL_API_KEY not set; add it to backend/.env to enable AgentMail"
        )
    try:
        from agentmail import AgentMail  # type: ignore[import-not-found]
    except Exception as e:  # noqa: BLE001
        raise AgentMailError(
            "agentmail SDK not installed; run `uv sync` in backend/ "
            f"(import error: {e})"
        ) from e
    return AgentMail(api_key=api_key)


def _ensure_unwrapped(call: Any) -> Any:
    """Some SDK responses come back as paginated wrappers — flatten them."""
    inner = getattr(call, "messages", None)
    if inner is not None:
        return inner
    return call


async def list_inboxes(limit: int = 100) -> list[InboxInfo]:
    """Return inboxes visible to the current API key."""
    client = _get_client()

    def _do() -> list[InboxInfo]:
        try:
            resp = client.inboxes.list(limit=limit)
        except TypeError:
            resp = client.inboxes.list()
        items = getattr(resp, "inboxes", None) or _ensure_unwrapped(resp) or []
        out: list[InboxInfo] = []
        for it in items:
            raw = _to_dict(it)
            out.append(
                InboxInfo(
                    inbox_id=str(_pick(raw, "inbox_id", "inboxId", "id") or ""),
                    address=_pick(raw, "email", "address"),
                    raw=raw,
                )
            )
        return out

    return await asyncio.to_thread(_do)


async def find_inbox_by_address(address: str) -> InboxInfo | None:
    """Look up an inbox by its email address (case-insensitive)."""
    target = address.strip().lower()
    for inbox in await list_inboxes():
        if (inbox.address or "").strip().lower() == target:
            return inbox
    return None


async def get_or_create_inbox(client_id: str, *, display_name: str | None = None) -> InboxInfo:
    """Idempotent inbox creation. `client_id` is what makes it idempotent on
    AgentMail's side — the same string returns the same inbox.

    The Fern-generated SDK exposes `inboxes.create(request: CreateInboxRequest)`
    but in practice also accepts kwargs that it packs into the request. We try
    kwargs first (cleanest), fall back to building the request object.
    """
    client = _get_client()
    domain = os.environ.get("AGENTMAIL_DOMAIN") or None

    def _do() -> InboxInfo:
        kwargs: dict[str, Any] = {"client_id": client_id}
        if display_name:
            kwargs["display_name"] = display_name
        if domain:
            kwargs["domain"] = domain
        try:
            inbox = client.inboxes.create(**kwargs)
        except TypeError:
            # SDK requires a CreateInboxRequest object positionally.
            from agentmail.inboxes.types.create_inbox_request import (  # type: ignore[import-not-found]
                CreateInboxRequest,
            )

            inbox = client.inboxes.create(request=CreateInboxRequest(**kwargs))
        raw = _to_dict(inbox)
        return InboxInfo(
            inbox_id=str(_pick(raw, "inbox_id", "inboxId", "id")),
            address=_pick(raw, "email", "address", "inbox_address"),
            raw=raw,
        )

    return await asyncio.to_thread(_do)


async def send_email(
    inbox_id: str,
    *,
    to: str | list[str],
    subject: str,
    text: str,
    html: str | None = None,
    reply_to: str | list[str] | None = None,
) -> dict[str, Any]:
    """Send a message from `inbox_id`. Returns the SDK response as a dict."""
    client = _get_client()
    to_value: Any = to if isinstance(to, str) else list(to)

    def _do() -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "to": to_value,
            "subject": subject,
            "text": text,
        }
        if html is not None:
            kwargs["html"] = html
        if reply_to is not None:
            kwargs["reply_to"] = reply_to
        resp = client.inboxes.messages.send(inbox_id, **kwargs)
        return _to_dict(resp)

    return await asyncio.to_thread(_do)


async def list_messages(inbox_id: str, *, limit: int = 25) -> list[InboundMessage]:
    """Return recent messages in this inbox (ascending=False by default)."""
    client = _get_client()

    def _do() -> list[InboundMessage]:
        try:
            resp = client.inboxes.messages.list(inbox_id, limit=limit)
        except TypeError:
            resp = client.inboxes.messages.list(inbox_id)
        items = _ensure_unwrapped(resp)
        out: list[InboundMessage] = []
        for it in items or []:
            raw = _to_dict(it)
            out.append(_msg_from_dict(inbox_id, raw))
        return out

    return await asyncio.to_thread(_do)


async def get_message(inbox_id: str, message_id: str) -> InboundMessage:
    """Fetch one message by id and normalize to `InboundMessage`."""
    client = _get_client()

    def _do() -> InboundMessage:
        resp = client.inboxes.messages.get(inbox_id, message_id)
        raw = _to_dict(resp)
        return _msg_from_dict(inbox_id, raw)

    return await asyncio.to_thread(_do)


async def wait_for_message(
    inbox_id: str,
    *,
    subject_contains: str | None = None,
    after_message_ids: set[str] | None = None,
    timeout_s: float = 30.0,
    poll_s: float = 1.5,
) -> InboundMessage | None:
    """Poll `inbox_id` until a matching message arrives or the timeout fires.

    Useful in tests/scripts: send an email from inbox A → poll inbox B for it.
    """
    seen = set(after_message_ids or [])
    deadline = asyncio.get_event_loop().time() + timeout_s
    while True:
        msgs = await list_messages(inbox_id, limit=25)
        for m in msgs:
            if m.message_id in seen:
                continue
            if subject_contains and (m.subject or "").lower().find(
                subject_contains.lower()
            ) < 0:
                continue
            return m
        if asyncio.get_event_loop().time() >= deadline:
            return None
        await asyncio.sleep(poll_s)


def _msg_from_dict(inbox_id: str, raw: dict[str, Any]) -> InboundMessage:
    body_text = _pick(raw, "extracted_text", "extractedText", "text", "body_text") or ""
    body_html = _pick(raw, "extracted_html", "extractedHtml", "html", "body_html")
    to_raw = _pick(raw, "to", "to_addresses") or []
    if isinstance(to_raw, str):
        to_list = [to_raw]
    else:
        to_list = [str(x) for x in to_raw]
    return InboundMessage(
        message_id=str(_pick(raw, "message_id", "messageId", "id") or ""),
        inbox_id=str(_pick(raw, "inbox_id", "inboxId") or inbox_id),
        from_=_pick(raw, "from", "from_", "sender", "from_address"),
        to=to_list,
        subject=_pick(raw, "subject"),
        text=str(body_text or ""),
        html=body_html,
        raw=raw,
    )


__all__ = [
    "AgentMailError",
    "InboundMessage",
    "InboxInfo",
    "find_inbox_by_address",
    "get_message",
    "get_or_create_inbox",
    "list_inboxes",
    "list_messages",
    "send_email",
    "wait_for_message",
]
