"""Tiny SQLite cache mapping arxiv_id → Nia source_id.

Why bother:
  - `GET /v2/sources` returns up to 100 items; with thousands of papers we
    can't dedup by listing every time.
  - When the literature-review agent fans out to 10+ papers, this avoids
    10+ list calls per second.
  - Persists across backend restarts so we don't re-index the demo papers.

Schema is intentionally tiny — just the join we need. We always trust Nia
as the source of truth for status; the cache only short-circuits ID lookup.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable

_DEFAULT_PATH = Path(__file__).resolve().parent.parent / ".nia_cache.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS nia_sources (
    arxiv_id        TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    status          TEXT,
    indexed_at      REAL NOT NULL,
    last_checked_at REAL NOT NULL
);
"""


class NiaCache:
    """Thread-safe SQLite cache. One file per backend instance."""

    def __init__(self, path: Path = _DEFAULT_PATH) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def get(self, arxiv_id: str) -> dict | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT arxiv_id, source_id, status, indexed_at, last_checked_at "
                "FROM nia_sources WHERE arxiv_id = ?",
                (arxiv_id,),
            ).fetchone()
        return dict(row) if row else None

    def put(self, arxiv_id: str, source_id: str, status: str) -> None:
        now = time.time()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO nia_sources (arxiv_id, source_id, status, indexed_at, last_checked_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(arxiv_id) DO UPDATE SET
                    source_id = excluded.source_id,
                    status = excluded.status,
                    last_checked_at = excluded.last_checked_at
                """,
                (arxiv_id, source_id, status, now, now),
            )
            conn.commit()

    def update_status(self, arxiv_id: str, status: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE nia_sources SET status = ?, last_checked_at = ? WHERE arxiv_id = ?",
                (status, time.time(), arxiv_id),
            )
            conn.commit()

    def all(self) -> Iterable[dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT arxiv_id, source_id, status, indexed_at, last_checked_at "
                "FROM nia_sources ORDER BY indexed_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]


_singleton: NiaCache | None = None


def get_cache() -> NiaCache:
    global _singleton
    if _singleton is None:
        _singleton = NiaCache()
    return _singleton


__all__ = ["NiaCache", "get_cache"]
