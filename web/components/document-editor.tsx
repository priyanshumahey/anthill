"use client";

/**
 * Document workspace: title bar + collaborative Plate editor.
 *
 * Content is owned by Yjs via Hocuspocus (see /collab). The title is saved
 * via tRPC because it lives outside the Yjs document and powers the docs list.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CollabEditor } from "@/components/editor/collab-editor";
import { ConnectAgentButton } from "@/components/connect-agent-button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

type Props = {
  id: string;
  initialTitle: string;
  initialContent: unknown[];
  user: {
    id: string;
    name?: string | null;
    avatar?: string | null;
  };
};

export function DocumentEditor({
  id,
  initialTitle,
  initialContent,
  user,
}: Props) {
  const [title, setTitle] = useState(initialTitle);

  const save = trpc.documents.save.useMutation();
  const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queueTitleSave = useCallback(
    (next: string) => {
      if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = setTimeout(() => {
        // Title only: send the existing content snapshot through (Yjs is the
        // source of truth for body content; tRPC `save` accepts a Plate value).
        save.mutate({
          id,
          title: next,
          content: initialContent as Record<string, unknown>[],
        });
      }, 600);
    },
    [id, save, initialContent],
  );

  useEffect(() => {
    return () => {
      if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-2">
        <Input
          value={title}
          onChange={(e) => {
            const next = e.target.value;
            setTitle(next);
            queueTitleSave(next);
          }}
          placeholder="Untitled"
          className="h-9 max-w-xl border-none bg-transparent px-0 text-base font-medium shadow-none focus-visible:ring-0"
        />
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {save.isPending ? "Saving title…" : ""}
        </span>
        <ConnectAgentButton documentId={id} />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <CollabEditor
          documentId={id}
          initialContent={initialContent}
          userId={user.id}
          userName={user.name ?? undefined}
          userAvatar={user.avatar ?? undefined}
        />
      </div>
    </div>
  );
}
