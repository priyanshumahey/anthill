"""`review_response` agent — turns a peer-review email into Yjs edits.

Reviewer drops a critique into the author's AgentMail inbox; this agent:

  1. Pulls the review text (either supplied directly or fetched from
     AgentMail by `inbox_id`+`message_id`).
  2. Snapshots the live document via the agent bridge so it can ground
     each piece of feedback to a real block ref.
  3. Asks Claude to map the review into a list of structured *actions*:
        - kind="edit"     → suggestEdit op (rendered as a tracked-change
                            card the human accepts/rejects).
        - kind="comment"  → addComment op (margin comment).
        - kind="title"    → setTitle op (rare; reviewer asked for a new
                            paper title).
  4. Applies each action through the bridge with stable idempotency keys,
     so retrying the same run never double-applies.
  5. Optionally emails the reviewer back with a summary of what was queued
     for the human to triage.

The agent never edits prose destructively on its own — every textual change
goes in as a `suggestion` so the human stays in the loop. That matches the
peer-review UX: agents propose, humans dispose.

Inputs:
  document_id:    str  (from the run; required)
  review_text:    str  (required unless inbox_id+message_id supplied)
  sender_name:    str | None  (used to attribute comments)
  sender_email:   str | None  (used as `to` for the reply)
  inbox_id:       str | None  (AgentMail inbox holding the review)
  message_id:     str | None  (specific email to fetch)
  reply:          bool (default False) — email the reviewer a summary
  reply_inbox_id: str | None — which AgentMail inbox sends the reply
                                (defaults to `inbox_id`)
  max_actions:    int  (default 8) — hard cap on edit/comment ops
  model:          str | None — override Claude model
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import agentmail_client
from .bridge_client import BridgeError, get_client
from .tracing import Tracer

_AGENT_ID = "review_response"

# Same .env-bootstrap trick used by nia_client / agentmail_client. Lets
# scripts import this module and immediately use ANTHROPIC_KEY without
# having to re-export it in the shell.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if _ENV_FILE.is_file():
    for _line in _ENV_FILE.read_text().splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())


_DEFAULT_MODEL = os.environ.get("ANTHILL_REVIEW_MODEL", "claude-sonnet-4-20250514")
_ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"

# Trim each block preview when prompting Claude — full chunks blow the
# context for free without much added signal.
_BLOCK_PREVIEW_CHARS = 600
_REVIEW_PREVIEW_CHARS = 8000


_SYSTEM_PROMPT = """\
You are a research-paper revision agent. A peer reviewer has emailed feedback \
on the author's draft. The author is in a collaborative editor; you can leave \
two kinds of marks on their document:

  • SUGGESTION  — propose a replacement for one block of text. Rendered as a \
tracked change the author accepts or rejects.
  • COMMENT     — leave a margin note on a block (no replacement). Use this \
when the reviewer raised a question, asked for clarification, or wants a \
direction without dictating the wording.

You also may rename the paper title once if the reviewer explicitly asks for it.

You will be given:
  • The reviewer's email body.
  • A snapshot of the document as a numbered list of blocks. Each line is:
        <ref>  [<type>]  <text-preview>

Map the reviewer's feedback into a JSON object that the system can apply \
mechanically. Be specific, surgical, and faithful to what the reviewer asked \
for. Do NOT invent feedback the reviewer didn't raise. Do NOT touch a block \
that has nothing to do with any item in the review.

Output ONLY a JSON object matching this schema (no prose, no markdown fences):

{
  "summary": "1-3 sentence overview of what the reviewer asked for.",
  "reply_body": "Plain-text email reply to the reviewer (3-6 sentences) \
acknowledging their feedback and listing the changes you queued. Omit if no \
actions.",
  "actions": [
    {
      "kind": "edit" | "comment" | "title",
      "anchor_ref": "<one of the block refs above; omit only for kind='title'>",
      "replacement": "<full new block text — required for kind='edit'>",
      "body": "<comment text — required for kind='comment'; concise>",
      "rationale": "<why this change addresses the review — 1-2 sentences>",
      "title": "<new title — required for kind='title'>"
    }
  ]
}

