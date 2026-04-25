"""Citation inserter agent.

Walks a document, runs semantic search on each substantive paragraph, and
inserts the best matching citation as an inline `citation` element. This is
the read-the-doc-and-cite-it agent — the autonomous counterpart to the
in-editor citation-suggest plugin (which only fires on the active block).

Inputs:
  document_id:    str   (from the run)
  block_refs:     list[str] | None — limit to specific blocks (default: all)
  min_chars:      int    (default 80)  — skip blocks shorter than this
  top_k:          int    (default 5)   — candidates to consider per block
  min_score:      float  (default 0.55)
  max_inserts:    int    (default 8)   — overall cap so a long doc can't
                                         drown the editor in citations
  skip_cited:     bool   (default True) — don't add a second citation to a
                                         block that already has one
  block_types:    list[str] (default ["p"]) — which Plate types are eligible

Effect: for each picked paragraph, calls the embedding service's `/search`,
then posts an `appendInline` op with the top hit (when above threshold) to
the agent bridge. Streams findings via the standard tracer so the run UI
can render progress live.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from .bridge_client import BridgeClient, BridgeError, get_client
from .insert_citation import _build_citation_element
from .tracing import Tracer

_AGENT_ID = "citation_inserter"

_QUERY_INSTRUCTION = (
    "Instruct: Given a scientific query, retrieve relevant paper passages\n"
    "Query: "
)


def _eligible(block: dict[str, Any], allowed_types: set[str], min_chars: int) -> bool:
    if not isinstance(block, dict):
        return False
    btype = str(block.get("type") or "")
    if allowed_types and btype not in allowed_types:
        return False
    text = (block.get("text") or "").strip()
    if len(text) < min_chars:
        return False
    return True


def _has_citation(block: dict[str, Any]) -> bool:
    inlines = block.get("inlines") or []
    return any(
        isinstance(i, dict) and i.get("type") == "citation" for i in inlines
    )


async def _search_one(
    text: str, top_k: int
) -> tuple[list[dict[str, Any]], int]:
    """Run a query against the local embedding service.

    Imports lazily so the agent can be loaded by FastAPI even if a future
    refactor moves the embedding service out of process. We call the
    in-process functions directly to avoid an HTTP round-trip when the
    agent is colocated with the FastAPI app.
    """
    from main import _embed, _get_collection, get_settings  # type: ignore[import-not-found]

    settings = get_settings()
    k = max(1, min(top_k, settings.max_k))
    collection = await asyncio.to_thread(_get_collection)
    if await asyncio.to_thread(collection.count) == 0:
        return [], 0

    t0 = time.time()
    emb = await asyncio.to_thread(_embed, [_QUERY_INSTRUCTION + text])
    res = await asyncio.to_thread(
        collection.query, query_embeddings=emb.tolist(), n_results=k
    )
    took_ms = int((time.time() - t0) * 1000)

    ids = (res.get("ids") or [[]])[0]
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists = (res.get("distances") or [[]])[0]

    hits: list[dict[str, Any]] = []
    for doc_id, doc, meta, dist in zip(ids, docs, metas, dists):
        meta = meta or {}
        hits.append(
            {
                "arxiv_id": str(meta.get("arxiv_id") or doc_id.split("__chunk_")[0]),
                "chunk_index": int(meta.get("chunk_index", 0)),
                "title": meta.get("title"),
                "score": float(1.0 - dist),
                "text": doc or "",
            }
        )
    return hits, took_ms


async def _insert(
    client: BridgeClient,
    document_id: str,
    block_ref: str,
    hit: dict[str, Any],
    *,
    query: str,
    taken_ms: int,
    trace: list[dict[str, Any]],
    run_id: str,
) -> dict[str, Any]:
    payload = {
        "arxiv_id": hit["arxiv_id"],
        "chunk_index": hit["chunk_index"],
        "title": hit.get("title"),
        "score": hit["score"],
        "snippet": hit.get("text"),
        "query": query,
        "taken_ms": taken_ms,
        "searched_at": datetime.now(timezone.utc).isoformat(),
        "trace": trace,
    }
    element = _build_citation_element(payload)
    return await client.edit(
        document_id,
        ops=[{"type": "appendInline", "ref": block_ref, "element": element}],
        idempotency_key=f"{run_id}:cite:{block_ref}:{element['arxivId']}",
    )


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required")

    requested_refs = input.get("block_refs") or []
    if requested_refs and not isinstance(requested_refs, list):
        raise ValueError("`block_refs` must be a list of refs")

    min_chars = max(20, int(input.get("min_chars") or 80))
    top_k = max(1, min(int(input.get("top_k") or 5), 25))
    min_score = float(input.get("min_score") or 0.55)
    max_inserts = max(1, min(int(input.get("max_inserts") or 8), 50))
    skip_cited = bool(input.get("skip_cited", True))
    allowed_types = set(input.get("block_types") or ["p"])

    client = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)

    await tracer.step(
        "snapshot", f"Loading document {document_id}", document_id=document_id
    )
    try:
        snapshot = await client.snapshot(document_id)
    except BridgeError as e:
        await tracer.error(f"bridge snapshot failed: {e}")
        raise

    blocks: list[dict[str, Any]] = snapshot.get("blocks") or []
    by_ref = {b["ref"]: b for b in blocks if isinstance(b, dict) and "ref" in b}

    if requested_refs:
        candidates = [by_ref[r] for r in requested_refs if r in by_ref]
        unknown = [r for r in requested_refs if r not in by_ref]
        if unknown:
            await tracer.log(f"Skipping unknown refs: {', '.join(unknown)}")
    else:
        candidates = blocks

    eligible = [b for b in candidates if _eligible(b, allowed_types, min_chars)]
    if skip_cited:
        eligible = [b for b in eligible if not _has_citation(b)]

    await tracer.step(
        "plan",
        f"{len(eligible)} eligible block(s) of {len(blocks)} total",
        eligible=len(eligible),
        total=len(blocks),
        max_inserts=max_inserts,
    )

    inserted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for block in eligible:
        if len(inserted) >= max_inserts:
            await tracer.log(
                f"Reached max_inserts={max_inserts}; stopping early",
            )
            break

        ref = block["ref"]
        text = (block.get("text") or "").strip()
        await tracer.step(
            "search",
            f"Searching citations for {ref}",
            block_ref=ref,
            chars=len(text),
        )
        try:
            hits, took_ms = await _search_one(text, top_k)
        except Exception as e:  # noqa: BLE001
            await tracer.error(f"search failed for {ref}: {e}")
            skipped.append({"block_ref": ref, "reason": "search_failed"})
            continue

        if not hits:
            await tracer.step(
                "search_empty", f"No hits for {ref}", block_ref=ref
            )
            skipped.append({"block_ref": ref, "reason": "no_hits"})
            continue

        top = hits[0]
        if top["score"] < min_score:
            await tracer.step(
                "search_below_threshold",
                f"Top hit {top['score']:.2f} < {min_score:.2f} for {ref}",
                block_ref=ref,
                top_score=top["score"],
            )
            skipped.append(
                {"block_ref": ref, "reason": "below_threshold", "top_score": top["score"]}
            )
            continue

        await tracer.finding(
            block_ref=ref,
            arxiv_id=top["arxiv_id"],
            title=top.get("title"),
            score=top["score"],
            chunk_index=top["chunk_index"],
            took_ms=took_ms,
        )

        try:
            result = await _insert(
                client,
                document_id,
                ref,
                top,
                query=text,
                taken_ms=took_ms,
                trace=hits[: min(top_k, 5)],
                run_id=tracer.run.id,
            )
        except BridgeError as e:
            await tracer.error(f"insert failed for {ref}: {e}")
            skipped.append({"block_ref": ref, "reason": "insert_failed", "error": str(e)})
            continue

        await tracer.step(
            "inserted",
            f"Cited arXiv:{top['arxiv_id']} on {ref}",
            block_ref=ref,
            arxiv_id=top["arxiv_id"],
            revision=result.get("baseRevision"),
        )
        inserted.append(
            {
                "block_ref": ref,
                "arxiv_id": top["arxiv_id"],
                "chunk_index": top["chunk_index"],
                "score": top["score"],
                "title": top.get("title"),
                "revision": result.get("baseRevision"),
            }
        )

    await tracer.step(
        "summary",
        f"Inserted {len(inserted)} citation(s); skipped {len(skipped)}",
        inserted=len(inserted),
        skipped=len(skipped),
    )

    return {
        "document_id": document_id,
        "inserted": inserted,
        "skipped": skipped,
        "considered": len(eligible),
        "total_blocks": len(blocks),
    }
