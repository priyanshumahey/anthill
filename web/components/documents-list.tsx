"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

export function DocumentsList() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.documents.list.useQuery();
  const create = trpc.documents.create.useMutation({
    onSuccess: async (doc) => {
      await utils.documents.list.invalidate();
      if (doc) router.push(`/dashboard/documents/${doc.id}`);
    },
  });
  const [title, setTitle] = useState("Untitled");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">New document</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="w-64"
          />
        </div>
        <Button
          onClick={() => create.mutate({ title })}
          disabled={create.isPending}
        >
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </div>

      {create.error && (
        <p className="text-sm text-destructive">{create.error.message}</p>
      )}

      <div className="flex flex-col divide-y rounded-md border">
        {list.isLoading && (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        )}
        {list.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No documents yet. Create one above.
          </p>
        )}
        {list.data?.map((doc) => (
          <Link
            key={doc.id}
            href={`/dashboard/documents/${doc.id}`}
            className="flex flex-col gap-1 p-4 hover:bg-accent"
          >
            <span className="font-medium">{doc.title}</span>
            <span className="font-mono text-xs text-muted-foreground">
              updated {new Date(doc.updated_at).toLocaleString()}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
