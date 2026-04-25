#!/usr/bin/env -S uv run python
"""End-to-end smoke test for the citation_inserter agent.

What this does:
 1. Seed a fresh research-paper document with the existing
    `seed-example-paper.ts --no-citations` script (no citations inserted).
 2. Snapshot the doc through the agent bridge — assert 0 citations.
 3. Trigger the `citation_inserter` agent via the FastAPI backend.
 4. Stream the run's SSE event log to stdout so you see plan / search /
    inserted events live.
 5. Snapshot again — print which paragraphs got cited and what arXiv IDs.

Prereqs (all four endpoints already healthy on this machine):
   - Supabase   :54321
   - Hocuspocus :8888
   - Bridge     :8889
   - Backend    :8000

Usage:
   python backend/scripts/test_citation_inserter.py            # seed fresh
   python backend/scripts/test_citation_inserter.py --doc <id> # reuse doc
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

REPO = Path(__file__).resolve().parents[2]
COLLAB = REPO / "collab"

BRIDGE = os.environ.get("ANTHILL_BRIDGE_URL", "http://127.0.0.1:8889")
BRIDGE_TOKEN = os.environ.get("ANTHILL_AGENT_BRIDGE_SECRET", "")
BACKEND = os.environ.get("ANTHILL_BACKEND_URL", "http://127.0.0.1:8000")
BACKEND_SECRET = os.environ.get("ANTHILL_SHARED_SECRET", "")


def _bridge_headers(agent_id: str = "smoke-test") -> dict[str, str]:
    h = {"X-Agent-Id": agent_id, "Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        h["X-Agent-Token"] = BRIDGE_TOKEN
    return h


def _backend_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BACKEND_SECRET:
        h["X-Anthill-Secret"] = BACKEND_SECRET
    return h


def seed_document(doc_id: str | None) -> str:
    """Run the existing TS seeder with --no-citations.

    If `doc_id` is None, the seeder creates a new document and prints its
    id; we parse that out of stdout. If `doc_id` is given, the seeder
    requires the row to already exist.
    """
    cmd = ["bun", "scripts/seed-example-paper.ts", "--no-citations"]
    if doc_id:
        cmd += ["--doc-id", doc_id]
    print(f"[seed] running: {' '.join(cmd[1:])}")
    proc = subprocess.run(cmd, cwd=COLLAB, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"seeder failed (exit {proc.returncode})")

    # echo the seeder's tail so you see what it did.
    tail = proc.stdout.splitlines()[-12:]
    for line in tail:
        print(f"[seed] {line}")

    if doc_id:
        return doc_id
    # Parse "document created <uuid>" or fall back to scanning for a UUID.
    m = re.search(
        r"document created\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        proc.stdout,
    )
    if not m:
        m = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            proc.stdout,
        )
    if not m:
        sys.stderr.write(proc.stdout)
        raise SystemExit("could not parse new document id from seeder output")
    return m.group(1)


async def snapshot(client: httpx.AsyncClient, doc_id: str) -> dict[str, Any]:
    r = await client.get(f"{BRIDGE}/documents/{doc_id}/snapshot", headers=_bridge_headers())
    r.raise_for_status()
    return r.json()


def count_citations(snap: dict[str, Any]) -> tuple[int, list[str]]:
    n = 0
    refs: list[str] = []
    for b in snap.get("blocks", []):
        for inl in b.get("inlines") or []:
            if inl.get("type") == "citation":
                n += 1
                refs.append(b["ref"])
    return n, refs


async def stream_run_events(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    """Read the SSE stream for an agent run; return the final result."""
    url = f"{BACKEND}/agents/runs/{run_id}/events"
    print(f"[run] streaming {url}")
    async with client.stream("GET", url, headers=_backend_headers(), timeout=None) as resp:
        resp.raise_for_status()
        kind = ""
        data_buf: list[str] = []
        async for raw in resp.aiter_lines():
            if raw == "":
                if data_buf:
                    payload = "\n".join(data_buf)
                    try:
                        ev = json.loads(payload)
                    except Exception:
                        ev = {"raw": payload}
                    _print_event(kind, ev)
                    if kind == "status":
                        status = (ev.get("data") or {}).get("status")
                        if status in {"succeeded", "failed", "cancelled"}:
                            break
                kind = ""
                data_buf = []
                continue
            if raw.startswith("event:"):
                kind = raw[len("event:") :].strip()
            elif raw.startswith("data:"):
                data_buf.append(raw[len("data:") :].lstrip())
    # Pull the final run record.
    r = await client.get(f"{BACKEND}/agents/runs/{run_id}", headers=_backend_headers())
    r.raise_for_status()
    return r.json()


def _print_event(kind: str, ev: dict[str, Any]) -> None:
    msg = ev.get("message") or ""
    data = ev.get("data") or {}
    if kind == "status":
        print(f"  · status={data.get('status')} {msg}")
    elif kind == "step":
        step = data.get("step", "?")
        rest = {k: v for k, v in data.items() if k != "step"}
        print(f"  · [{step}] {msg}" + (f"  {_short(rest)}" if rest else ""))
    elif kind == "finding":
        print(
            f"  · ★ finding: {data.get('block_ref')} → arXiv:{data.get('arxiv_id')}"
            f"  score={data.get('score'):.2f}  {data.get('title')}"
        )
    elif kind == "log":
        print(f"  · log: {msg}")
    elif kind == "error":
        print(f"  · error: {msg}")
    else:
        print(f"  · {kind}: {msg} {data}")


def _short(d: dict[str, Any], limit: int = 120) -> str:
    s = json.dumps(d, default=str)
    return s if len(s) <= limit else s[: limit - 1] + "…"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Reuse an existing document id (skip seeding).")
    ap.add_argument("--max-inserts", type=int, default=8)
    ap.add_argument("--min-score", type=float, default=0.55)
    ap.add_argument("--min-chars", type=int, default=80)
    args = ap.parse_args()

    doc_id = args.doc
    fresh = doc_id is None

    if fresh:
        doc_id = seed_document(None)
        # Hocuspocus persists on a debounce; give it a beat before we ask.
        time.sleep(1.5)
    else:
        print(f"[seed] reusing existing doc {doc_id}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Sanity: snapshot before
        before = await snapshot(client, doc_id)
        before_n, before_refs = count_citations(before)
        print(
            f"[before] doc={doc_id}  blocks={before.get('blockCount')}"
            f"  citations={before_n} on refs={before_refs}"
        )
        # Print first few paragraph previews so you see what got seeded.
        for b in (before.get("blocks") or [])[:6]:
            text = (b.get("text") or "").strip()
            if text:
                print(f"        {b['ref']:>4} [{b['type']:<12}] {text[:90]}…")

        # 2. Trigger citation_inserter
        body = {
            "agent": "citation_inserter",
            "document_id": doc_id,
            "input": {
                "max_inserts": args.max_inserts,
                "min_score": args.min_score,
                "min_chars": args.min_chars,
            },
        }
        print(f"\n[run] POST /agents/runs  body={_short(body)}")
        r = await client.post(
            f"{BACKEND}/agents/runs", headers=_backend_headers(), json=body
        )
        r.raise_for_status()
        run = r.json()
        run_id = run["id"]
        print(f"[run] created id={run_id}  status={run['status']}")

        final = await stream_run_events(client, run_id)
        result = final["run"].get("result") or {}
        print(
            f"\n[run] done  status={final['run']['status']}"
            f"  inserted={len(result.get('inserted') or [])}"
            f"  skipped={len(result.get('skipped') or [])}"
        )

        # 3. Snapshot after — show what changed.
        time.sleep(0.5)
        after = await snapshot(client, doc_id)
        after_n, after_refs = count_citations(after)
        print(
            f"\n[after] blocks={after.get('blockCount')}"
            f"  citations={after_n}  on refs={after_refs}"
        )
        for b in after.get("blocks") or []:
            inlines = [i for i in (b.get("inlines") or []) if i.get("type") == "citation"]
            if not inlines:
                continue
            cite_str = ", ".join(
                f"arXiv:{i.get('attrs', {}).get('arxivId')}" for i in inlines
            )
            preview = (b.get("text") or "")[:80]
            print(f"        {b['ref']:>4}  ←  {cite_str}\n               “{preview}…”")

        # 4. Pass/fail summary
        added = after_n - before_n
        ok = added > 0 and final["run"]["status"] == "succeeded"
        print(
            f"\n[result] {'PASS' if ok else 'FAIL'}: added {added} citation(s) "
            f"({before_n} → {after_n})  doc_id={doc_id}"
        )
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
