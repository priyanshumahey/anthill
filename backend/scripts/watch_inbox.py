#!/usr/bin/env -S uv run python
"""Watch an AgentMail inbox and trigger `review_response` on every new email.

Polling-based — every `--poll` seconds we list the inbox and fire the agent
on anything we haven't seen before. Polling is boring but it always works,
which matters more than latency for a review demo. (Earlier WebSocket-based
version had silent-dropouts in this environment; polling sidesteps the issue.)

Routing — which document gets edited:

  1. If the email subject contains a tag like `[anthill:<uuid>]`, that
     document_id wins. (Lets one inbox drive multiple papers.)
  2. Otherwise the `--doc` CLI flag (or `ANTHILL_REVIEW_DOC_ID` env var)
     is used as the default.

Default inbox: `anthill@agentmail.to` — override with `--inbox` (address) or
`ANTHILL_REVIEW_INBOX_ADDRESS`.

Usage:
    cd backend && source .venv/bin/activate
    python scripts/watch_inbox.py --doc 003cb3da-c1b0-42a3-8155-a24749d80fe7

Then send any email to anthill@agentmail.to from your normal mail client.
Within ~5 seconds the agent will run and you'll see the SSE log here.

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
import sys
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


async def _process_message(
    *,
    msg: agentmail_client.InboundMessage,
    inbox_id: str,
    default_doc: str | None,
    http: httpx.AsyncClient,
    reply: bool,
    max_actions: int,
) -> None:
    print()
    print(f"📬 incoming  message_id={msg.message_id}")
    print(f"             from={msg.from_!r}")
    print(f"             subject={msg.subject!r}")

    doc_id = _route_doc_id(msg.subject, default_doc)
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
            message_id=msg.message_id,
            sender_email=msg.from_,
            sender_name=None,
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
    print(f"📭 done with {msg.message_id}\n")


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

    # Pre-warm: ignore everything already in the inbox so old emails don't
    # all fire when we connect. We only act on messages whose ids appear AFTER
    # this initial baseline.
    seen_ids: set[str] = set()
    try:
        existing = await agentmail_client.list_messages(inbox.inbox_id, limit=100)
        for m in existing:
            seen_ids.add(m.message_id)
        print(
            f"[poll] baseline: {len(seen_ids)} pre-existing message(s); "
            f"only acting on emails received from now on."
        )
    except Exception as e:  # noqa: BLE001
        print(f"[poll] could not list existing messages (continuing anyway): {e}")

    print(
        f"[poll] polling every {args.poll}s; send an email to "
        f"{inbox.address!r} to trigger the agent. (Ctrl-C to quit.)"
    )

    async with httpx.AsyncClient(timeout=300.0) as http:
        tick = 0
        while True:
            tick += 1
            try:
                msgs = await agentmail_client.list_messages(
                    inbox.inbox_id, limit=25
                )
            except Exception as e:  # noqa: BLE001
                print(f"[poll] list failed (will retry): {e}")
                await asyncio.sleep(args.poll)
                continue

            new = [m for m in msgs if m.message_id not in seen_ids]
            if args.verbose and not new:
                print(
                    f"[poll #{tick}] no new messages "
                    f"(inbox has {len(msgs)})"
                )

            # Process oldest-first so a backlog applies in the right order.
            for m in reversed(new):
                seen_ids.add(m.message_id)
                # Run handler in the background so a slow agent run doesn't
                # block the next poll. Multiple emails arriving back-to-back
                # will run concurrently; the bridge serializes the writes.
                asyncio.create_task(
                    _process_message(
                        msg=m,
                        inbox_id=inbox.inbox_id,
                        default_doc=default_doc,
                        http=http,
                        reply=not args.no_reply,
                        max_actions=args.max_actions,
                    )
                )

            await asyncio.sleep(args.poll)


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
    ap.add_argument(
        "--poll",
        type=float,
        default=5.0,
        help="Seconds between inbox polls (default 5).",
    )
    ap.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print a heartbeat on every poll, even when nothing new arrived.",
    )
    args = ap.parse_args()

    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[poll] interrupted; bye.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
