"""`addComment` tool — drops a margin-comment block right after a target block.

Inputs:
  document_id: str   (from the run)
  anchor_ref:  str   (required) — block this comment attaches to, e.g. "b3"
  body:        str   (required) — comment text

Effect: posts an `addNote` op with kind="comment". Stored as a Plate
`blockquote` with `noteKind: 'comment'`, `noteAnchorRef`, `noteAuthor`.
"""

from __future__ import annotations

from typing import Any

from .bridge_client import BridgeError, get_client
from .tracing import Tracer

_AGENT_ID = "add_comment"


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required")

    anchor_ref = str(input.get("anchor_ref") or "").strip()
    if not anchor_ref:
        raise ValueError("`anchor_ref` is required")

    body = str(input.get("body") or "").strip()
    if not body:
        raise ValueError("`body` is required")

    await tracer.step(
        "comment",
        f"Adding comment on {anchor_ref}",
        anchor_ref=anchor_ref,
        chars=len(body),
    )

    client = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)
    try:
        result = await client.edit(
            document_id,
            ops=[
                {
                    "type": "addNote",
                    "anchorRef": anchor_ref,
                    "kind": "comment",
                    "body": body,
                }
            ],
            idempotency_key=f"{tracer.run.id}:comment:{anchor_ref}",
        )
    except BridgeError as e:
        await tracer.error(f"bridge edit failed: {e}")
        raise

    new_refs = result.get("newRefs") or []
    await tracer.step(
        "applied",
        f"Comment inserted as {new_refs[0] if new_refs else '?'}",
        revision=result.get("baseRevision"),
        new_ref=new_refs[0] if new_refs else None,
    )
    return {
        "anchor_ref": anchor_ref,
        "comment_ref": new_refs[0] if new_refs else None,
        "revision": result.get("baseRevision"),
    }
