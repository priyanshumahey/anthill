"""Backend agent runtime.

A small, in-process scheduler for long-running, traceable agents.
Each run gets a UUID, a status lifecycle, and a stream of trace events
that the web UI can replay or subscribe to via SSE.
"""

from .store import RunStore, get_store
from .tracing import Tracer
from .types import (
    AgentRun,
    CreateRunRequest,
    RunEvent,
    RunStatus,
    TERMINAL_STATUSES,
)

__all__ = [
    "AgentRun",
    "CreateRunRequest",
    "RunEvent",
    "RunStatus",
    "RunStore",
    "TERMINAL_STATUSES",
    "Tracer",
    "get_store",
]
