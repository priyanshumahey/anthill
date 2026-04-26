"""`groundCitation` agent — verify a writer's claim against a real paper via Nia.

Workflow:
  1. Look up (or create) a Nia source for the arXiv id, with a SQLite cache so
     repeat lookups are free.
  2. Ask Nia's document agent — using a strict JSON schema — whether the
     paper actually supports the writer's paragraph, and to return the exact
     supporting quote with page + section.
  3. Surface that as a `finding` event the editor can show in the citation
     popover, and as the run result the front-end consumes.

Why this is the right Nia integration:
  - Uses *structured output* (json_schema) so we get a typed verdict, not
    prose to regex.
  - Uses *page + section citations* — that's the thing local Chroma can't do.
  - Falls back gracefully when Nia hasn't finished indexing yet
    (NiaSourceNotReady), so the UI can offer "we'll verify this later".
"""

from __future__ import annotations

import time
from typing import Any

from .nia_cache import get_cache
from .nia_client import (
    NiaAnswer,
    NiaCitation,
    NiaClient,
    NiaError,
    NiaSourceNotReady,
)
from .tracing import Tracer

# JSON schema fed to Nia's document agent. Keep it strict so the agent has to
# answer the verification question rather than waxing on.
GROUND_CITATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "supports_claim": {
            "type": "boolean",
            "description": (
                "True if the cited paper directly supports the writer's claim. "
                "False if the paper is unrelated, contradicts the claim, or only "
                "tangentially mentions the topic without backing the specific assertion."
            ),
        },
        "exact_quote": {
            "type": "string",
            "description": (
                "The single most-relevant verbatim sentence from the paper that "
                "supports (or contradicts) the claim. Must be copy-pasted from "
                "the source — do not paraphrase. Empty string if no good quote exists."
            ),
        },
        "page_number": {
            "type": ["integer", "null"],
            "description": "Page number where exact_quote appears in the PDF.",
        },
        "section_path": {
            "type": ["string", "null"],
            "description": "Section breadcrumb (e.g. 'Methods > Architecture').",
        },
        "confidence": {
            "type": "number",
            "minimum": 0.0,
            "maximum": 1.0,
            "description": "0.0 = no support; 1.0 = paper directly states the claim.",
        },
        "rationale": {
            "type": "string",
            "description": "One-sentence explanation of the verdict for the writer.",
        },
    },
    "required": [
        "supports_claim",
        "exact_quote",
        "confidence",
        "rationale",
    ],
}


def _build_question(claim: str) -> str:
    return (
        "A researcher wants to cite this paper to support the following claim "
        "in their own writing:\n\n"
        f'CLAIM: """\n{claim.strip()}\n"""\n\n'
        "Read the paper and verify whether it actually supports this claim. "
        "Return a single verbatim quote that most directly supports (or "
        "contradicts) the claim, with its page number and section path. "
        "If the paper is unrelated to the claim, set supports_claim=false and "
        "confidence=0."
    )


def _citations_to_dict(citations: list[NiaCitation]) -> list[dict[str, Any]]:
    return [
        {
            "page_number": c.page_number,
            "section_path": c.section_path,
            "section_title": c.section_title,
            "content": c.content,
            "tool_source": c.tool_source,
        }
        for c in citations
    ]


async def run(input: dict[str, Any], tracer: Tracer) -> dict[str, Any]:
    arxiv_id = str(input.get("arxiv_id") or "").strip()
    claim = str(input.get("claim") or input.get("paragraph_text") or "").strip()
    if not arxiv_id:
        raise ValueError("`arxiv_id` is required")
    if not claim:
        raise ValueError("`claim` (or `paragraph_text`) is required")

    cache = get_cache()
    cached = cache.get(arxiv_id)

    async with NiaClient() as nia:
        # Step 1: ensure Nia has the paper, with cache short-circuit.
        if cached:
            await tracer.step(
                "nia_cache_hit",
                f"Reusing cached Nia source for arXiv:{arxiv_id}",
                source_id=cached["source_id"],
                cached_status=cached["status"],
            )
            source_id = cached["source_id"]
            try:
                src = await nia.get_source(source_id)
            except NiaError:
                # Cache stale — fall through to ensure_source.
                await tracer.log("Cached source missing on Nia; re-indexing")
                src = await nia.ensure_source(arxiv_id)
                cache.put(arxiv_id, src.id, src.status)
            else:
                cache.update_status(arxiv_id, src.status)
        else:
            await tracer.step(
                "nia_index",
                f"Asking Nia for arXiv:{arxiv_id} (will dedup against global namespace)",
            )
            src = await nia.ensure_source(arxiv_id)
            cache.put(arxiv_id, src.id, src.status)
            await tracer.step(
                "nia_indexed",
                f"Nia source ready: {src.display_name!r}",
                source_id=src.id,
                status=src.status,
            )

        # Step 2: verify the claim via the document agent with structured output.
        await tracer.step(
            "nia_query",
            "Asking Nia's document agent to verify the claim against the paper",
            model=nia.model,
            schema_keys=list(GROUND_CITATION_SCHEMA["properties"].keys()),
        )
        t0 = time.time()
        try:
            answer: NiaAnswer = await nia.query_document(
                src.id,
                _build_question(claim),
                json_schema=GROUND_CITATION_SCHEMA,
            )
        except NiaSourceNotReady as e:
            # `e.args[0]` is Nia's own rationale when the model couldn't read
            # the doc; fall back to the canned message otherwise.
            detail = (e.args[0] if e.args else "") or (
                f"Nia source {e.source_id} not ready (status={e.status!r})"
            )
            await tracer.step(
                "nia_not_ready",
                detail,
                source_id=e.source_id,
                status=e.status,
                rationale=detail,
            )
            return {
                "ok": False,
                "reason": "source_not_ready",
                "source_id": e.source_id,
                "status": e.status,
                "rationale": detail,
                "arxiv_id": arxiv_id,
                "retry_after_s": 60,
            }

        elapsed_ms = int((time.time() - t0) * 1000)

    verdict = answer.structured_output or {}
    supports = bool(verdict.get("supports_claim"))
    confidence = float(verdict.get("confidence") or 0.0)
    quote = str(verdict.get("exact_quote") or "").strip()
    page = verdict.get("page_number")
    section = verdict.get("section_path")
    rationale = str(verdict.get("rationale") or "").strip()

    # The headline event the editor will render in the popover.
    await tracer.finding(
        kind="grounded_citation",
        arxiv_id=arxiv_id,
        supports_claim=supports,
        confidence=confidence,
        page_number=page,
        section_path=section,
        exact_quote=quote,
        rationale=rationale,
        nia_took_ms=elapsed_ms,
    )

    return {
        "ok": True,
        "arxiv_id": arxiv_id,
        "source_id": src.id,
        "supports_claim": supports,
        "confidence": confidence,
        "exact_quote": quote,
        "page_number": page,
        "section_path": section,
        "rationale": rationale,
        "answer_summary": answer.answer,
        "citations": _citations_to_dict(answer.citations),
        "model": answer.model,
        "usage": answer.usage,
        "nia_took_ms": elapsed_ms,
    }
