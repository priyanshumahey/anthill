"use client";

import { useEffect, useRef, useState } from "react";

import type { RunEvent, RunStatus } from "@/server/routers/agents";

const TERMINAL_STATUSES: Set<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

type StreamState = {
  events: RunEvent[];
  status: RunStatus | null;
  connected: boolean;
  error: string | null;
};

/**
 * Subscribes to `/api/agents/runs/:id/events` and merges events into state.
 *
 * Replays the snapshot the proxy sends on connect, then follows the live
 * stream. Closes the EventSource as soon as a terminal status arrives.
 */
export function useAgentRunStream(
  runId: string | undefined,
  initialEvents: RunEvent[] = [],
  initialStatus: RunStatus | null = null,
): StreamState {
  const [events, setEvents] = useState<RunEvent[]>(initialEvents);
  const [status, setStatus] = useState<RunStatus | null>(initialStatus);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<number>>(new Set(initialEvents.map((e) => e.seq)));

  // Reset internal trackers when the runId changes.
  useEffect(() => {
    setEvents(initialEvents);
    setStatus(initialStatus);
    setConnected(false);
    setError(null);
    seen.current = new Set(initialEvents.map((e) => e.seq));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    if (initialStatus && TERMINAL_STATUSES.has(initialStatus)) return;

    const es = new EventSource(`/api/agents/runs/${runId}/events`);
    setConnected(true);
    setError(null);

    const ingest = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as RunEvent;
        if (seen.current.has(parsed.seq)) return;
        seen.current.add(parsed.seq);
        setEvents((prev) => {
          const next = [...prev, parsed];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        });
        if (parsed.kind === "status") {
          const s = (parsed.data?.status as RunStatus | undefined) ?? null;
          if (s) setStatus(s);
          if (s && TERMINAL_STATUSES.has(s)) {
            es.close();
            setConnected(false);
          }
        }
      } catch (e) {
        console.error("[agents] bad SSE payload", e, raw);
      }
    };

    // Backend names events by `kind` (`event: status`, `event: log`, ...).
    // EventSource does not deliver named events to `onmessage`, so attach a
    // listener for each kind we know about.
    for (const kind of ["status", "log", "step", "finding", "error"] as const) {
      es.addEventListener(kind, (ev) => ingest((ev as MessageEvent).data));
    }
    es.onmessage = (ev) => ingest(ev.data);
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; only surface an error if it stays down.
      setError((prev) => prev ?? "stream interrupted; retrying…");
    };
    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    return () => {
      es.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { events, status, connected, error };
}
