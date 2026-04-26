#!/usr/bin/env -S uv run python
"""End-to-end smoke test for the `review_response` agent + AgentMail.

What this exercises:
  1. Provisions two AgentMail inboxes (idempotent via `client_id`):
       - "anthill-reviewer-test" — the reviewer persona.
       - "anthill-author-test"   — receives the review (the paper's mailbox).
  2. (Optional) Seeds a fresh research-paper document via the existing
     `seed-example-paper.ts` so we have real prose to suggest edits on.
  3. Sends a sample reviewer email from the reviewer inbox to the author
     inbox.
  4. Polls the author inbox until the message lands; grabs its message id.
  5. Triggers the `review_response` agent on the FastAPI backend with
     `{document_id, inbox_id, message_id, reply: True}`.
  6. Streams the SSE event log so you watch Claude plan + apply ops live.
  7. Snapshots the doc and prints which blocks got new comments /
     suggestion notes.
  8. Polls the reviewer inbox to confirm the agent's reply landed.

Prereqs:
  - Supabase   :54321
  - Hocuspocus :8888
  - Bridge     :8889
  - Backend    :8000
  - backend/.env has ANTHROPIC_KEY *and* AGENTMAIL_API_KEY set.

Usage:
  python backend/scripts/test_review_response.py                   # seed fresh
  python backend/scripts/test_review_response.py --doc <id>        # reuse doc
  python backend/scripts/test_review_response.py --no-seed --doc <id>
  python backend/scripts/test_review_response.py --review-file r.txt
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# Bootstrap: load backend/.env and put backend/ on sys.path so
# `from agents.agentmail_client import ...` resolves the same way the
# FastAPI process sees it.
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

REPO = _BACKEND.parent
COLLAB = REPO / "collab"

BRIDGE = os.environ.get("ANTHILL_BRIDGE_URL", "http://127.0.0.1:8889")
BRIDGE_TOKEN = os.environ.get("ANTHILL_AGENT_BRIDGE_SECRET", "")
BACKEND = os.environ.get("ANTHILL_BACKEND_URL", "http://127.0.0.1:8000")
BACKEND_SECRET = os.environ.get("ANTHILL_SHARED_SECRET", "")

REVIEWER_INBOX_CLIENT_ID = os.environ.get(
    "ANTHILL_TEST_REVIEWER_INBOX", "anthill-reviewer-test"
)
AUTHOR_INBOX_CLIENT_ID = os.environ.get(
    "ANTHILL_TEST_AUTHOR_INBOX", "anthill-author-test"
)

DEFAULT_REVIEW = """\
Hi authors,

Thanks for sharing the manuscript. Overall the work is interesting but I have a
few requests before I can recommend acceptance:

1. The title is too generic. Please make it more specific — something like
   "Anthill: A Collaborative Editor with Real-Time Citation Grounding" would
   better convey the contribution.

2. The abstract is too long and buries the contribution. Please tighten it to
   one paragraph that clearly states (a) the problem, (b) your specific
   contribution, and (c) the empirical result.

3. In the methodology section you describe the embedding setup but never say
   what dimensionality your vectors have or how you chunked the documents.
   Please add those details — without them the experiments are not
   reproducible.

4. The related-work coverage of CRDT-based collaborative editors is thin.
   Please add a paragraph comparing against Yjs-based prior systems and at
   least cite the original paper that introduced the conflict-free replicated
   data type.

Looking forward to the revision.

