"""Discover, fetch, and embed new arXiv papers on demand.

Mirrors the chunking + embedding contract used by `datasets/src/embed.py` so
papers added at runtime are indistinguishable from ones loaded by the bulk
ingest job. All blocking IO (arXiv API, PDF download, PDF parse, Harrier
embedding) is funneled through `asyncio.to_thread` so the event loop and any
peer SSE streams keep flowing.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from typing import Any

import arxiv
import fitz  # pymupdf
import numpy as np

CHUNK_SIZE = 512  # words per chunk
CHUNK_OVERLAP = 64  # words overlap


# ---------- chunking (kept identical to the bulk ingester) ----------


def _chunk_text_with_offsets(
    text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP
) -> list[tuple[str, int, int]]:
    words = text.split()
    if not words:
        return []

    word_offsets: list[int] = []
    cursor = 0
    for w in words:
        idx = text.find(w, cursor)
        if idx < 0:
            idx = cursor
        word_offsets.append(idx)
        cursor = idx + len(w)

    chunks: list[tuple[str, int, int]] = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk_words = words[start:end]
        char_start = word_offsets[start]
        last = end - 1
        char_end = word_offsets[last] + len(words[last])
        chunks.append((" ".join(chunk_words), char_start, char_end))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks


# ---------- arXiv discovery ----------


def _strip_version(arxiv_id: str) -> str:
    return arxiv_id.split("v")[0] if "v" in arxiv_id else arxiv_id


def _get_arxiv_id(result: arxiv.Result) -> str:
    return result.entry_id.split("/abs/")[-1]


def _search_arxiv(query: str, max_results: int) -> list[arxiv.Result]:
    """One blocking arXiv API call. Caller must run via to_thread."""
    client = arxiv.Client(page_size=min(max_results, 50), delay_seconds=3.0, num_retries=3)
    search = arxiv.Search(
        query=query,
        max_results=max_results,
        sort_by=arxiv.SortCriterion.Relevance,
    )
    return list(client.results(search))


# ---------- PDF download + extract ----------


def _download_and_extract(result: arxiv.Result, dirpath: str) -> tuple[str, str]:
    """Returns (pdf_path, full_text). Blocking; run via to_thread."""
    pdf_path = result.download_pdf(dirpath=dirpath)
    with fitz.open(pdf_path) as doc:
        text = "\n".join(page.get_text() for page in doc)
    return str(pdf_path), text


# ---------- public API used by the agent ----------


async def already_indexed(collection: Any, arxiv_id: str) -> bool:
    got = await asyncio.to_thread(collection.get, where={"arxiv_id": arxiv_id}, limit=1)
    return bool(got.get("ids"))


async def discover_candidates(query: str, max_results: int) -> list[arxiv.Result]:
    return await asyncio.to_thread(_search_arxiv, query, max_results)


async def ingest_paper(
    result: arxiv.Result,
    *,
    collection: Any,
    embed_fn,
    pdf_dir: str | None = None,
) -> dict[str, Any]:
    """Download, chunk, embed, and store one arXiv paper.

    Returns a small dict describing what landed in Chroma. Errors raise; the
    caller decides how to surface them (the agent emits an `error` event but
    keeps going on the next candidate).
    """
    arxiv_id = _get_arxiv_id(result)
    title = result.title

    use_dir = pdf_dir
    cleanup: tempfile.TemporaryDirectory | None = None
    if not use_dir:
        cleanup = tempfile.TemporaryDirectory(prefix="anthill-arxiv-")
        use_dir = cleanup.name

    try:
        pdf_path, text = await asyncio.to_thread(_download_and_extract, result, use_dir)
    finally:
        # Hold the temp dir open until we're done with the PDF; clean up on exit.
        pass

    try:
        chunks = _chunk_text_with_offsets(text)
        if not chunks:
            raise RuntimeError("no extractable text in PDF")

        # llama-cpp's batched embedding path errors on this model; one at a time.
        # The shared `_embed` from main already normalizes.
        rows = []
        for chunk_str, _, _ in chunks:
            row = await asyncio.to_thread(embed_fn, [chunk_str])
            rows.append(row)
        embeddings = np.concatenate(rows, axis=0)

        ids = [f"{arxiv_id}__chunk_{j}" for j in range(len(chunks))]
        documents = [c[0] for c in chunks]
        metadatas = [
            {
                "arxiv_id": arxiv_id,
                "title": title,
                "chunk_index": j,
                "char_start": c[1],
                "char_end": c[2],
                "ingested_at": time.time(),
                "source": "agent",
            }
            for j, c in enumerate(chunks)
        ]
        await asyncio.to_thread(
            collection.add,
            ids=ids,
            embeddings=embeddings.tolist(),
            documents=documents,
            metadatas=metadatas,
        )
    finally:
        if cleanup is not None:
            try:
                cleanup.cleanup()
            except Exception:
                pass
        # If the caller passed pdf_dir, leave the file on disk for them.
        _ = pdf_path

    return {
        "arxiv_id": arxiv_id,
        "title": title,
        "chunks": len(chunks),
        "chars": len(text),
    }


__all__ = [
    "already_indexed",
    "discover_candidates",
    "ingest_paper",
    "_get_arxiv_id",
    "_strip_version",
]
