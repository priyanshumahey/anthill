"use client";

import { format } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { AgentStatusBadge } from "@/components/agents-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAgentRunStream } from "@/hooks/use-agent-run-stream";
import { trpc } from "@/lib/trpc";
import type { AgentRun, RunEvent } from "@/server/routers/agents";

type Finding = {
  // literature_search / citation_inserter
  rank?: number;
  arxiv_id?: string;
  title?: string | null;
  chunk_index?: number;
  text?: string;
  score?: number;
  matched_query?: string;
  newly_indexed?: boolean;
  // review_response / ground_citation
  kind?: string;
  anchor_ref?: string;
  rationale?: string;
  preview?: string;
  block_ref?: string;
  body?: string;
  replacement?: string;
  exact_quote?: string;
  supports_claim?: boolean;
  confidence?: number;
  page_number?: number | string;
  section_path?: string;
};

const KIND_ICONS: Record<string, React.ReactNode> = {
  status: <ChevronRight className="size-3.5 text-muted-foreground" />,
  log: <ChevronRight className="size-3.5 text-muted-foreground" />,
  step: <ChevronRight className="size-3.5 text-blue-500" />,
  finding: <CheckCircle2 className="size-3.5 text-emerald-500" />,
  error: <AlertCircle className="size-3.5 text-red-500" />,
};

