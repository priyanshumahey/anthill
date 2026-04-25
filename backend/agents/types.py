from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid4().hex


class RunStatus(str, Enum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


TERMINAL_STATUSES: frozenset[RunStatus] = frozenset(
    {RunStatus.succeeded, RunStatus.failed, RunStatus.cancelled}
)
TERMINAL_STATUS_VALUES: frozenset[str] = frozenset(s.value for s in TERMINAL_STATUSES)


class RunEvent(BaseModel):
    seq: int
    run_id: str
    at: datetime
    kind: str
    message: str | None = None
    data: dict[str, Any] | None = None


class AgentRun(BaseModel):
    id: str = Field(default_factory=new_id)
    agent: str
    status: RunStatus = RunStatus.pending
    input: dict[str, Any]
    document_id: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    result: dict[str, Any] | None = None


class CreateRunRequest(BaseModel):
    agent: str = Field(..., min_length=1)
    input: dict[str, Any] = Field(default_factory=dict)
    document_id: str | None = None
