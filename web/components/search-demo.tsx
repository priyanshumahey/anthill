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
          if (query.trim()) search.mutate({ query, limit: 5 });
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
          {search.data.results.map((r) => (
            <li key={r.id} className="rounded border p-2">
              <div className="font-medium">{r.title}</div>
              {r.abstract && (
                <div className="text-xs text-muted-foreground">{r.abstract}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
