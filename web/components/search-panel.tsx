"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";

const SAMPLE_QUERIES = [
  "dense retrieval for scientific papers",
  "in-context learning emergence",
  "reranking with cross-encoders",
  "hallucinations in RAG systems",
];

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [k, setK] = useState(8);

  const health = trpc.health.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const search = trpc.search.useMutation();

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    search.mutate({ query: trimmed, k });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Backend status */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span
          className={
            "inline-block size-2 rounded-full " +
            (health.data?.status === "ok"
              ? "bg-emerald-500"
              : health.isLoading
                ? "bg-amber-400"
                : "bg-red-500")
          }
        />
        {health.isLoading && "checking backend…"}
        {health.data && (
          <>
            <span>backend v{health.data.version}</span>
            <span>·</span>
            <span>
              {health.data.chunks?.toLocaleString() ?? "?"} chunks indexed
            </span>
            <span>·</span>
            <span>
              model {health.data.model_loaded ? "loaded" : "warming up"}
            </span>
          </>
        )}
        {health.error && <span>down: {health.error.message}</span>}
      </div>

      {/* Search form */}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(query);
        }}
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search papers semantically — try a full sentence"
              className="pl-9"
              autoFocus
            />
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="k"
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              k
            </label>
            <Input
              id="k"
              type="number"
              min={1}
              max={50}
              value={k}
              onChange={(e) =>
                setK(Math.max(1, Math.min(50, Number(e.target.value) || 8)))
              }
              className="w-16"
            />
          </div>
          <Button type="submit" disabled={search.isPending || !query.trim()}>
            {search.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Searching…
              </>
            ) : (
              "Search"
            )}
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">try:</span>
          {SAMPLE_QUERIES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => submit(q)}
              className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            >
              {q}
            </button>
          ))}
        </div>
      </form>

      {/* Results */}
      <div className="flex flex-col gap-3">
        {search.isPending && (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        )}

        {search.error && (
          <Card className="border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600">
            {search.error.message}
          </Card>
        )}

        {search.data && !search.isPending && (
          <>
            <div className="text-xs text-muted-foreground">
              {search.data.hits.length} hit
              {search.data.hits.length === 1 ? "" : "s"} for{" "}
              <span className="font-mono">“{search.data.query}”</span> in{" "}
              {search.data.took_ms} ms
            </div>
            {search.data.hits.length === 0 && (
              <Card className="p-6 text-center text-sm text-muted-foreground">
                No results. The collection might still be indexing — try a
                different phrasing.
              </Card>
            )}
            {search.data.hits.map((h, i) => (
              <Card key={`${h.arxiv_id}-${h.chunk_index}`} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="tabular-nums">#{i + 1}</span>
                      <a
                        href={`https://arxiv.org/abs/${h.arxiv_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono hover:underline"
                      >
                        arXiv:{h.arxiv_id}
                      </a>
                      <span>·</span>
                      <span>chunk {h.chunk_index}</span>
                      {h.char_start != null && h.char_end != null && (
                        <>
                          <span>·</span>
                          <span className="tabular-nums">
                            chars {h.char_start.toLocaleString()}–
                            {h.char_end.toLocaleString()}
                          </span>
                        </>
                      )}
                    </div>
                    {h.title && (
                      <a
                        href={`https://arxiv.org/abs/${h.arxiv_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium leading-snug hover:underline"
                      >
                        {h.title}
                      </a>
                    )}
                  </div>
                  <Badge variant="secondary" className="tabular-nums">
                    {(h.score * 100).toFixed(1)}%
                  </Badge>
                </div>
                <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-sm text-muted-foreground">
                  {h.text}
                </p>
              </Card>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
