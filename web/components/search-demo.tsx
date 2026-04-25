"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

export function SearchDemo() {
  const [query, setQuery] = useState("");
  const health = trpc.health.useQuery();
  const search = trpc.search.useMutation();

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">
        backend:{" "}
        {health.isLoading
          ? "checking…"
          : health.data
            ? `${health.data.status} (v${health.data.version})`
            : `down (${health.error?.message ?? "unknown"})`}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search.mutate({ query, k: 5 });
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search papers…"
          className="flex-1 rounded border px-2 py-1 text-sm"
        />
        <Button type="submit" disabled={search.isPending}>
          {search.isPending ? "…" : "Search"}
        </Button>
      </form>
      {search.data && (
        <ul className="flex flex-col gap-2 text-sm">
          {search.data.hits.length === 0 && (
            <li className="text-xs text-muted-foreground">No results.</li>
          )}
          {search.data.hits.map((h) => (
            <li
              key={`${h.arxiv_id}-${h.chunk_index}`}
              className="rounded border p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <a
                  href={`https://arxiv.org/abs/${h.arxiv_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {h.title ?? h.arxiv_id}
                </a>
                <span className="text-xs text-muted-foreground">
                  {(h.score * 100).toFixed(1)}%
                </span>
              </div>
              <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                {h.text}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