function EventRow({ ev }: { ev: RunEvent }) {
  const time = format(new Date(ev.at), "HH:mm:ss.SSS");
  const stepName = (ev.data?.step as string | undefined) ?? null;
  const kindLabel = stepName ?? ev.kind;
  const detail = ev.message ?? "";

  return (
    <div className="flex items-start gap-2 border-l border-border/60 py-1.5 pl-3 text-sm">
      <span className="mt-0.5 shrink-0">{KIND_ICONS[ev.kind] ?? KIND_ICONS.log}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{time}</span>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {kindLabel}
          </span>
          {detail && <span className="truncate">{detail}</span>}
        </div>
        {ev.data && Object.keys(ev.data).length > 0 && ev.kind !== "finding" && (
          <pre className="mt-0.5 line-clamp-2 overflow-hidden text-[11px] text-muted-foreground">
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(ev.data).filter(
                  ([k]) => k !== "step" && k !== "status",
                ),
              ),
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

function FindingCard({ f }: { f: Finding }) {
  // Two display modes: arxiv-style (literature search / citation inserter)
  // vs. anchored-action style (review_response / ground_citation).
  const isArxiv = Boolean(f.arxiv_id) && f.kind !== "grounded_citation";

  if (isArxiv) {
    return (
      <Card className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {typeof f.rank === "number" && (
                <span className="tabular-nums">#{f.rank}</span>
              )}
              {f.arxiv_id && (
                <a
                  href={`https://arxiv.org/abs/${f.arxiv_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:underline"
                >
                  arXiv:{f.arxiv_id}
                </a>
              )}
              {typeof f.chunk_index === "number" && (
                <span>· chunk {f.chunk_index}</span>
              )}
              {f.newly_indexed && (
                <Badge
                  variant="secondary"
                  className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                >
                  new
                </Badge>
              )}
            </div>
            {f.title && (
              <a
                href={`https://arxiv.org/abs/${f.arxiv_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium leading-snug hover:underline"
              >
                {f.title}
              </a>
            )}
            {f.matched_query && (
              <p className="text-[11px] text-muted-foreground">
                matched: <span className="font-mono">{f.matched_query}</span>
              </p>
            )}
          </div>
          {typeof f.score === "number" && (
            <Badge variant="secondary" className="tabular-nums">
              {(f.score * 100).toFixed(1)}%
            </Badge>
          )}
        </div>
        {f.text && (
          <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
            {f.text}
          </p>
        )}
      </Card>
    );
  }

  // Generic / anchored-action style finding.
  const kindLabel = f.kind ?? "finding";
  const anchor = f.anchor_ref ?? f.block_ref ?? null;
  const headline =
    f.preview ??
    f.replacement ??
    f.body ??
    f.exact_quote ??
    f.rationale ??
    f.title ??
    "";

  const KIND_BADGE: Record<string, string> = {
    edit: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    comment: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    title: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
    grounded_citation: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  };

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant="secondary"
              className={KIND_BADGE[kindLabel] ?? ""}
            >
              {kindLabel}
            </Badge>
            {anchor && <span className="font-mono">{anchor}</span>}
            {f.arxiv_id && (
              <a
                href={`https://arxiv.org/abs/${f.arxiv_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:underline"
              >
                arXiv:{f.arxiv_id}
              </a>
            )}
            {typeof f.page_number !== "undefined" && (
              <span>· p.{f.page_number}</span>
            )}
            {f.section_path && (
              <span className="truncate">· {f.section_path}</span>
            )}
            {typeof f.supports_claim === "boolean" && (
              <Badge
                variant="secondary"
                className={
                  f.supports_claim
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-500/15 text-red-700 dark:text-red-300"
                }
              >
                {f.supports_claim ? "supports" : "does not support"}
              </Badge>
            )}
          </div>
          {headline && (
            <p className="text-sm leading-snug">
              {headline.length > 320 ? headline.slice(0, 320) + "…" : headline}
            </p>
          )}
          {f.rationale && f.rationale !== headline && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">why: </span>
              {f.rationale}
            </p>
          )}
          {f.exact_quote && f.exact_quote !== headline && (
            <p className="border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              “{f.exact_quote}”
            </p>
          )}
        </div>
        {typeof f.confidence === "number" && (
          <Badge variant="secondary" className="tabular-nums">
            {(f.confidence * 100).toFixed(0)}%
          </Badge>
        )}
        {typeof f.score === "number" && !f.confidence && (
          <Badge variant="secondary" className="tabular-nums">
            {(f.score * 100).toFixed(1)}%
          </Badge>
        )}
      </div>
    </Card>
  );
}

export function AgentRunDetail({ runId }: { runId: string }) {
  const utils = trpc.useUtils();

  // Pull the snapshot once. While the run is non-terminal, also poll so that
  // `result` shows up as soon as the backend writes it (events tell us when).
  const detail = trpc.agents.getRun.useQuery(
    { id: runId },
    {
      refetchInterval: (q) => {
        const s = q.state.data?.run.status;
        return s === "pending" || s === "running" ? 3_000 : false;
      },
    },
  );

  const cancel = trpc.agents.cancelRun.useMutation({
    onSuccess: () => utils.agents.getRun.invalidate({ id: runId }),
  });

  const initialEvents = detail.data?.events ?? [];
  const initialStatus = detail.data?.run.status ?? null;
  const stream = useAgentRunStream(runId, initialEvents, initialStatus);

  // When the run reaches a terminal state via SSE, refetch for the final result.
  useEffect(() => {
    if (
      stream.status === "succeeded" ||
      stream.status === "failed" ||
      stream.status === "cancelled"
    ) {
      void utils.agents.getRun.invalidate({ id: runId });
    }
  }, [stream.status, runId, utils.agents.getRun]);

  const run = detail.data?.run;
  const liveStatus = stream.status ?? run?.status;

  // Findings come from streamed events (so they appear progressively) or
  // from the final result if we missed them. Different agents shape their
  // result payloads differently — we accept the common keys.
  const findings = useMemo<Finding[]>(() => {
    const fromStream = stream.events
      .filter((e) => e.kind === "finding")
      .map((e) => (e.data ?? {}) as Finding);
    if (fromStream.length > 0) {
      // Stable order: by rank when present, otherwise insertion order.
      return fromStream.some((f) => typeof f.rank === "number")
        ? [...fromStream].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        : fromStream;
    }
    const result = (run?.result ?? {}) as {
      papers?: Finding[];
      applied?: Finding[];
      findings?: Finding[];
    };
    return result.papers ?? result.applied ?? result.findings ?? [];
  }, [stream.events, run?.result]);

  const traceRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is "pinned" near the bottom so we only auto-scroll
  // when they haven't deliberately scrolled up to read older events.
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    const el = traceRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [stream.events.length]);

  const handleTraceScroll = () => {
    const el = traceRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 24;
  };

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading run…
      </div>
    );
  }
  if (detail.error || !run) {
    return (
      <Card className="border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600">
        {detail.error?.message ?? "Run not found"}
      </Card>
    );
  }

  const query = (run.input?.query as string | undefined) ?? "";

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">{run.agent}</h1>
          {liveStatus && <AgentStatusBadge status={liveStatus} />}
          {stream.connected && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
              live
            </span>
          )}
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {run.id}
          </span>
        </div>
        {query && (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">“{query}”</span>
          </p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>created {format(new Date(run.created_at), "PP p")}</span>
          {(liveStatus === "pending" || liveStatus === "running") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => cancel.mutate({ id: runId })}
              disabled={cancel.isPending}
            >
              <XCircle className="size-3.5" /> Cancel
            </Button>
          )}
        </div>
        {run.error && (
          <Card className="border-red-500/40 bg-red-500/5 p-3 text-sm text-red-600">
            {run.error}
          </Card>
        )}
      </div>

      {/* Trace + findings: side-by-side on wide screens, stacked on mobile.
          We give each pane an explicit height so its inner list scrolls
          independently instead of pushing the page off-screen. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr]">
        <Card className="flex h-[70vh] min-h-0 flex-col p-0">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <h2 className="text-sm font-medium">Trace</h2>
            <span className="text-xs text-muted-foreground">
              {stream.events.length} event{stream.events.length === 1 ? "" : "s"}
            </span>
          </div>
          <div
            ref={traceRef}
            onScroll={handleTraceScroll}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="flex flex-col gap-1 p-3">
              {stream.events.length === 0 && (
                <p className="text-sm text-muted-foreground">No events yet.</p>
              )}
              {stream.events.map((ev) => (
                <EventRow key={ev.seq} ev={ev} />
              ))}
            </div>
          </div>
        </Card>

        <Card className="flex h-[70vh] min-h-0 flex-col p-0">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <h2 className="text-sm font-medium">Findings</h2>
            <span className="text-xs text-muted-foreground">
              {findings.length}{" "}
              {run.agent === "literature_search"
                ? `paper${findings.length === 1 ? "" : "s"}`
                : `item${findings.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-2 p-3">
              {findings.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {liveStatus === "running" || liveStatus === "pending"
                    ? "Waiting for results…"
                    : "No findings."}
                </p>
              )}
              {findings.map((f, i) => (
                <FindingCard
                  key={`${f.arxiv_id ?? f.anchor_ref ?? f.block_ref ?? "f"}-${
                    f.chunk_index ?? f.kind ?? ""
                  }-${i}`}
                  f={f}
                />
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