Rules:
  • At most {max_actions} actions. Skip nitpicks if the cap is tight.
  • Prefer COMMENT when the reviewer's ask is open-ended.
  • Prefer EDIT when the reviewer dictated wording or a clear fix.
  • `replacement` must be the COMPLETE new text of the block, not a diff.
  • Every `anchor_ref` must come from the snapshot — do not invent refs.
  • Never include markdown formatting in `replacement` or `body`; the editor \
stores plain text.
"""


def _build_block_listing(blocks: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        ref = str(b.get("ref") or "")
        if not ref:
            continue
        btype = str(b.get("type") or "")
        text = (b.get("text") or "").strip().replace("\n", " ")
        if len(text) > _BLOCK_PREVIEW_CHARS:
            text = text[: _BLOCK_PREVIEW_CHARS - 1] + "…"
        lines.append(f"{ref}  [{btype}]  {text}")
    return "\n".join(lines) or "(empty document)"


def _build_user_prompt(
    review_text: str,
    sender: str | None,
    title: str | None,
    block_listing: str,
    max_actions: int,
) -> str:
    sender_line = f"Reviewer: {sender}\n" if sender else ""
    title_line = f"Paper title: {title}\n" if title else ""
    return (
        f"{title_line}{sender_line}\n"
        f"=== REVIEWER EMAIL ===\n"
        f"{review_text[:_REVIEW_PREVIEW_CHARS]}\n"
        f"=== END EMAIL ===\n\n"
        f"=== DOCUMENT BLOCKS ===\n"
        f"{block_listing}\n"
        f"=== END BLOCKS ===\n\n"
        f"Produce the JSON object now. Cap at {max_actions} actions."
    )


def _strip_json_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        # ```json ... ``` or ``` ... ```
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[:-3]
    return s.strip()


async def _call_claude(
    *,
    api_key: str,
    model: str,
    system: str,
    user: str,
) -> dict[str, Any]:
    headers = {
        "x-api-key": api_key,
        "anthropic-version": _ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    body = {
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.2,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(_ANTHROPIC_API, headers=headers, json=body)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Anthropic API {resp.status_code}: {resp.text[:500]}"
            )
        payload = resp.json()
    parts = payload.get("content") or []
    text_parts = [p.get("text", "") for p in parts if p.get("type") == "text"]
    text = "".join(text_parts).strip()
    if not text:
        raise RuntimeError(f"Claude returned no text content: {payload}")
    cleaned = _strip_json_fence(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        # Try to salvage by clipping to the outermost braces.
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                pass
        raise RuntimeError(f"Claude JSON parse failed: {e}; body={cleaned[:400]}") from e


def _normalize_action(
    raw: dict[str, Any], known_refs: set[str]
) -> dict[str, Any] | None:
    """Validate an action shape; drop anything malformed or off-target."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").lower().strip()
    if kind not in {"edit", "comment", "title"}:
        return None

    rationale = str(raw.get("rationale") or "").strip() or None

    if kind == "title":
        title = str(raw.get("title") or "").strip()
        if not title:
            return None
        return {"kind": "title", "title": title, "rationale": rationale}

    anchor = str(raw.get("anchor_ref") or "").strip()
    if not anchor or anchor not in known_refs:
        return None

    if kind == "edit":
        replacement = str(raw.get("replacement") or "").strip()
        if not replacement:
            return None
        body = str(raw.get("body") or "").strip()
        return {
            "kind": "edit",
            "anchor_ref": anchor,
            "replacement": replacement,
            "rationale": rationale,
            "body": body or rationale or "Reviewer-suggested edit",
        }

    # comment
    body = str(raw.get("body") or "").strip()
    if not body:
        return None
    return {
        "kind": "comment",
        "anchor_ref": anchor,
        "body": body,
        "rationale": rationale,
    }


