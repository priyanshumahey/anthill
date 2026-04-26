"""Typed async wrapper around the Nia v2 API.

Scope (sprint 1): just the three endpoints we actually need for citation
grounding and metadata extraction. We deliberately avoid wrapping the whole
surface — Nia's API moves; keep the surface area small and explicit.

Endpoints used:
  - GET  /v2/sources              (dedup before creating)
  - POST /v2/sources              (type=research_paper)
  - POST /v2/document/agent       (cited Q&A, optional structured output)

Important quirks observed against the live API (April 2026):

  * Default model `claude-opus-4-7` 502s on Nia's side with
    "temperature is deprecated for this model". Use sonnet.
  * The haiku model name in the docs (claude-haiku-35-20241022) returns 404.
  * `document/agent` happily accepts a source_id whose status is still
    `processing`, but the agent then returns 0 citations and hallucinates.
    We raise `NiaSourceNotReady` in that case so callers can fall back to
    local Chroma instead of silently surfacing ungrounded text.
  * `POST /sources` always creates a NEW per-user row even when Nia already
    has the paper in its global namespace. Always dedup via GET first.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

# Load backend/.env into os.environ on first import so NIA_* keys are visible
# even when the FastAPI process was started without them in the shell. We
# only set values that aren't already in os.environ — explicit env wins.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if _ENV_FILE.is_file():
    for _line in _ENV_FILE.read_text().splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

NIA_BASE_URL = os.environ.get("NIA_BASE_URL", "https://apigcp.trynia.ai/v2")
NIA_DEFAULT_MODEL = os.environ.get("NIA_MODEL", "claude-sonnet-4-20250514")


class NiaError(RuntimeError):
    """Generic Nia API failure."""


class NiaSourceNotReady(NiaError):
    """The source is still indexing; the agent answer is not yet grounded."""

    def __init__(self, source_id: str, status: str | None) -> None:
        super().__init__(f"Nia source {source_id} not ready (status={status!r})")
        self.source_id = source_id
        self.status = status


@dataclass(frozen=True)
class NiaSource:
    id: str
    arxiv_id: str
    status: str  # "processing" | "indexed" | "completed" | ...
    display_name: str | None
    global_source_id: str | None


@dataclass(frozen=True)
class NiaCitation:
    page_number: int | None
    section_path: str | None
    section_title: str | None
    content: str
    tool_source: str | None


@dataclass(frozen=True)
class NiaAnswer:
    answer: str
    citations: list[NiaCitation]
    structured_output: dict[str, Any] | None
    model: str
    usage: dict[str, Any]


def _arxiv_url(arxiv_id: str) -> str:
    return f"https://arxiv.org/abs/{arxiv_id}"


def _from_source_dict(arxiv_id: str, raw: dict[str, Any]) -> NiaSource:
    return NiaSource(
        id=str(raw["id"]),
        arxiv_id=arxiv_id,
        status=str(raw.get("status") or "unknown"),
        display_name=raw.get("display_name"),
        global_source_id=raw.get("global_source_id"),
    )


class NiaClient:
    """Thin async wrapper. Constructed per request; cheap to make.

    Pass an explicit `httpx.AsyncClient` to share connection pooling across
    parallel calls (e.g. literature-review fan-out).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = NIA_BASE_URL,
        model: str = NIA_DEFAULT_MODEL,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("NIA_API_KEY", "")
        if not self.api_key:
            raise NiaError("NIA_API_KEY not set")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "NiaClient":
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            raise NiaError("NiaClient used outside of async context")
        return self._client

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # --- sources --------------------------------------------------------

    async def find_source(self, arxiv_id: str) -> NiaSource | None:
        """Return the most-recently-created source for this arXiv id, or None."""
        target = _arxiv_url(arxiv_id)
        r = await self._http.get(
            f"{self.base_url}/sources",
            headers=self._headers(),
            params={"limit": 100},
            timeout=20.0,
        )
        if r.status_code >= 400:
            raise NiaError(f"GET /sources [{r.status_code}]: {r.text}")
        items = r.json().get("items") or []
        matches = [s for s in items if s.get("identifier") == target]
        if not matches:
            return None
        matches.sort(key=lambda s: s.get("created_at") or "", reverse=True)
        return _from_source_dict(arxiv_id, matches[0])

    async def index_paper(self, arxiv_id: str) -> NiaSource:
        """Create a Nia source for an arXiv paper. Does NOT dedup — use ensure_source."""
        r = await self._http.post(
            f"{self.base_url}/sources",
            headers=self._headers(),
            json={"type": "research_paper", "url": _arxiv_url(arxiv_id)},
            timeout=60.0,
        )
        if r.status_code >= 400:
            raise NiaError(f"POST /sources [{r.status_code}]: {r.text}")
        return _from_source_dict(arxiv_id, r.json())

    async def ensure_source(self, arxiv_id: str) -> NiaSource:
        """Idempotent: reuse existing source for arxiv_id, otherwise create one."""
        existing = await self.find_source(arxiv_id)
        if existing is not None:
            return existing
        return await self.index_paper(arxiv_id)

    async def get_source(self, source_id: str) -> NiaSource:
        r = await self._http.get(
            f"{self.base_url}/sources/{source_id}",
            headers=self._headers(),
            timeout=20.0,
        )
        if r.status_code >= 400:
            raise NiaError(f"GET /sources/{source_id} [{r.status_code}]: {r.text}")
        raw = r.json()
        ident = raw.get("identifier") or ""
        arxiv_id = ident.rsplit("/", 1)[-1] if "arxiv.org/abs/" in ident else ""
        return _from_source_dict(arxiv_id, raw)

    # --- document agent -------------------------------------------------

    async def query_document(
        self,
        source_id: str,
        question: str,
        *,
        json_schema: dict[str, Any] | None = None,
        thinking: bool = False,
        thinking_budget: int = 8000,
        timeout_s: float = 300.0,
    ) -> NiaAnswer:
        """Run the Nia document agent over a single source.

        Raises NiaSourceNotReady when the response shows the document was
        not actually accessible — detected by combining two signals:
          * empty `citations` AND
          * either no structured_output, or one whose confidence is 0 and
            whose `exact_quote` is empty (i.e. the model is admitting it
            couldn't read the doc).

        With `json_schema`, Nia's agent often returns 0 citations even when
        the document IS accessible — so the structured verdict is the more
        reliable readiness signal.
        """
        body: dict[str, Any] = {
            "source_id": source_id,
            "query": question,
            "model": self.model,
            "thinking_enabled": bool(thinking),
            "stream": False,
        }
        if thinking:
            body["thinking_budget"] = int(thinking_budget)
        if json_schema is not None:
            body["json_schema"] = json_schema

        r = await self._http.post(
            f"{self.base_url}/document/agent",
            headers=self._headers(),
            json=body,
            timeout=timeout_s,
        )
        if r.status_code >= 400:
            raise NiaError(f"POST /document/agent [{r.status_code}]: {r.text}")
        raw = r.json()

        citations = [
            NiaCitation(
                page_number=c.get("page_number"),
                section_path=(
                    " > ".join(c["section_path"])
                    if isinstance(c.get("section_path"), list)
                    else c.get("section_path")
                ),
                section_title=c.get("section_title"),
                content=str(c.get("content") or ""),
                tool_source=c.get("tool_source"),
            )
            for c in (raw.get("citations") or [])
        ]
        structured = raw.get("structured_output")

        # A "real" verdict either:
        #  - cites the document directly (citations[] non-empty), OR
        #  - provides a verbatim quote, OR
        #  - has confidence > 0 in the structured response.
        # Anything else (empty citations + confidence 0 + no quote) means the
        # model couldn't actually access the paper — i.e. still indexing.
        struct_dict = structured if isinstance(structured, dict) else {}
        quote = str(struct_dict.get("exact_quote") or "").strip()
        try:
            confidence = float(struct_dict.get("confidence") or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0

        if not citations and not quote and confidence <= 0.0:
            try:
                src = await self.get_source(source_id)
                live_status = src.status
            except Exception:
                live_status = None

            rationale = str(struct_dict.get("rationale") or "").strip()
            err = NiaSourceNotReady(source_id, live_status)
            if rationale:
                # Surface Nia's own explanation to the UI.
                err.args = (rationale,)
            raise err

        return NiaAnswer(
            answer=str(raw.get("answer") or ""),
            citations=citations,
            structured_output=structured,
            model=str(raw.get("model") or self.model),
            usage=dict(raw.get("usage") or {}),
        )


__all__ = [
    "NiaAnswer",
    "NiaCitation",
    "NiaClient",
    "NiaError",
    "NiaSource",
    "NiaSourceNotReady",
    "NIA_BASE_URL",
    "NIA_DEFAULT_MODEL",
]
