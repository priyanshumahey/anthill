from __future__ import annotations

from typing import Any

from .store import RunStore
from .types import AgentRun, RunEvent, RunStatus, TERMINAL_STATUSES, utcnow


class Tracer:
    def __init__(self, store: RunStore, run: AgentRun) -> None:
        self.store = store
        self.run = run

    async def _emit(
        self,
        kind: str,
        message: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        ch = self.store.channel(self.run.id)
        if ch is None:
            return
        await ch.emit(
            RunEvent(
                seq=0,
                run_id=self.run.id,
                at=utcnow(),
                kind=kind,
                message=message,
                data=data,
            )
        )

    async def status(self, status: RunStatus, message: str | None = None) -> None:
        self.run.status = status
        if status == RunStatus.running and self.run.started_at is None:
            self.run.started_at = utcnow()
        if status in TERMINAL_STATUSES:
            self.run.finished_at = utcnow()
        await self._emit("status", message=message, data={"status": status.value})

    async def log(self, message: str, **data: Any) -> None:
        await self._emit("log", message=message, data=data or None)

    async def step(self, name: str, message: str | None = None, **data: Any) -> None:
        payload: dict[str, Any] = {"step": name, **data}
        await self._emit("step", message=message, data=payload)

    async def finding(self, **data: Any) -> None:
        await self._emit("finding", data=data)

    async def error(self, message: str) -> None:
        self.run.error = message
        await self._emit("error", message=message)
