"""Literature search agent.

Given a topic, plans a few sub-queries (LLM-expanded if `OPENAI_API_KEY` is
set, otherwise just the raw query), optionally discovers + ingests new arXiv
papers into the corpus, then runs each sub-query through the local Harrier +
Chroma corpus, dedupes per `arxiv_id`, ranks by best chunk score, and emits
findings as it goes so the UI can stream them.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from . import ingest
from .tracing import Tracer

_QUERY_INSTRUCTION = (
    "Instruct: Given a scientific query, retrieve relevant paper passages\n"
    "Query: "
)

_DEFAULT_K_PER_QUERY = 8
_DEFAULT_MAX_RESULTS = 12
_MAX_SUB_QUERIES = 5
_DEFAULT_DISCOVER_MAX = 5
_HARD_DISCOVER_CAP = 15


async def _expand_queries(query: str, n: int) -> list[str]:
    """Use OpenAI to fan the topic out into distinct sub-queries.

    Falls back to `[query]` if no key is configured or the call fails — the
    agent still works, just with one search pass.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return [query]

    prompt = (
        f"You are helping a researcher write a paper. Given the topic below, "
        f"propose {n} short, distinct search queries (5-10 words each) that "
        f"cover different angles of the topic. Return one query per line, "
        f"with no numbering, bullets, or extra prose.\n\n"
        f"Topic: {query}"
    )

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": os.environ.get("ANTHILL_PLAN_MODEL", "gpt-4o-mini"),
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.4,
                },
            )
            resp.raise_for_status()
            text = resp.json()["choices"][0]["message"]["content"]
    except Exception:
        return [query]

    lines = [ln.strip(" -*\t•").strip() for ln in text.splitlines() if ln.strip()]
    candidates = [query, *lines]

    seen: set[str] = set()
    out: list[str] = []
    for q in candidates:
        key = q.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(q)
    return out[: n + 1]


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    # Imported lazily so this module does not depend on `main` at import time
    # (main mounts our router during its own initialization).
    from main import _embed, _get_collection  # type: ignore[import-not-found]

    query = str(input.get("query") or "").strip()
    if not query:
        raise ValueError("`query` is required")

    k_per_query = max(1, min(int(input.get("k_per_query") or _DEFAULT_K_PER_QUERY), 25))
    max_results = max(1, min(int(input.get("max_results") or _DEFAULT_MAX_RESULTS), 50))
    expand = bool(input.get("expand", True))
    plan_n = max(1, min(int(input.get("plan_n") or 4), _MAX_SUB_QUERIES))
    discover = bool(input.get("discover", True))
    discover_max = max(
        0, min(int(input.get("discover_max") or _DEFAULT_DISCOVER_MAX), _HARD_DISCOVER_CAP)
    )
    discover_query = str(input.get("discover_query") or query).strip()

    # Step 1 — plan
    await tracer.step("plan", f"Planning sub-queries for: {query}", expand=expand)
    sub_queries = await _expand_queries(query, plan_n) if expand else [query]
    await tracer.step(
        "plan_done",
        f"Using {len(sub_queries)} sub-quer{'y' if len(sub_queries) == 1 else 'ies'}",
        queries=sub_queries,
    )

    collection = await asyncio.to_thread(_get_collection)

    # Step 2 — discover + ingest new papers from arXiv (optional)
    newly_indexed: set[str] = set()
    ingested_papers: list[dict[str, Any]] = []
    if discover and discover_max > 0:
        await tracer.step(
            "discover",
            f"Searching arXiv for up to {discover_max} new paper{'' if discover_max == 1 else 's'}",
            arxiv_query=discover_query,
            max=discover_max,
        )
        try:
            # Pull a few extras so dedupe doesn't starve us.
            candidates = await ingest.discover_candidates(
                discover_query, max_results=discover_max * 3
            )
        except Exception as e:  # noqa: BLE001
            await tracer.error(f"arXiv discovery failed: {e}")
            candidates = []

        await tracer.step(
            "discover_candidates",
            f"arXiv returned {len(candidates)} candidate{'s' if len(candidates) != 1 else ''}",
            count=len(candidates),
        )

        added = 0
        seen_in_run: set[str] = set()
        for cand in candidates:
            if added >= discover_max:
                break
            arxiv_id = ingest._get_arxiv_id(cand)
            if arxiv_id in seen_in_run:
                continue
            seen_in_run.add(arxiv_id)

            if await ingest.already_indexed(collection, arxiv_id):
                await tracer.step(
                    "discover_skip",
                    f"Already in corpus: {arxiv_id}",
                    arxiv_id=arxiv_id,
                    title=cand.title,
                )
                continue

            await tracer.step(
                "discover_ingest",
                f"Ingesting {arxiv_id}: {cand.title}",
                arxiv_id=arxiv_id,
                title=cand.title,
            )
            t0 = time.time()
            try:
                info = await ingest.ingest_paper(
                    cand, collection=collection, embed_fn=_embed
                )
            except Exception as e:  # noqa: BLE001
                await tracer.error(f"ingest {arxiv_id} failed: {e}")
                continue

            added += 1
            newly_indexed.add(arxiv_id)
            ingested_papers.append(info)
            await tracer.step(
                "discover_done",
                f"Indexed {arxiv_id} ({info['chunks']} chunks)",
                arxiv_id=arxiv_id,
                chunks=info["chunks"],
                chars=info["chars"],
                took_ms=int((time.time() - t0) * 1000),
            )

        await tracer.step(
            "discover_summary",
            f"Added {added} new paper{'s' if added != 1 else ''} to the corpus",
            added=added,
            total_corpus=await asyncio.to_thread(collection.count),
        )

    total = await asyncio.to_thread(collection.count)
    if total == 0:
        await tracer.log("Corpus is empty; nothing to search")
        return {
            "query": query,
            "sub_queries": sub_queries,
            "papers": [],
            "newly_indexed": list(newly_indexed),
            "ingested": ingested_papers,
        }

    # Step 3 — search each sub-query
    by_arxiv: dict[str, dict[str, Any]] = {}
    for sq in sub_queries:
        await tracer.step("search", f"Searching: {sq}", query=sq)
        t0 = time.time()
        emb = await asyncio.to_thread(_embed, [_QUERY_INSTRUCTION + sq])
        res = await asyncio.to_thread(
            collection.query,
            query_embeddings=emb.tolist(),
            n_results=k_per_query,
        )
        ids = (res.get("ids") or [[]])[0]
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]

        n_new = 0
        for doc_id, doc, meta, dist in zip(ids, docs, metas, dists):
            meta = meta or {}
            arxiv_id = str(meta.get("arxiv_id") or doc_id.split("__chunk_")[0])
            score = float(1.0 - dist)
            existing = by_arxiv.get(arxiv_id)
            hit = {
                "arxiv_id": arxiv_id,
                "title": meta.get("title"),
                "chunk_index": int(meta.get("chunk_index", 0)),
                "text": doc or "",
                "score": score,
                "matched_query": sq,
                "newly_indexed": arxiv_id in newly_indexed,
            }
            if existing is None:
                by_arxiv[arxiv_id] = hit
                n_new += 1
            elif score > existing["score"]:
                by_arxiv[arxiv_id] = hit

        await tracer.step(
            "search_done",
            f"{len(ids)} hits, {n_new} new paper{'s' if n_new != 1 else ''}",
            query=sq,
            took_ms=int((time.time() - t0) * 1000),
            new_papers=n_new,
            total_unique=len(by_arxiv),
        )

    # Step 4 — rank & truncate
    ranked = sorted(by_arxiv.values(), key=lambda h: h["score"], reverse=True)[:max_results]
    await tracer.step("rank", f"Ranked {len(ranked)} candidate papers", count=len(ranked))

    # Stream findings one-by-one so the UI can populate as they arrive.
    for rank, hit in enumerate(ranked, start=1):
        await tracer.finding(rank=rank, **hit)

    return {
        "query": query,
        "sub_queries": sub_queries,
        "papers": ranked,
        "newly_indexed": list(newly_indexed),
        "ingested": ingested_papers,
    }
