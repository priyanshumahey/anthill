from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    limit: int = Field(10, ge=1, le=100)


class Paper(BaseModel):
    id: str
    title: str
    abstract: str | None = None
    score: float | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[Paper]


class HealthResponse(BaseModel):
    status: str
    version: str


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Place to initialize chroma client, models, etc. later.
    yield


app = FastAPI(title="Anthill API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=app.version)


@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    # Placeholder: wire up chroma_db / embeddings here.
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="empty query")
    sample = [
        Paper(
            id=f"sample-{i}",
            title=f"Result {i} for {req.query!r}",
            abstract="Replace this with real semantic search results.",
            score=1.0 - i * 0.1,
        )
        for i in range(min(req.limit, 3))
    ]
    return SearchResponse(query=req.query, results=sample)


@app.get("/papers/{paper_id}", response_model=Paper)
async def get_paper(paper_id: str) -> Paper:
    return Paper(id=paper_id, title=f"Paper {paper_id}", abstract=None)


def main() -> None:
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)


if __name__ == "__main__":
    main()
