#!/usr/bin/env -S uv run python
"""Watch an AgentMail inbox and trigger `review_response` on every new email.

This is the "send an email → see the document update" demo path. It opens a
WebSocket to AgentMail (no public URL / tunnel needed), subscribes to
`message.received` for the configured inbox, and for each incoming message
POSTs to the FastAPI backend at `/agents/runs` so the existing agent runtime
handles snapshotting, Claude planning, bridge edits, and reply email.

Routing — which document gets edited:

  1. If the email subject contains a tag like `[anthill:<uuid>]`, that
     document_id wins. (Lets you run multiple papers off one inbox.)
  2. Otherwise the `--doc` CLI flag (or `ANTHILL_REVIEW_DOC_ID` env var)
     is used as the default.

Default inbox: `anthill@agentmail.to` — override with `--inbox` (address) or
`ANTHILL_REVIEW_INBOX_ADDRESS`. The script looks up the inbox_id on startup.

Usage:
    cd backend && source .venv/bin/activate
    python scripts/watch_inbox.py --doc 003cb3da-c1b0-42a3-8155-a24749d80fe7

Then send any email to anthill@agentmail.to from your normal mail client and
watch the agent run live.

Prereqs:
  - Backend running on :8000      (uv run fastapi dev)
  - Hocuspocus + bridge running   (bun run dev in /collab)
  - backend/.env populated with AGENTMAIL_API_KEY, ANTHROPIC_KEY
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# Bootstrap: same .env-loading dance as the other scripts so this works whether
# you launched it from /backend or the repo root.
_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))
_ENV = _BACKEND / ".env"
if _ENV.is_file():
    for _line in _ENV.read_text().splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

from agents import agentmail_client  # noqa: E402

BACKEND_URL = os.environ.get("ANTHILL_BACKEND_URL", "http://127.0.0.1:8000")
BACKEND_SECRET = os.environ.get("ANTHILL_SHARED_SECRET", "")
DEFAULT_INBOX_ADDRESS = (
    os.environ.get("ANTHILL_REVIEW_INBOX_ADDRESS") or "anthill@agentmail.to"
)
DEFAULT_DOC_ID = os.environ.get("ANTHILL_REVIEW_DOC_ID") or None

# Subject tag we look for to override the default doc id, e.g.
# "Re: paper revisions [anthill:003cb3da-c1b0-42a3-8155-a24749d80fe7]".
_DOC_TAG_RE = re.compile(
    r"\[anthill:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]",
    re.IGNORECASE,
)


def _backend_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BACKEND_SECRET:
        h["X-Anthill-Secret"] = BACKEND_SECRET
    return h


def _to_dict(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return obj
    for attr in ("model_dump", "dict", "to_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return fn()  # type: ignore[no-any-return]
            except TypeError:
                continue
    return {k: getattr(obj, k) for k in dir(obj) if not k.startswith("_")}


def _pick(d: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, "", []):
            return d[k]
    return None


def _route_doc_id(subject: str | None, default_doc: str | None) -> str | None:
    """Pick a doc id from a subject tag, falling back to the default."""
    if subject:
        m = _DOC_TAG_RE.search(subject)
        if m:
            return m.group(1)
    return default_doc


async def _trigger_agent(
    *,
    client: httpx.AsyncClient,
    document_id: str,
    inbox_id: str,
    message_id: str,
    sender_email: str | None,
    sender_name: str | None,
    reply: bool,
    max_actions: int,
) -> dict[str, Any]:
    body = {
        "agent": "review_response",
        "document_id": document_id,
        "input": {
            "inbox_id": inbox_id,
            "message_id": message_id,
            "sender_email": sender_email,
            "sender_name": sender_name,
            "reply": reply,
            "reply_inbox_id": inbox_id,
            "max_actions": max_actions,
        },
    }
    r = await client.post(
        f"{BACKEND_URL}/agents/runs", headers=_backend_headers(), json=body
    )
    if r.status_code >= 400:
        raise RuntimeError(f"backend rejected run: {r.status_code} {r.text}")
    return r.json()


async def _stream_run(client: httpx.AsyncClient, run_id: str) -> None:
    """Stream SSE events for the run so the operator can watch progress."""
    url = f"{BACKEND_URL}/agents/runs/{run_id}/events"
    async with client.stream(
        "GET", url, headers=_backend_headers(), timeout=None
    ) as resp:
        resp.raise_for_status()
        kind = ""
        buf: list[str] = []
        async for raw in resp.aiter_lines():
            if raw == "":
                if buf:
                    payload = "\n".join(buf)
                    try:
                        ev = json.loads(payload)
                    except Exception:
                        ev = {"raw": payload}
                    _print_event(kind, ev)
                    if kind == "status":
                        status = (ev.get("data") or {}).get("status")
                        if status in {"succeeded", "failed", "cancelled"}:
                            return
                kind = ""
                buf = []
                continue
            if raw.startswith("event:"):
                kind = raw[len("event:") :].strip()
            elif raw.startswith("data:"):
                buf.append(raw[len("data:") :].lstrip())


def _print_event(kind: str, ev: dict[str, Any]) -> None:
    msg = ev.get("message") or ""
    data = ev.get("data") or {}
    if kind == "status":
        print(f"     · status={data.get('status')} {msg}")
    elif kind == "step":
        step = data.get("step", "?")
        print(f"     · [{step}] {msg}")
    elif kind == "finding":
        print(
            f"     · ★ {data.get('kind')} on {data.get('anchor_ref')}: "
            f"{(data.get('preview') or '')[:120]}"
        )
    elif kind == "log":
        print(f"     · log: {msg}")
    elif kind == "error":
        print(f"     · error: {msg}")


async def _handle_event(
    raw_evt: Any,
    *,
    inbox_id: str,
    default_doc: str | None,
    seen_ids: set[str],
    http: httpx.AsyncClient,
    reply: bool,
    max_actions: int,
) -> None:
    """One websocket event → at most one agent run.

    The AgentMail SDK yields typed event objects off the socket iterator:
    `MessageReceivedEvent`, `MessageSentEvent`, `Subscribed`, `Error`, etc.
    We only care about `MessageReceivedEvent`. Everything else is logged
    (so subscription confirmations show up) and otherwise ignored.
    """
    # Lazy imports so the module loads even when the SDK is missing.
    from agentmail import MessageReceivedEvent  # type: ignore[import-not-found]
    from agentmail.websockets.types.subscribed import (  # type: ignore[import-not-found]
        Subscribed,
    )
    from agentmail.websockets.types.error import (  # type: ignore[import-not-found]
        Error as WsError,
    )

    if isinstance(raw_evt, Subscribed):
        print(f"[ws] ✓ subscribed ack: {_to_dict(raw_evt)}")
        return
    if isinstance(raw_evt, WsError):
        print(f"[ws] ✗ server error: {_to_dict(raw_evt)}")
        return
    if not isinstance(raw_evt, MessageReceivedEvent):
        # Sent/Delivered/Bounced/etc. aren't actionable here.
        kind = type(raw_evt).__name__
        print(f"[ws] · ignoring {kind}")
        return

    msg = raw_evt.message
    msg_dict = _to_dict(msg)

    message_id = str(_pick(msg_dict, "message_id", "messageId", "id") or "").strip()
    if not message_id:
        print(f"[ws] · MessageReceivedEvent without message_id: {msg_dict}")
        return

    msg_inbox = str(_pick(msg_dict, "inbox_id", "inboxId") or "").strip()
    if msg_inbox and msg_inbox != inbox_id:
        # Defensive: ignore events for other inboxes (we only subscribed to one
        # but the SDK may surface others if a pod-level subscribe was added).
        print(f"[ws] · skipping cross-inbox message {message_id} (inbox={msg_inbox})")
        return

    if message_id in seen_ids:
        return
    seen_ids.add(message_id)

    subject = _pick(msg_dict, "subject")
    sender = _pick(msg_dict, "from", "from_", "sender", "from_address")
    print()
    print(f"📬 incoming  message_id={message_id}")
    print(f"             from={sender!r}")
    print(f"             subject={subject!r}")

    doc_id = _route_doc_id(subject, default_doc)
    if not doc_id:
        print(
            "     · ⚠ no document_id (no subject tag and no --doc default); "
            "ignoring this email."
        )
        return
    print(f"     · routing → doc {doc_id}")

    try:
        run = await _trigger_agent(
            client=http,
            document_id=doc_id,
            inbox_id=inbox_id,
            message_id=message_id,
            sender_email=sender if isinstance(sender, str) else None,
            sender_name=None,  # AgentMail's `from` already includes display name
            reply=reply,
            max_actions=max_actions,
        )
    except Exception as e:  # noqa: BLE001
        print(f"     · ✗ failed to start run: {e}")
        return

    run_id = run.get("id")
    print(f"     · run id={run_id}")
    try:
        await _stream_run(http, run_id)
    except Exception as e:  # noqa: BLE001
        print(f"     · ✗ stream broke: {e}")
    print(f"📭 done with {message_id}\n")


def _resolve_inbox_sync(
    address: str,
    *,
    create_if_missing: bool,
) -> agentmail_client.InboxInfo:
    """Look up an inbox by address (sync, runs once at startup)."""

    async def _go() -> agentmail_client.InboxInfo:
        found = await agentmail_client.find_inbox_by_address(address)
        if found:
            return found
        if not create_if_missing:
            raise SystemExit(
                f"AgentMail inbox {address!r} not found. Pass --create to make it, "
                f"or visit console.agentmail.to to create it manually."
            )
        # Use the local-part as the client_id seed for idempotency.
        local = address.split("@", 1)[0]
        print(f"[mail] inbox {address!r} not found — creating idempotently as {local!r}")
        return await agentmail_client.get_or_create_inbox(
            client_id=f"anthill-watch-{local}",
            display_name=f"Anthill watcher ({local})",
        )

    return asyncio.run(_go())


def _open_websocket(api_key: str) -> Any:
    """Return an open AgentMail WebSocket client (sync context manager protocol)."""
    from agentmail import AgentMail  # type: ignore[import-not-found]

    client = AgentMail(api_key=api_key)
    # `connect()` is itself a context manager — call __enter__ explicitly so
    # we can keep the socket alive across the asyncio loop below.
    cm = client.websockets.connect()
    socket = cm.__enter__()
    return cm, socket


def _build_subscribe(inbox_id: str) -> Any:
    from agentmail.websockets import Subscribe  # type: ignore[import-not-found]

    return Subscribe(event_types=["message.received"], inbox_ids=[inbox_id])


async def _pump_socket(
    socket: Any,
    queue: asyncio.Queue,
    stop: asyncio.Event,
) -> None:
    """Producer thread → asyncio queue. Pulls events off the sync socket."""
    loop = asyncio.get_running_loop()

    def _producer() -> None:
        try:
            for evt in socket:  # blocking iterator, terminates on close
                if stop.is_set():
                    return
                # Hand to the loop without blocking if the queue is full.
                loop.call_soon_threadsafe(queue.put_nowait, evt)
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, e)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    await asyncio.to_thread(_producer)


async def main_async(args: argparse.Namespace) -> int:
    api_key = os.environ.get("AGENTMAIL_API_KEY", "").strip()
    if not api_key:
        raise SystemExit(
            "AGENTMAIL_API_KEY missing in backend/.env — get one at "
            "https://console.agentmail.to"
        )

    address = args.inbox
    print(f"[mail] resolving inbox {address!r}…")
    inbox = await agentmail_client.find_inbox_by_address(address)
    if not inbox:
        if not args.create:
            raise SystemExit(
                f"AgentMail inbox {address!r} not visible to this API key. "
                f"Either re-run with --create, or check that you copied the right key."
            )
        local = address.split("@", 1)[0]
        inbox = await agentmail_client.get_or_create_inbox(
            client_id=f"anthill-watch-{local}",
            display_name=f"Anthill watcher ({local})",
        )
    print(f"[mail] inbox_id={inbox.inbox_id}  email={inbox.address!r}")

    default_doc = args.doc or DEFAULT_DOC_ID
    if default_doc:
        print(f"[route] default document_id={default_doc}")
    else:
        print(
            "[route] no default document_id; only emails with [anthill:<uuid>] "
            "subject tags will be processed"
        )

    print(f"[ws] connecting to AgentMail websocket for inbox {inbox.inbox_id}…")
    cm, socket = _open_websocket(api_key)
    try:
        socket.send_subscribe(_build_subscribe(inbox.inbox_id))
        print("[ws] subscribed to message.received; waiting for emails. (Ctrl-C to quit.)")

        queue: asyncio.Queue = asyncio.Queue()
        stop = asyncio.Event()
        pump_task = asyncio.create_task(_pump_socket(socket, queue, stop))
        seen_ids: set[str] = set()

        # Pre-warm: ignore everything already in the inbox so old emails don't
        # all fire when we connect. We seed `seen_ids` with the most recent
        # message ids, then only act on new ones the socket delivers.
        try:
            existing = await agentmail_client.list_messages(inbox.inbox_id, limit=50)
            for m in existing:
                seen_ids.add(m.message_id)
            print(f"[ws] ignoring {len(seen_ids)} pre-existing message(s) in this inbox")
        except Exception as e:  # noqa: BLE001
            print(f"[ws] could not list existing messages (continuing anyway): {e}")

        async with httpx.AsyncClient(timeout=300.0) as http:
            while True:
                evt = await queue.get()
                if evt is None:
                    break
                if isinstance(evt, Exception):
                    print(f"[ws] socket error: {evt}")
                    break
                # Run handler in the background so a slow agent run doesn't
                # block draining the queue (multiple emails in quick succession).
                asyncio.create_task(
                    _handle_event(
                        evt,
                        inbox_id=inbox.inbox_id,
                        default_doc=default_doc,
                        seen_ids=seen_ids,
                        http=http,
                        reply=not args.no_reply,
                        max_actions=args.max_actions,
                    )
                )
        stop.set()
        await pump_task
    finally:
        try:
            cm.__exit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--inbox",
        default=DEFAULT_INBOX_ADDRESS,
        help=f"AgentMail address to watch (default: {DEFAULT_INBOX_ADDRESS}).",
    )
    ap.add_argument(
        "--doc",
        default=DEFAULT_DOC_ID,
        help="Default document_id when the email subject has no [anthill:<uuid>] tag.",
    )
    ap.add_argument(
        "--no-reply",
        action="store_true",
        help="Don't email the reviewer back a summary.",
    )
    ap.add_argument(
        "--max-actions",
        type=int,
        default=8,
        help="Cap on edit/comment ops per email (default 8).",
    )
    ap.add_argument(
        "--create",
        action="store_true",
        help="If the inbox doesn't exist, create it idempotently from the local-part.",
    )
    args = ap.parse_args()

    # Graceful Ctrl-C — asyncio.run already converts KeyboardInterrupt to a
    # cancel cascade, but we install a handler so the WS context exits cleanly.
    def _on_sigint(*_a: Any) -> None:  # noqa: ANN001
        print("\n[ws] interrupted; shutting down")
        # Default handler will raise KeyboardInterrupt; re-raise.
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _on_sigint)

    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
