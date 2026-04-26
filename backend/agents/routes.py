from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import (
    add_comment,
    citation_inserter,
    ground_citation,
    insert_citation,
    literature_search,
    review_response,
    suggest_edit,
    summarize_selection,
)
from .store import RunStore, get_store
from .tracing import Tracer
from .types import (
    AgentRun,
    CreateRunRequest,
    RunEvent,
    RunStatus,
    TERMINAL_STATUS_VALUES,
    TERMINAL_STATUSES,
)

AgentFn = Callable[[dict[str, Any], Tracer], Awaitable[dict[str, Any]]]
AGENTS: dict[str, AgentFn] = {
    "literature_search": literature_search.run,
    "insert_citation": insert_citation.run,
    "add_comment": add_comment.run,
    "suggest_edit": suggest_edit.run,
    "summarize_selection": summarize_selection.run,
    "citation_inserter": citation_inserter.run,
    "ground_citation": ground_citation.run,
    "review_response": review_response.run,
}


class ListRunsResponse(BaseModel):
    runs: list[AgentRun]


class RunDetailResponse(BaseModel):
    run: AgentRun
    events: list[RunEvent]


class AgentInfo(BaseModel):
    name: str


class AgentsListResponse(BaseModel):
    agents: list[AgentInfo]


async def _execute(run: AgentRun, tracer: Tracer, store: RunStore) -> None:
    fn = AGENTS[run.agent]
    try:
        await tracer.status(RunStatus.running, "Running")
        result = await fn(run.input, tracer)
        run.result = result
        store.save(run)
        await tracer.status(RunStatus.succeeded, "Done")
    except asyncio.CancelledError:
        await tracer.status(RunStatus.cancelled, "Cancelled")
        raise
    except Exception as e:  # noqa: BLE001
        await tracer.error(str(e))
        await tracer.status(RunStatus.failed, "Failed")
    finally:
        store.save(run)
        ch = store.channel(run.id)
        if ch is not None:
            await ch.close()


async def _require_secret(
    x_anthill_secret: str | None = Header(default=None, alias="X-Anthill-Secret"),
) -> None:
    from main import get_settings

    expected = get_settings().shared_secret
    if not expected:
        return
    if not x_anthill_secret or x_anthill_secret != expected:
        raise HTTPException(
            status_code=401, detail="invalid or missing X-Anthill-Secret"
        )


router = APIRouter(
    prefix="/agents",
    tags=["agents"],
    dependencies=[Depends(_require_secret)],
)


@router.get("", response_model=AgentsListResponse)
async def list_agents() -> AgentsListResponse:
    return AgentsListResponse(agents=[AgentInfo(name=name) for name in sorted(AGENTS)])


@router.post("/runs", response_model=AgentRun)
async def create_run(
    req: CreateRunRequest,
    store: RunStore = Depends(get_store),
) -> AgentRun:
    if req.agent not in AGENTS:
        raise HTTPException(status_code=400, detail=f"unknown agent {req.agent!r}")

    run = AgentRun(agent=req.agent, input=req.input, document_id=req.document_id)
    store.create(run)
    tracer = Tracer(store, run)
    await tracer.log("Run queued")

    task = asyncio.create_task(_execute(run, tracer, store), name=f"agent-run:{run.id}")
    store.attach_task(run.id, task)
    return run


@router.get("/runs", response_model=ListRunsResponse)
async def list_runs(
    agent: str | None = None,
    document_id: str | None = None,
    limit: int = 50,
    store: RunStore = Depends(get_store),
) -> ListRunsResponse:
    return ListRunsResponse(
        runs=store.list(agent=agent, document_id=document_id, limit=limit)
    )


@router.get("/runs/{run_id}", response_model=RunDetailResponse)
async def get_run(run_id: str, store: RunStore = Depends(get_store)) -> RunDetailResponse:
    run = store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    return RunDetailResponse(run=run, events=store.events(run_id))


@router.post("/runs/{run_id}/cancel", response_model=AgentRun)
async def cancel_run(run_id: str, store: RunStore = Depends(get_store)) -> AgentRun:
    run = store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if run.status not in TERMINAL_STATUSES:
        await store.cancel(run_id)
    return run


def _sse(event: RunEvent) -> bytes:
    payload = event.model_dump(mode="json")
    return f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(payload)}\n\n".encode()


@router.get("/runs/{run_id}/events")
async def stream_events(
    run_id: str,
    request: Request,
    store: RunStore = Depends(get_store),
) -> StreamingResponse:
    run = store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    ch = store.channel(run_id)
    if ch is None:
        raise HTTPException(status_code=404, detail="run channel not found")

    queue = ch.subscribe()
    snapshot = list(ch.events)
    seen: set[int] = {ev.seq for ev in snapshot}

    async def gen() -> AsyncIterator[bytes]:
        try:
            for ev in snapshot:
                yield _sse(ev)

            if run.status in TERMINAL_STATUSES and ch.closed:
                return

            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                if ev is None:
                    break
                if ev.seq in seen:
                    continue
                seen.add(ev.seq)
                yield _sse(ev)
                if (
                    ev.kind == "status"
                    and ev.data
                    and ev.data.get("status") in TERMINAL_STATUS_VALUES
                ):
                    continue
        finally:
            ch.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
