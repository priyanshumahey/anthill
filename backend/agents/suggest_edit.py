"""`suggestEdit` tool — proposes a replacement for a block as a tracked change.

Inputs:
  document_id:  str   (from the run)
  anchor_ref:   str   (required) — block being edited, e.g. "b3"
  replacement:  str   (required) — proposed new text
  rationale:    str|None — short explanation shown in the suggestion UI

Effect: posts an `addNote` op with kind="suggestion" carrying the
replacement text + rationale. The web editor renders these as accept/reject
suggestion cards anchored to `anchor_ref`. The original block is *not*
modified — the human accepts or rejects.
"""

from __future__ import annotations

from typing import Any

from .bridge_client import BridgeError, get_client
from .tracing import Tracer

_AGENT_ID = "suggest_edit"


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required")

    anchor_ref = str(input.get("anchor_ref") or "").strip()
    if not anchor_ref:
        raise ValueError("`anchor_ref` is required")

    replacement = str(input.get("replacement") or "")
    if not replacement.strip():
        raise ValueError("`replacement` must be a non-empty string")

    rationale = str(input.get("rationale") or "").strip() or None
    body = rationale or "Suggested edit"

    await tracer.step(
        "suggest",
        f"Suggesting edit on {anchor_ref}",
        anchor_ref=anchor_ref,
        replacement_chars=len(replacement),
        rationale=rationale,
    )

    op: dict[str, Any] = {
        "type": "addNote",
        "anchorRef": anchor_ref,
        "kind": "suggestion",
        "body": body,
        "replacement": replacement,
    }
    if rationale:
        op["rationale"] = rationale

    client = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)
    try:
        result = await client.edit(
            document_id,
            ops=[op],
            idempotency_key=f"{tracer.run.id}:suggest:{anchor_ref}",
        )
    except BridgeError as e:
        await tracer.error(f"bridge edit failed: {e}")
        raise

    new_refs = result.get("newRefs") or []
    await tracer.step(
        "applied",
        f"Suggestion inserted as {new_refs[0] if new_refs else '?'}",
        revision=result.get("baseRevision"),
        new_ref=new_refs[0] if new_refs else None,
    )
    return {
        "anchor_ref": anchor_ref,
        "suggestion_ref": new_refs[0] if new_refs else None,
        "revision": result.get("baseRevision"),
    }
