from __future__ import annotations

import asyncio
import json
import os
import tempfile
from collections import deque
from pathlib import Path

from .types import AgentRun, RunEvent


_RUNS_DIR = Path(
    os.environ.get("ANTHILL_RUNS_DIR")
    or (Path(__file__).resolve().parent.parent / ".runs")
)
_RUNS_DIR.mkdir(parents=True, exist_ok=True)

# How many events to keep in memory per run. Disk has the full log; this
# is just the live-replay buffer for SSE subscribers.
_MAX_EVENTS_IN_MEMORY = 2048


def _run_path(run_id: str) -> Path:
    return _RUNS_DIR / f"{run_id}.json"


def _events_path(run_id: str) -> Path:
    return _RUNS_DIR / f"{run_id}.events.jsonl"


def _atomic_write(path: Path, data: str) -> None:
    """Write+rename so a crash mid-write doesn't leave a half file."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w",
        dir=str(path.parent),
        delete=False,
        suffix=".tmp",
        encoding="utf-8",
    )
    try:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


class RunChannel:
    def __init__(self, run_id: str, max_events: int = _MAX_EVENTS_IN_MEMORY) -> None:
        self.run_id = run_id
        self.events: deque[RunEvent] = deque(maxlen=max_events)
        self._subscribers: set[asyncio.Queue[RunEvent | None]] = set()
        self._next_seq = 0
        self._lock = asyncio.Lock()
        self._closed = False
        self._events_file = _events_path(run_id)

    async def emit(self, event: RunEvent) -> RunEvent:
        async with self._lock:
            event.seq = self._next_seq
            self._next_seq += 1
            self.events.append(event)
            # Append to disk first so a viewer in another process sees it
            # even before any subscriber gets the in-memory copy.
            try:
                with self._events_file.open("a", encoding="utf-8") as f:
                    f.write(event.model_dump_json() + "\n")
            except OSError as e:
                # Persistence failure shouldn't kill the run.
                print(f"[runs] WARN: failed to persist event for {self.run_id}: {e}")
            for q in list(self._subscribers):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass
        return event

    def replay_from_disk(self) -> list[RunEvent]:
        """Re-read the persisted event log (used after a process restart)."""
        if not self._events_file.is_file():
            return []
        out: list[RunEvent] = []
        for line in self._events_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(RunEvent.model_validate_json(line))
            except Exception:
                continue
        return out

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
    def __init__(self) -> None:
        self.runs: dict[str, AgentRun] = {}
        self.channels: dict[str, RunChannel] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._load_from_disk()

    def _load_from_disk(self) -> None:
        """Repopulate runs+channels from `_RUNS_DIR` on startup so a uvicorn
        reload doesn't lose history."""
        if not _RUNS_DIR.is_dir():
            return
        loaded = 0
        for path in sorted(_RUNS_DIR.glob("*.json")):
            if path.name.endswith(".events.jsonl"):
                continue
            try:
                run = AgentRun.model_validate_json(
                    path.read_text(encoding="utf-8")
                )
            except Exception as e:
                print(f"[runs] WARN: skipping malformed {path.name}: {e}")
                continue
            self.runs[run.id] = run
            ch = RunChannel(run.id)
            ch._closed = True  # historical runs are not live
            for ev in ch.replay_from_disk():
                ch.events.append(ev)
                ch._next_seq = max(ch._next_seq, ev.seq + 1)
            self.channels[run.id] = ch
            loaded += 1
        if loaded:
            print(f"[runs] restored {loaded} run(s) from {_RUNS_DIR}")

    def _persist_run(self, run: AgentRun) -> None:
        try:
            _atomic_write(_run_path(run.id), run.model_dump_json(indent=2))
        except OSError as e:
            print(f"[runs] WARN: failed to persist run {run.id}: {e}")

    def create(self, run: AgentRun) -> AgentRun:
        self.runs[run.id] = run
        self.channels[run.id] = RunChannel(run.id)
        self._persist_run(run)
        return run

    def save(self, run: AgentRun) -> None:
        """Re-snapshot a run to disk (called after status / result changes)."""
        self._persist_run(run)

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


def runs_dir() -> Path:
    return _RUNS_DIR

