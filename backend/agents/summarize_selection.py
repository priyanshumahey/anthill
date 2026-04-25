"""`summarizeSelection` tool — read-only LLM summary of one or more blocks.

Inputs:
  document_id: str   (from the run)
  block_refs:  list[str] — refs to summarize (default: all blocks)
  max_words:   int   (default 80)

Effect: pulls the document snapshot from the bridge, joins the referenced
blocks' text, and asks an LLM (OpenAI by default — same key the
literature_search agent already uses) for a short summary.

Read-only: no edit ops. Caller decides whether to feed the summary into
`addComment` or `suggestEdit`.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .bridge_client import BridgeError, get_client
from .tracing import Tracer

_AGENT_ID = "summarize_selection"


async def _summarize(text: str, max_words: int) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    fallback = _truncate_words(text, max_words)
    if not api_key:
        # No LLM configured — return a deterministic excerpt so the tool is
        # always usable in tests / offline runs.
        return fallback

    prompt = (
        f"Summarize the following passage in <= {max_words} words. "
        f"Keep the summary neutral and faithful to the original — no new "
        f"claims, no opinions.\n\nPassage:\n{text}"
    )
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": os.environ.get("ANTHILL_SUMMARY_MODEL", "gpt-4o-mini"),
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.2,
                },
            )
            resp.raise_for_status()
            return str(resp.json()["choices"][0]["message"]["content"]).strip()
    except Exception:
        return fallback


def _truncate_words(text: str, n: int) -> str:
    words = text.split()
    if len(words) <= n:
        return text
    return " ".join(words[:n]).rstrip(",.;:") + "…"


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    document_id = tracer.run.document_id or input.get("document_id")
    if not document_id:
        raise ValueError("`document_id` is required")

    requested_refs = input.get("block_refs") or []
    if requested_refs and not isinstance(requested_refs, list):
        raise ValueError("`block_refs` must be a list of refs")
    max_words = max(20, min(int(input.get("max_words") or 80), 400))

    client = get_client(agent_id=_AGENT_ID, run_id=tracer.run.id)
    try:
        snapshot = await client.snapshot(document_id)
    except BridgeError as e:
        await tracer.error(f"bridge snapshot failed: {e}")
        raise

    blocks = snapshot.get("blocks") or []
    if not blocks:
        await tracer.log("Document has no blocks")
        return {"summary": "", "block_refs": [], "chars": 0}

    by_ref = {b["ref"]: b for b in blocks if isinstance(b, dict) and "ref" in b}
    if requested_refs:
        picked = [by_ref[r] for r in requested_refs if r in by_ref]
        missing = [r for r in requested_refs if r not in by_ref]
        if missing:
            await tracer.log(f"Skipping unknown refs: {', '.join(missing)}")
    else:
        picked = blocks

    text = "\n\n".join((b.get("text") or "").strip() for b in picked).strip()
    if not text:
        await tracer.log("Selected blocks contain no text")
        return {"summary": "", "block_refs": [b["ref"] for b in picked], "chars": 0}

    await tracer.step(
        "summarize",
        f"Summarizing {len(picked)} block(s), {len(text)} chars",
        block_refs=[b["ref"] for b in picked],
    )
    summary = await _summarize(text, max_words)
    await tracer.step("summary_done", "Summary ready", words=len(summary.split()))

    return {
        "summary": summary,
        "block_refs": [b["ref"] for b in picked],
        "chars": len(text),
    }
