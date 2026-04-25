from __future__ import annotations

import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


_BACKEND_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BACKEND_DIR.parent
_DATASETS_DIR = _REPO_ROOT / "datasets"

_QUERY_INSTRUCTION = (
    "Instruct: Given a scientific query, retrieve relevant paper passages\n"
    "Query: "
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_BACKEND_DIR / ".env",
        env_prefix="ANTHILL_",
        extra="ignore",
    )

    model_path: Path = _DATASETS_DIR / "models" / "harrier-oss-v1-270M-Q8_0.gguf"
    chroma_dir: Path = _DATASETS_DIR / "chroma_db"
    collection_name: str = "papers"

    shared_secret: str = ""
    allowed_origins: list[str] = ["http://localhost:3000"]

    default_k: int = 8
    max_k: int = 50

    n_ctx: int = 0
    n_batch: int = 2048
    n_ubatch: int = 2048
    n_gpu_layers: int = -1


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def _get_model():
    from llama_cpp import Llama

    settings = get_settings()
    if not settings.model_path.is_file():
        raise RuntimeError(f"Harrier model not found at {settings.model_path}")
    t0 = time.time()
    model = Llama(
        model_path=str(settings.model_path),
        embedding=True,
        n_ctx=settings.n_ctx,
        n_batch=settings.n_batch,
        n_ubatch=settings.n_ubatch,
        n_gpu_layers=settings.n_gpu_layers,
        verbose=False,
    )
    print(f"[anthill] Harrier loaded in {time.time() - t0:.1f}s")
    return model


@lru_cache
def _get_collection():
    import chromadb

    settings = get_settings()
    if not settings.chroma_dir.is_dir():
        raise RuntimeError(f"Chroma dir not found at {settings.chroma_dir}")
    client = chromadb.PersistentClient(path=str(settings.chroma_dir))
    return client.get_or_create_collection(
        name=settings.collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def _embed(texts: list[str]) -> np.ndarray:
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    model = _get_model()
    rows: list[np.ndarray] = []
    for t in texts:
        out = model.create_embedding(t)
        rows.append(np.asarray(out["data"][0]["embedding"], dtype=np.float32))
    arr = np.vstack(rows)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def require_secret(
    x_anthill_secret: str | None = Header(default=None, alias="X-Anthill-Secret"),
) -> None:
    expected = get_settings().shared_secret
    if not expected:
        return
    if not x_anthill_secret or x_anthill_secret != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-Anthill-Secret",
        )


class HealthResponse(BaseModel):
    status: str
    version: str
    collection: str
    chunks: int
    model_loaded: bool


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=128)


class EmbedResponse(BaseModel):
    dim: int
    embeddings: list[list[float]]


class SearchHit(BaseModel):
    arxiv_id: str
    chunk_index: int
    text: str
    score: float
    title: str | None = None
    char_start: int | None = None
    char_end: int | None = None


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    k: int | None = Field(default=None, ge=1, le=200)
    arxiv_ids: list[str] | None = None


class SearchResponse(BaseModel):
    query: str
    hits: list[SearchHit]
    took_ms: int


class PaperChunk(BaseModel):
    index: int
    text: str
    char_start: int | None = None
    char_end: int | None = None


class PaperResponse(BaseModel):
    arxiv_id: str
    title: str | None
    chunks: list[PaperChunk]


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        _get_collection()
    except Exception as e:
        print(f"[anthill] collection unavailable at startup: {e}")

    import asyncio

    async def _warm() -> None:
        try:
            await asyncio.to_thread(_get_model)
            await asyncio.to_thread(_embed, ["warmup"])
            print("[anthill] Harrier warmup complete")
        except Exception as e:
            print(f"[anthill] Harrier preload failed: {e}")

    warm_task = asyncio.create_task(_warm())
    try:
        yield
    finally:
        warm_task.cancel()


app = FastAPI(title="Anthill API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    settings = get_settings()
    chunks = 0
    try:
        chunks = _get_collection().count()
    except Exception:
        pass
    return HealthResponse(
        status="ok",
        version=app.version,
        collection=settings.collection_name,
        chunks=chunks,
        model_loaded=_get_model.cache_info().currsize > 0,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return await healthz()


@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(require_secret)])
async def embed(req: EmbedRequest) -> EmbedResponse:
    arr = _embed(req.texts)
    return EmbedResponse(dim=int(arr.shape[1]), embeddings=arr.tolist())


@app.post("/search", response_model=SearchResponse, dependencies=[Depends(require_secret)])
async def search(req: SearchRequest) -> SearchResponse:
    settings = get_settings()
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="empty query")
    k = min(req.k or settings.default_k, settings.max_k)

    collection = _get_collection()
    if collection.count() == 0:
        return SearchResponse(query=req.query, hits=[], took_ms=0)

    t0 = time.time()
    query_emb = _embed([_QUERY_INSTRUCTION + req.query])

    where: dict[str, Any] | None = None
    if req.arxiv_ids:
        where = {"arxiv_id": {"$in": list(req.arxiv_ids)}}

    res = collection.query(
        query_embeddings=query_emb.tolist(),
        n_results=k,
        where=where,
    )

    hits: list[SearchHit] = []
    ids = (res.get("ids") or [[]])[0]
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists = (res.get("distances") or [[]])[0]
    for doc_id, doc, meta, dist in zip(ids, docs, metas, dists):
        meta = meta or {}
        hits.append(
            SearchHit(
                arxiv_id=str(meta.get("arxiv_id") or doc_id.split("__chunk_")[0]),
                chunk_index=int(meta.get("chunk_index", 0)),
                text=doc or "",
                score=float(1.0 - dist),
                title=meta.get("title"),
                char_start=meta.get("char_start"),
                char_end=meta.get("char_end"),
            )
        )

    return SearchResponse(
        query=req.query,
        hits=hits,
        took_ms=int((time.time() - t0) * 1000),
    )


@app.get(
    "/papers/{arxiv_id}",
    response_model=PaperResponse,
    dependencies=[Depends(require_secret)],
)
async def get_paper(arxiv_id: str) -> PaperResponse:
    collection = _get_collection()
    got = collection.get(where={"arxiv_id": arxiv_id})
    if not got.get("ids"):
        raise HTTPException(status_code=404, detail=f"unknown arxiv_id {arxiv_id!r}")
    docs = got.get("documents") or []
    metas = got.get("metadatas") or []

    title: str | None = None
    chunks: list[PaperChunk] = []
    for doc, meta in zip(docs, metas):
        meta = meta or {}
        title = title or meta.get("title")
        chunks.append(
            PaperChunk(
                index=int(meta.get("chunk_index", 0)),
                text=doc or "",
                char_start=meta.get("char_start"),
                char_end=meta.get("char_end"),
            )
        )
    chunks.sort(key=lambda c: c.index)
    return PaperResponse(arxiv_id=arxiv_id, title=title, chunks=chunks)


# Mount the agent runtime. Done after `require_secret` is defined so the
# routes module can pull it in without a circular import.
from agents.routes import router as agents_router  # noqa: E402

app.include_router(agents_router)


def main() -> None:
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)


if __name__ == "__main__":
    main()
