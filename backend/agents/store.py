from __future__ import annotations

import asyncio
from collections import deque

from .types import AgentRun, RunEvent


class RunChannel:
    """Per-run ring buffer of past events plus a fan-out to live subscribers.

    `emit` is the only writer; it assigns the sequence number, appends to the
    buffer, and pushes to every subscribed queue. Subscribers receive `None`
    after `close()` so they know the stream is over.
    """

    def __init__(self, max_events: int = 2048) -> None:
        self.events: deque[RunEvent] = deque(maxlen=max_events)
        self._subscribers: set[asyncio.Queue[RunEvent | None]] = set()
        self._next_seq = 0
        self._lock = asyncio.Lock()
        self._closed = False

    async def emit(self, event: RunEvent) -> RunEvent:
        async with self._lock:
            event.seq = self._next_seq
            self._next_seq += 1
            self.events.append(event)
            for q in list(self._subscribers):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    # Slow subscriber — drop. They can re-fetch via the snapshot.
                    pass
        return event

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            for q in list(self._subscribers):
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    pass

    @property
    def closed(self) -> bool:
        return self._closed

    def subscribe(self) -> asyncio.Queue[RunEvent | None]:
        q: asyncio.Queue[RunEvent | None] = asyncio.Queue(maxsize=512)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[RunEvent | None]) -> None:
        self._subscribers.discard(q)


class RunStore:
    """In-process registry of runs + their channels + their asyncio tasks.

    This is intentionally simple. When we need cross-process visibility (or
    survival across restarts) we'll back it with Postgres. The interface stays
    the same.
    """

    def __init__(self) -> None:
        self.runs: dict[str, AgentRun] = {}
        self.channels: dict[str, RunChannel] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}

    def create(self, run: AgentRun) -> AgentRun:
        self.runs[run.id] = run
        self.channels[run.id] = RunChannel()
        return run

    def get(self, run_id: str) -> AgentRun | None:
        return self.runs.get(run_id)

    def list(
        self,
        *,
        agent: str | None = None,
        document_id: str | None = None,
        limit: int = 50,
    ) -> list[AgentRun]:
        items = list(self.runs.values())
        if agent:
            items = [r for r in items if r.agent == agent]
        if document_id:
            items = [r for r in items if r.document_id == document_id]
        items.sort(key=lambda r: r.created_at, reverse=True)
        return items[:limit]

    def channel(self, run_id: str) -> RunChannel | None:
        return self.channels.get(run_id)

    def events(self, run_id: str) -> list[RunEvent]:
        ch = self.channels.get(run_id)
        return list(ch.events) if ch else []

    def attach_task(self, run_id: str, task: asyncio.Task[None]) -> None:
        self.tasks[run_id] = task

    async def cancel(self, run_id: str) -> bool:
        task = self.tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            return True
        return False


_store: RunStore | None = None


def get_store() -> RunStore:
    global _store
    if _store is None:
        _store = RunStore()
    return _store
