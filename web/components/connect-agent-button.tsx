"use client";

/**
 * "Connect agent" dialog: shows the agent prompt prefilled with this
 * document's bridge URL + ID. One-click copy. Also exposes the raw
 * curl-able endpoints so a power user can poke the bridge by hand.
 */

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { buildAgentPrompt } from "@/lib/agent-prompt";
import { getAgentBridgeUrl } from "@/lib/collab";

interface Props {
  documentId: string;
}

export function ConnectAgentButton({ documentId }: Props) {
  const [copied, setCopied] = useState(false);
  const bridgeUrl = useMemo(() => getAgentBridgeUrl(), []);
  const prompt = useMemo(
    () => buildAgentPrompt({ bridgeUrl, documentId }),
    [bridgeUrl, documentId],
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Browsers without clipboard permission: select-and-copy manually.
    }
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-8">
            Connect agent
          </Button>
        }
      />
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect an external agent</DialogTitle>
          <DialogDescription>
            Paste this prompt into Claude Code, Copilot, ChatGPT, or any
            agent that can call HTTP. It's prefilled with this document's
            bridge URL and ID — every change the agent makes appears here
            in real time.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">Bridge URL</span>
            <code className="font-mono break-all">{bridgeUrl}</code>
            <span className="text-muted-foreground">Document ID</span>
            <code className="font-mono break-all">{documentId}</code>
          </div>

          <div className="relative">
            <textarea
              readOnly
              value={prompt}
              onFocus={(e) => e.currentTarget.select()}
              className="h-72 w-full resize-none rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCopy}>
            {copied ? "Copied!" : "Copy prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
