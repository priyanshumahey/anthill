"use client";

import { formatDistanceToNow } from "date-fns";
import { Bot, Clock, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import type { AgentRun, RunStatus } from "@/server/routers/agents";

const STATUS_VARIANTS: Record<
  RunStatus,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
  running: { label: "Running", className: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  succeeded: {
    label: "Succeeded",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  cancelled: {
    label: "Cancelled",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
};

export function AgentStatusBadge({ status }: { status: RunStatus }) {
  const v = STATUS_VARIANTS[status];
  return (
    <Badge variant="secondary" className={`gap-1 ${v.className}`}>
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {v.label}
    </Badge>
  );
}

function NewLiteratureSearchForm() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [maxResults, setMaxResults] = useState(8);
  const [expand, setExpand] = useState(true);
  const [discover, setDiscover] = useState(true);
  const [discoverMax, setDiscoverMax] = useState(5);

  const create = trpc.agents.createRun.useMutation({
    onSuccess: async (run) => {
      await utils.agents.listRuns.invalidate();
      router.push(`/dashboard/agents/${run.id}`);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    create.mutate({
      agent: "literature_search",
      input: {
        query: q,
        max_results: maxResults,
        expand,
        plan_n: 4,
        discover,
        discover_max: discoverMax,
      },
    });
  };

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">New literature search</h2>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-query" className="text-xs text-muted-foreground">
            Topic
          </Label>
          <Input
            id="agent-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. retrieval-augmented generation for code"
            autoFocus
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="max-results" className="text-xs text-muted-foreground">
              Max results
            </Label>
            <Input
              id="max-results"
              type="number"
              min={1}
              max={30}
              value={maxResults}
              onChange={(e) =>
                setMaxResults(Math.max(1, Math.min(30, Number(e.target.value) || 8)))
              }
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="discover-max" className="text-xs text-muted-foreground">
              New from arXiv
            </Label>
            <Input
              id="discover-max"
              type="number"
              min={0}
              max={15}
              value={discoverMax}
              onChange={(e) =>
                setDiscoverMax(Math.max(0, Math.min(15, Number(e.target.value) || 0)))
              }
              disabled={!discover}
              className="w-24"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={discover}
              onChange={(e) => setDiscover(e.target.checked)}
              className="size-4 accent-foreground"
            />
            Discover new papers
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={expand}
              onChange={(e) => setExpand(e.target.checked)}
              className="size-4 accent-foreground"
            />
            Expand into sub-queries
          </label>
          <Button type="submit" disabled={create.isPending || !query.trim()}>
            {create.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Starting…
              </>
            ) : (
              "Start run"
            )}
          </Button>
        </div>
        {create.error && (
          <p className="text-sm text-destructive">{create.error.message}</p>
        )}
      </form>
    </Card>
  );
}

function RunSummary({ run }: { run: AgentRun }) {
  const created = new Date(run.created_at);
  const finishedAt = run.finished_at ? new Date(run.finished_at) : null;
  const startedAt = run.started_at ? new Date(run.started_at) : null;
  const elapsedMs =
    finishedAt && startedAt ? finishedAt.getTime() - startedAt.getTime() : null;
  const query = (run.input?.query as string | undefined) ?? "(no query)";

  return (
    <Link
      href={`/dashboard/agents/${run.id}`}
      className="flex flex-col gap-1 rounded-md border p-3 hover:bg-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4 text-muted-foreground" />
          {run.agent}
        </span>
        <AgentStatusBadge status={run.status} />
      </div>
      <p className="line-clamp-1 text-sm text-muted-foreground">{query}</p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="size-3" />
          {formatDistanceToNow(created, { addSuffix: true })}
        </span>
        {elapsedMs != null && (
          <span className="tabular-nums">
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
        <span className="font-mono">{run.id.slice(0, 8)}</span>
      </div>
    </Link>
  );
}

export function AgentsPanel() {
  const runs = trpc.agents.listRuns.useQuery(
    { limit: 50 },
    {
      // While anything is running, refetch the list so statuses update.
      refetchInterval: (q) =>
        q.state.data?.runs.some((r) =>
          r.status === "pending" || r.status === "running",
        )
          ? 2_000
          : false,
    },
  );

  return (
    <div className="flex flex-col gap-6">
      <NewLiteratureSearchForm />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Recent runs</h2>
        {runs.isLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {runs.error && (
          <Card className="border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600">
            {runs.error.message}
          </Card>
        )}
        {runs.data && runs.data.runs.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No runs yet. Start one above.
          </Card>
        )}
        <div className="flex flex-col gap-2">
          {runs.data?.runs.map((r) => <RunSummary key={r.id} run={r} />)}
        </div>
      </div>
    </div>
  );
}
