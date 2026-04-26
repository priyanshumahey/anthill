#!/usr/bin/env -S uv run python
"""Browse persisted agent runs from disk.

Runs are saved under `backend/.runs/`:
  - <run_id>.json          — the AgentRun snapshot (status, input, result)
  - <run_id>.events.jsonl  — every Tracer event in the order they fired

Use this when the FastAPI process restarted and you want to see what
happened anyway, or when you just want to scroll through Claude's planning
output for a past email without re-running the agent.

Examples:
    # list the 20 most recent runs
    python scripts/show_run.py

    # only review_response runs
    python scripts/show_run.py --agent review_response

    # full event log + result for one run
    python scripts/show_run.py 237d4fd565a34baab836665192c08136

    # raw JSON dump (for piping to jq / saving)
    python scripts/show_run.py 237d4fd565a34baab836665192c08136 --json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).resolve().parent.parent
_RUNS = Path(
    __import__("os").environ.get("ANTHILL_RUNS_DIR") or (_BACKEND / ".runs")
)


def _load_run(run_id: str) -> dict[str, Any] | None:
    p = _RUNS / f"{run_id}.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _load_events(run_id: str) -> list[dict[str, Any]]:
    p = _RUNS / f"{run_id}.events.jsonl"
    if not p.is_file():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _list_runs() -> list[dict[str, Any]]:
    if not _RUNS.is_dir():
        return []
    runs: list[dict[str, Any]] = []
    for p in _RUNS.glob("*.json"):
        if p.name.endswith(".events.jsonl"):
            continue
        try:
            runs.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    runs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return runs


def _fmt_time(s: str | None) -> str:
    if not s:
        return "—"
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%H:%M:%S")
    except Exception:
        return s[:19]


def _print_list(runs: list[dict[str, Any]], limit: int) -> None:
    print(f"{'when':>8}  {'status':<10}  {'agent':<22}  {'doc':<10}  id")
    print("-" * 100)
    for r in runs[:limit]:
        when = _fmt_time(r.get("created_at"))
        status = r.get("status") or "?"
        agent = r.get("agent") or "?"
        doc = (r.get("document_id") or "")[:8]
        rid = r.get("id") or ""
        print(f"{when:>8}  {status:<10}  {agent:<22}  {doc:<10}  {rid}")
    if len(runs) > limit:
        print(f"… ({len(runs) - limit} more — pass --limit to see them)")


def _print_event(ev: dict[str, Any]) -> None:
    kind = ev.get("kind", "?")
    msg = ev.get("message") or ""
    data = ev.get("data") or {}
    when = _fmt_time(ev.get("at"))
    if kind == "status":
        print(f"  {when}  status={data.get('status')}  {msg}")
    elif kind == "step":
        step = data.get("step", "?")
        rest = {k: v for k, v in data.items() if k != "step"}
        extra = ""
        if rest:
            j = json.dumps(rest, default=str)
            extra = f"  {j if len(j) < 140 else j[:139] + '…'}"
        print(f"  {when}  [{step}] {msg}{extra}")
    elif kind == "finding":
        bits = ", ".join(f"{k}={v!r}" for k, v in list(data.items())[:6])
        print(f"  {when}  ★ finding  {bits}")
    elif kind == "log":
        print(f"  {when}  log: {msg}")
    elif kind == "error":
        print(f"  {when}  error: {msg}")
    else:
        print(f"  {when}  {kind}: {msg}  {data}")


def _print_run(run: dict[str, Any], events: list[dict[str, Any]]) -> None:
    print("=" * 80)
    print(f"id          {run.get('id')}")
    print(f"agent       {run.get('agent')}")
    print(f"document    {run.get('document_id')}")
    print(f"status      {run.get('status')}")
    print(f"created     {run.get('created_at')}")
    print(f"started     {run.get('started_at')}")
    print(f"finished    {run.get('finished_at')}")
    if run.get("error"):
        print(f"error       {run['error']}")
    print()
    print("input:")
    print(json.dumps(run.get("input"), indent=2, default=str))
    if run.get("result") is not None:
        print()
        print("result:")
        print(json.dumps(run.get("result"), indent=2, default=str)[:8000])
    print()
    print(f"events  ({len(events)})")
    print("-" * 80)
    for ev in events:
        _print_event(ev)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "run_id",
        nargs="?",
        help="Run id to show. Omit to list recent runs.",
    )
    ap.add_argument("--agent", help="Filter list by agent name.")
    ap.add_argument("--doc", help="Filter list by document_id (substring match).")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--json", action="store_true", help="Dump raw JSON.")
    args = ap.parse_args()

    if not _RUNS.is_dir():
        print(f"no runs directory at {_RUNS} — has the backend ever started?")
        return 1

    if args.run_id:
        run = _load_run(args.run_id)
        if run is None:
            # Allow short-prefix match.
            matches = [
                p for p in _RUNS.glob(f"{args.run_id}*.json")
                if not p.name.endswith(".events.jsonl")
            ]
            if len(matches) == 1:
                run = json.loads(matches[0].read_text(encoding="utf-8"))
                args.run_id = run["id"]
            elif len(matches) > 1:
                print(f"prefix {args.run_id!r} matched {len(matches)} runs:")
                for p in matches:
                    print(f"  {p.stem}")
                return 1
            else:
                print(f"no run found with id starting with {args.run_id!r}")
                return 1
        events = _load_events(args.run_id)
        if args.json:
            json.dump({"run": run, "events": events}, sys.stdout, indent=2, default=str)
            print()
        else:
            _print_run(run, events)
        return 0

    runs = _list_runs()
    if args.agent:
        runs = [r for r in runs if r.get("agent") == args.agent]
    if args.doc:
        runs = [r for r in runs if args.doc in (r.get("document_id") or "")]
    if not runs:
        print("(no runs match)")
        return 0
    if args.json:
        json.dump(runs[: args.limit], sys.stdout, indent=2, default=str)
        print()
    else:
        _print_list(runs, args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