def _ops_for_action(action: dict[str, Any]) -> list[dict[str, Any]]:
    kind = action["kind"]
    if kind == "title":
        return [{"type": "setTitle", "title": action["title"]}]
    if kind == "edit":
        op: dict[str, Any] = {
            "type": "addNote",
            "anchorRef": action["anchor_ref"],
            "kind": "suggestion",
            "body": action.get("body") or "Reviewer-suggested edit",
            "replacement": action["replacement"],
        }
        if action.get("rationale"):
            op["rationale"] = action["rationale"]
        return [op]
    # comment
    return [
        {
            "type": "addNote",
            "anchorRef": action["anchor_ref"],
            "kind": "comment",
            "body": action["body"],
        }
    ]


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required")

    inbox_id = (input.get("inbox_id") or "").strip() or None
    message_id = (input.get("message_id") or "").strip() or None
    review_text = str(input.get("review_text") or "").strip()
    sender_name = (input.get("sender_name") or "").strip() or None
    sender_email = (input.get("sender_email") or "").strip() or None
    reply = bool(input.get("reply", False))
    reply_inbox_id = (input.get("reply_inbox_id") or "").strip() or inbox_id
    max_actions = max(1, min(int(input.get("max_actions") or 8), 25))
    model = (input.get("model") or "").strip() or _DEFAULT_MODEL

    fetched_message: dict[str, Any] | None = None
    if not review_text:
        if not (inbox_id and message_id):
            raise ValueError(
                "Provide either `review_text` or both `inbox_id` and `message_id`"
            )
        await tracer.step(
            "fetch_email",
            f"Fetching review email {message_id} from inbox {inbox_id}",
            inbox_id=inbox_id,
            message_id=message_id,
        )
        try:
            msg = await agentmail_client.get_message(inbox_id, message_id)
        except agentmail_client.AgentMailError as e:
            await tracer.error(f"agentmail fetch failed: {e}")
            raise
        review_text = msg.text or ""
        sender_email = sender_email or msg.from_
        fetched_message = {
            "subject": msg.subject,
            "from": msg.from_,
            "to": msg.to,
        }
        if not review_text.strip():
            raise ValueError(f"AgentMail message {message_id} has empty text body")

    api_key = (
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("ANTHROPIC_KEY")
        or ""
    ).strip()
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY (or ANTHROPIC_KEY) not set; cannot call Claude"
        )

    bridge = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)

    await tracer.step(
        "snapshot",
        f"Loading document {document_id}",
        document_id=document_id,
    )
    try:
        snapshot = await bridge.snapshot(document_id)
    except BridgeError as e:
        await tracer.error(f"bridge snapshot failed: {e}")
        raise

    blocks: list[dict[str, Any]] = snapshot.get("blocks") or []
    title: str | None = snapshot.get("title") or None
    known_refs = {b["ref"] for b in blocks if isinstance(b, dict) and "ref" in b}
    block_listing = _build_block_listing(blocks)

    await tracer.step(
        "plan",
        f"Asking Claude to map review onto {len(blocks)} block(s)",
        model=model,
        review_chars=len(review_text),
        max_actions=max_actions,
        sender=sender_name or sender_email,
    )

    user_prompt = _build_user_prompt(
        review_text, sender_name or sender_email, title, block_listing, max_actions
    )
    system_prompt = _SYSTEM_PROMPT.replace("{max_actions}", str(max_actions))

    try:
        plan = await _call_claude(
            api_key=api_key, model=model, system=system_prompt, user=user_prompt
        )
    except Exception as e:  # noqa: BLE001
        await tracer.error(f"Claude planning failed: {e}")
        raise

    summary = str(plan.get("summary") or "").strip()
    reply_body = str(plan.get("reply_body") or "").strip()
    raw_actions = plan.get("actions") or []
    if not isinstance(raw_actions, list):
        raw_actions = []

    actions: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for raw in raw_actions[: max_actions * 2]:
        norm = _normalize_action(raw, known_refs)
        if norm is None:
            dropped.append({"raw": raw, "reason": "invalid_or_unknown_ref"})
            continue
        actions.append(norm)
        if len(actions) >= max_actions:
            break

    await tracer.step(
        "plan_done",
        f"Claude proposed {len(actions)} action(s); summary: {summary[:160]}",
        summary=summary,
        action_count=len(actions),
        dropped=len(dropped),
    )
    for a in actions:
        await tracer.finding(
            kind=a["kind"],
            anchor_ref=a.get("anchor_ref"),
            rationale=a.get("rationale"),
            preview=(a.get("replacement") or a.get("body") or a.get("title") or "")[
                :160
            ],
        )

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for idx, action in enumerate(actions):
        kind = action["kind"]
        anchor = action.get("anchor_ref") or "title"
        await tracer.step(
            "apply",
            f"Applying {kind} on {anchor}",
            kind=kind,
            anchor_ref=action.get("anchor_ref"),
        )
        ops = _ops_for_action(action)
        idem = f"{tracer.run.id}:rev:{idx}:{kind}:{anchor}"
        try:
            result = await bridge.edit(document_id, ops=ops, idempotency_key=idem)
        except BridgeError as e:
            await tracer.error(f"bridge edit failed for {kind} on {anchor}: {e}")
            skipped.append(
                {"action": action, "reason": "bridge_error", "error": str(e)}
            )
            continue
        new_refs = result.get("newRefs") or []
        applied.append(
            {
                **action,
                "ops": ops,
                "new_ref": new_refs[0] if new_refs else None,
                "revision": result.get("baseRevision"),
            }
        )
        await tracer.step(
            "applied",
            f"{kind} → {new_refs[0] if new_refs else '(in-place)'}",
            kind=kind,
            new_ref=new_refs[0] if new_refs else None,
            revision=result.get("baseRevision"),
        )

    reply_info: dict[str, Any] | None = None
    if reply and applied:
        if not (reply_inbox_id and sender_email):
            await tracer.log(
                "Reply skipped: missing reply_inbox_id or sender_email",
                reply_inbox_id=reply_inbox_id,
                sender_email=sender_email,
            )
        else:
            body = reply_body or _fallback_reply_body(summary, applied)
            subject = _reply_subject(fetched_message, title)
            await tracer.step(
                "reply",
                f"Emailing reviewer at {sender_email}",
                to=sender_email,
                inbox_id=reply_inbox_id,
            )
            try:
                send_resp = await agentmail_client.send_email(
                    reply_inbox_id,
                    to=sender_email,
                    subject=subject,
                    text=body,
                )
                reply_info = {
                    "to": sender_email,
                    "from_inbox": reply_inbox_id,
                    "subject": subject,
                    "body": body,
                    "response": send_resp,
                }
                await tracer.step(
                    "reply_sent",
                    f"Reply queued via AgentMail",
                    message_id=send_resp.get("message_id")
                    or send_resp.get("messageId"),
                )
            except agentmail_client.AgentMailError as e:
                await tracer.error(f"agentmail send failed: {e}")
                reply_info = {"error": str(e)}

    await tracer.step(
        "summary",
        f"Applied {len(applied)} action(s); dropped {len(dropped)}; skipped {len(skipped)}",
        applied=len(applied),
        dropped=len(dropped),
        skipped=len(skipped),
    )

    return {
        "document_id": document_id,
        "summary": summary,
        "applied": applied,
        "skipped": skipped,
        "dropped": dropped,
        "reply": reply_info,
        "model": model,
        "review": {
            "chars": len(review_text),
            "from": sender_email,
            "name": sender_name,
            "fetched_message": fetched_message,
        },
        "produced_at": datetime.now(timezone.utc).isoformat(),
    }


def _fallback_reply_body(summary: str, applied: list[dict[str, Any]]) -> str:
    counts: dict[str, int] = {}
    for a in applied:
        counts[a["kind"]] = counts.get(a["kind"], 0) + 1
    parts = ", ".join(f"{n} {k}{'s' if n != 1 else ''}" for k, n in counts.items())
    intro = summary or "Thanks for the review."
    return (
        f"{intro}\n\n"
        f"I've queued {parts} on the manuscript. They appear as suggestions "
        f"and comments in our shared editor for the author to triage.\n\n"
        f"— Anthill review-response agent"
    )


def _reply_subject(fetched: dict[str, Any] | None, title: str | None) -> str:
    if fetched and fetched.get("subject"):
        subj = str(fetched["subject"])
        return subj if subj.lower().startswith("re:") else f"Re: {subj}"
    if title:
        return f"Re: review of “{title}”"
    return "Re: review feedback"