— Reviewer 2
"""


def _bridge_headers(agent_id: str = "smoke-test") -> dict[str, str]:
    h = {"X-Agent-Id": agent_id, "Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        h["X-Agent-Token"] = BRIDGE_TOKEN
    return h


def _backend_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BACKEND_SECRET:
        h["X-Anthill-Secret"] = BACKEND_SECRET
    return h


def seed_document(doc_id: str | None) -> str:
    """Reuse the canonical seed script with --no-citations so the reviewer
    has an unedited draft to critique."""
    cmd = ["bun", "scripts/seed-example-paper.ts", "--no-citations"]
    if doc_id:
        cmd += ["--doc-id", doc_id]
    print(f"[seed] running: {' '.join(cmd[1:])}")
    proc = subprocess.run(cmd, cwd=COLLAB, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"seeder failed (exit {proc.returncode})")
    tail = proc.stdout.splitlines()[-12:]
    for line in tail:
        print(f"[seed] {line}")
    if doc_id:
        return doc_id
    m = re.search(
        r"document created\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        proc.stdout,
    )
    if not m:
        m = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            proc.stdout,
        )
    if not m:
        sys.stderr.write(proc.stdout)
        raise SystemExit("could not parse new document id from seeder output")
    return m.group(1)


async def snapshot(client: httpx.AsyncClient, doc_id: str) -> dict[str, Any]:
    r = await client.get(
        f"{BRIDGE}/documents/{doc_id}/snapshot", headers=_bridge_headers()
    )
    r.raise_for_status()
    return r.json()


def count_notes(snap: dict[str, Any]) -> tuple[int, int, list[str]]:
    """Return (suggestions, comments, refs_with_notes)."""
    suggestions = 0
    comments = 0
    refs: list[str] = []
    for b in snap.get("blocks", []):
        kind = (b.get("attrs") or {}).get("noteKind")
        if kind == "suggestion":
            suggestions += 1
            refs.append(b["ref"])
        elif kind == "comment":
            comments += 1
            refs.append(b["ref"])
    return suggestions, comments, refs


async def stream_run_events(
    client: httpx.AsyncClient, run_id: str
) -> dict[str, Any]:
    url = f"{BACKEND}/agents/runs/{run_id}/events"
    print(f"[run] streaming {url}")
    async with client.stream(
        "GET", url, headers=_backend_headers(), timeout=None
    ) as resp:
        resp.raise_for_status()
        kind = ""
        data_buf: list[str] = []
        async for raw in resp.aiter_lines():
            if raw == "":
                if data_buf:
                    payload = "\n".join(data_buf)
                    try:
                        ev = json.loads(payload)
                    except Exception:
                        ev = {"raw": payload}
                    _print_event(kind, ev)
                    if kind == "status":
                        status = (ev.get("data") or {}).get("status")
                        if status in {"succeeded", "failed", "cancelled"}:
                            break
                kind = ""
                data_buf = []
                continue
            if raw.startswith("event:"):
                kind = raw[len("event:") :].strip()
            elif raw.startswith("data:"):
                data_buf.append(raw[len("data:") :].lstrip())
    r = await client.get(
        f"{BACKEND}/agents/runs/{run_id}", headers=_backend_headers()
    )
    r.raise_for_status()
    return r.json()


def _print_event(kind: str, ev: dict[str, Any]) -> None:
    msg = ev.get("message") or ""
    data = ev.get("data") or {}
    if kind == "status":
        print(f"  · status={data.get('status')} {msg}")
    elif kind == "step":
        step = data.get("step", "?")
        rest = {k: v for k, v in data.items() if k != "step"}
        print(f"  · [{step}] {msg}" + (f"  {_short(rest)}" if rest else ""))
    elif kind == "finding":
        print(
            f"  · ★ {data.get('kind')} on {data.get('anchor_ref')}: "
            f"{(data.get('preview') or '')[:120]}"
        )
    elif kind == "log":
        print(f"  · log: {msg}")
    elif kind == "error":
        print(f"  · error: {msg}")
    else:
        print(f"  · {kind}: {msg} {data}")


def _short(d: dict[str, Any], limit: int = 160) -> str:
    s = json.dumps(d, default=str)
    return s if len(s) <= limit else s[: limit - 1] + "…"


async def provision_inboxes() -> tuple[
    agentmail_client.InboxInfo, agentmail_client.InboxInfo
]:
    print("[mail] provisioning AgentMail inboxes (idempotent)…")
    reviewer = await agentmail_client.get_or_create_inbox(
        REVIEWER_INBOX_CLIENT_ID, display_name="Anthill Reviewer (test)"
    )
    author = await agentmail_client.get_or_create_inbox(
        AUTHOR_INBOX_CLIENT_ID, display_name="Anthill Author (test)"
    )
    print(f"[mail] reviewer inbox: {reviewer.inbox_id}  ({reviewer.address})")
    print(f"[mail] author   inbox: {author.inbox_id}  ({author.address})")
    if not reviewer.address or not author.address:
        # Some SDK versions surface the address as part of the create response;
        # if not, the test still works as long as both inboxes exist.
        print(
            "[mail] note: SDK didn't return an `address` field — sending will "
            "still work using inbox ids."
        )
    return reviewer, author


async def send_review_email(
    reviewer: agentmail_client.InboxInfo,
    author: agentmail_client.InboxInfo,
    review_text: str,
    subject: str,
) -> str | None:
    if not author.address:
        raise SystemExit(
            "AgentMail did not return an address for the author inbox; "
            "cannot route the review email. Recreate the inbox or upgrade the SDK."
        )
    print(f"[mail] sending review from {reviewer.inbox_id} → {author.address}")
    resp = await agentmail_client.send_email(
        reviewer.inbox_id,
        to=author.address,
        subject=subject,
        text=review_text,
    )
    sent_id = (
        resp.get("message_id") or resp.get("messageId") or resp.get("id")
    )
    print(f"[mail] sent message_id={sent_id}")
    return sent_id


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Reuse an existing document id (skip seeding).")
    ap.add_argument(
        "--no-seed",
        action="store_true",
        help="Skip seeding even if --doc is provided.",
    )
    ap.add_argument(
        "--review-file", help="Path to a text file containing the review email."
    )
    ap.add_argument(
        "--no-reply",
        action="store_true",
        help="Don't ask the agent to email the reviewer back.",
    )
    ap.add_argument("--max-actions", type=int, default=6)
    args = ap.parse_args()

    review_text = DEFAULT_REVIEW
    if args.review_file:
        review_text = Path(args.review_file).read_text()
        print(f"[mail] loaded review from {args.review_file} ({len(review_text)} chars)")

    if not os.environ.get("AGENTMAIL_API_KEY"):
        raise SystemExit(
            "AGENTMAIL_API_KEY not set in backend/.env. Sign up at "
            "https://console.agentmail.to to get a key."
        )

    doc_id = args.doc
    fresh = doc_id is None
    if fresh and not args.no_seed:
        doc_id = seed_document(None)
        time.sleep(1.5)
    elif not args.no_seed and doc_id:
        print(f"[seed] re-seeding existing doc {doc_id}")
        seed_document(doc_id)
        time.sleep(1.5)
    else:
        print(f"[seed] reusing existing doc {doc_id} (no re-seed)")

    if not doc_id:
        raise SystemExit("--doc is required when --no-seed is set")

    # 1. Provision both inboxes.
    reviewer, author = await provision_inboxes()

    # 2. Snapshot mail state so we know which messages are pre-existing.
    pre_author = await agentmail_client.list_messages(author.inbox_id, limit=25)
    pre_author_ids = {m.message_id for m in pre_author}
    pre_reviewer = await agentmail_client.list_messages(
        reviewer.inbox_id, limit=25
    )
    pre_reviewer_ids = {m.message_id for m in pre_reviewer}

    # 3. Send the review.
    subject = "Review of submitted manuscript — round 1"
    await send_review_email(reviewer, author, review_text, subject)

    # 4. Wait for it to show up in the author's inbox.
    print("[mail] polling author inbox for the review email…")
    landed = await agentmail_client.wait_for_message(
        author.inbox_id,
        subject_contains=subject[:20],
        after_message_ids=pre_author_ids,
        timeout_s=45.0,
    )
    if landed is None:
        raise SystemExit(
            "Review email never landed in the author inbox within 45s. "
            "Check AgentMail status / quotas."
        )
    print(
        f"[mail] received message_id={landed.message_id} from={landed.from_!r}"
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        # 5. Snapshot doc before
        before = await snapshot(client, doc_id)
        b_sug, b_com, _ = count_notes(before)
        print(
            f"[before] doc={doc_id}  blocks={before.get('blockCount')}  "
            f"title={before.get('title')!r}  suggestions={b_sug}  comments={b_com}"
        )

        # 6. Trigger the agent.
        body = {
            "agent": "review_response",
            "document_id": doc_id,
            "input": {
                "inbox_id": author.inbox_id,
                "message_id": landed.message_id,
                "sender_email": landed.from_,
                "sender_name": "Reviewer 2",
                "reply": not args.no_reply,
                "reply_inbox_id": author.inbox_id,
                "max_actions": args.max_actions,
            },
        }
        print(f"\n[run] POST /agents/runs  body={_short(body)}")
        r = await client.post(
            f"{BACKEND}/agents/runs", headers=_backend_headers(), json=body
        )
        if r.status_code >= 400:
            sys.stderr.write(r.text + "\n")
            r.raise_for_status()
        run = r.json()
        run_id = run["id"]
        print(f"[run] created id={run_id}  status={run['status']}")

        final = await stream_run_events(client, run_id)
        run_obj = final["run"]
        result = run_obj.get("result") or {}
        applied = result.get("applied") or []
        skipped = result.get("skipped") or []
        dropped = result.get("dropped") or []
        print(
            f"\n[run] done  status={run_obj['status']}  "
            f"applied={len(applied)}  skipped={len(skipped)}  dropped={len(dropped)}"
        )
        if result.get("summary"):
            print(f"[run] summary: {result['summary']}")

        # 7. Snapshot after — show what changed.
        time.sleep(0.5)
        after = await snapshot(client, doc_id)
        a_sug, a_com, note_refs = count_notes(after)
        print(
            f"\n[after] blocks={after.get('blockCount')}  "
            f"title={after.get('title')!r}  suggestions={a_sug}  comments={a_com}"
        )
        for b in after.get("blocks") or []:
            attrs = b.get("attrs") or {}
            kind = attrs.get("noteKind")
            if not kind:
                continue
            anchor = attrs.get("noteAnchorRef")
            text = (b.get("text") or "").strip()[:140]
            print(f"        {b['ref']:>4} [{kind:<10}] anchor={anchor}  “{text}…”")

    # 8. Did the reviewer get a reply?
    reply_info = result.get("reply") or {}
    if reply_info and not reply_info.get("error"):
        print("\n[mail] polling reviewer inbox for the agent's reply…")
        reply_msg = await agentmail_client.wait_for_message(
            reviewer.inbox_id,
            subject_contains="Review of submitted manuscript",
            after_message_ids=pre_reviewer_ids,
            timeout_s=45.0,
        )
        if reply_msg:
            print(
                f"[mail] reply received subject={reply_msg.subject!r}  "
                f"from={reply_msg.from_!r}"
            )
            print(f"[mail] body preview: {reply_msg.text[:280].rstrip()}…")
        else:
            print("[mail] no reply landed within 45s (still possibly in flight)")

    added = (a_sug + a_com) - (b_sug + b_com)
    ok = added > 0 and run_obj["status"] == "succeeded"
    print(
        f"\n[result] {'PASS' if ok else 'FAIL'}: added {added} note(s)  "
        f"(suggestions {b_sug}→{a_sug}, comments {b_com}→{a_com})  doc_id={doc_id}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
