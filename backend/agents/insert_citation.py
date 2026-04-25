"""`insertCitation` tool — inserts an inline citation badge into a block.

Inputs:
  document_id: str   (required, from the agent run)
  block_ref:   str   (required) — the snapshot ref of the target block, e.g. "b3"
  arxiv_id:    str   (required)
  chunk_index: int   (default 0)
  title:       str|None
  score:       float|None
  snippet:     str|None
  query:       str|None  — paragraph text that triggered the citation
  trace:       list[dict]|None — top-k candidates considered

Effect: posts an `appendInline` op to the bridge that adds a `citation`
inline element to the end of `block_ref`. The element shape matches the
`TCitationElement` Plate node so the editor renders it identically to a
user-accepted suggestion.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .bridge_client import BridgeError, get_client
from .tracing import Tracer

_AGENT_ID = "insert_citation"


def _build_citation_element(payload: dict[str, Any]) -> dict[str, Any]:
    arxiv_id = str(payload["arxiv_id"]).strip()
    if not arxiv_id:
        raise ValueError("`arxiv_id` is required")

    snippet = payload.get("snippet")
    if isinstance(snippet, str) and len(snippet) > 600:
        snippet = snippet[:600].rstrip() + "…"

    el: dict[str, Any] = {
        "type": "citation",
        "arxivId": arxiv_id,
        "chunkIndex": int(payload.get("chunk_index") or 0),
        "children": [{"text": ""}],
    }
    for src, dst in (
        ("title", "title"),
        ("score", "score"),
        ("query", "query"),
        ("taken_ms", "takenMs"),
    ):
        v = payload.get(src)
        if v is not None:
            el[dst] = v
    if snippet is not None:
        el["snippet"] = snippet
    if payload.get("searched_at"):
        el["searchedAt"] = payload["searched_at"]
    elif payload.get("query"):
        el["searchedAt"] = datetime.now(timezone.utc).isoformat()

    trace = payload.get("trace")
    if isinstance(trace, list) and trace:
        el["trace"] = [
            {
                "arxivId": str(t.get("arxiv_id") or t.get("arxivId") or ""),
                "chunkIndex": int(t.get("chunk_index") or t.get("chunkIndex") or 0),
                "title": t.get("title"),
                "score": float(t.get("score") or 0.0),
                "snippet": (t.get("text") or t.get("snippet")),
            }
            for t in trace
            if (t.get("arxiv_id") or t.get("arxivId"))
        ]

    return el


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required (set on the run or in input)")

    block_ref = str(input.get("block_ref") or "").strip()
    if not block_ref:
        raise ValueError("`block_ref` is required")

    element = _build_citation_element(input)

    await tracer.step(
        "insert",
        f"Inserting citation arXiv:{element['arxivId']} into {block_ref}",
        block_ref=block_ref,
        arxiv_id=element["arxivId"],
        chunk_index=element["chunkIndex"],
    )

    client = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)
    try:
        result = await client.edit(
            document_id,
            ops=[{"type": "appendInline", "ref": block_ref, "element": element}],
            idempotency_key=f"{tracer.run.id}:cite:{block_ref}:{element['arxivId']}",
        )
    except BridgeError as e:
        await tracer.error(f"bridge edit failed: {e}")
        raise

    await tracer.step(
        "applied",
        f"Citation inserted (rev {result.get('baseRevision')})",
        revision=result.get("baseRevision"),
        block_count=result.get("blockCount"),
    )
    return {
        "block_ref": block_ref,
        "arxiv_id": element["arxivId"],
        "chunk_index": element["chunkIndex"],
        "revision": result.get("baseRevision"),
    }
