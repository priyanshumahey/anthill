/**
 * Citation verification driver — fires the `ground_citation` agent for an
 * inserted citation node and patches the node's `verification` field as
 * SSE events arrive.
 *
 * Used in two places:
 *   1. The citation-suggest plugin, on Tab-accept of a ghost suggestion.
 *   2. The citation badge popover's "Re-check" button, when the user wants
 *      to retry a `not_ready` or `error` verdict.
 */

import type { PlateEditor } from 'platejs/react';

import type {
  CitationVerification,
  TCitationElement,
} from '@/components/ui/citation-node';

interface CreateRunResponse {
  id: string;
  status: string;
}

interface SsePayload {
  seq: number;
  kind: string;
  message?: string | null;
  data?: Record<string, unknown> | null;
}

export interface CitationMatch {
  arxivId: string;
  chunkIndex: number;
  /** The node's `searchedAt` field — stable across re-checks of the same node. */
  searchedAt: string | null;
}

export function citationMatchOf(node: TCitationElement): CitationMatch {
  return {
    arxivId: node.arxivId,
    chunkIndex: node.chunkIndex,
    searchedAt: node.searchedAt ?? null,
  };
}

/**
 * Walks the tree, finds every citation node matching `match`, and merges
 * `patch` into its `verification`. Safe under Yjs reordering because we
 * match on stable element identity rather than path.
 */
export function patchCitationVerification(
  editor: PlateEditor,
  match: CitationMatch,
  patch: Partial<CitationVerification>,
): void {
  const entries = editor.api.nodes<TCitationElement>({
    at: [],
    match: (n) => {
      const el = n as Partial<TCitationElement>;
      return (
        el.type === 'citation' &&
        el.arxivId === match.arxivId &&
        el.chunkIndex === match.chunkIndex &&
        (el.searchedAt ?? null) === match.searchedAt
      );
    },
  });

  for (const [node, path] of entries) {
    const next: CitationVerification = {
      ...(node.verification ?? { state: 'pending' }),
      ...patch,
    };
    editor.tf.setNodes<TCitationElement>({ verification: next }, { at: path });
  }
}

/**
 * Fire `ground_citation` for one citation node. The function returns once
 * the agent run reaches a terminal status. Errors set the node's
 * verification to `error`; successful runs land on `supports` / `rejects` /
 * `not_ready` depending on the agent's verdict.
 *
 * The caller usually doesn't `await` this — the badge re-renders on its
 * own as the node mutates.
 */
export async function runCitationVerification(
  editor: PlateEditor,
  node: TCitationElement,
  claim: string,
): Promise<void> {
  const match = citationMatchOf(node);

  // Reset to pending so re-checks visually start fresh.
  patchCitationVerification(editor, match, {
    state: 'pending',
    message: undefined,
  });

  let runId: string | undefined;

  try {
    const res = await fetch('/api/agents/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'ground_citation',
        input: { arxiv_id: node.arxivId, claim },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const created = (await res.json()) as CreateRunResponse;
    runId = created.id;
    patchCitationVerification(editor, match, { runId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to start run';
    patchCitationVerification(editor, match, { state: 'error', message });
    return;
  }

  await new Promise<void>((resolve) => {
    const es = new EventSource(`/api/agents/runs/${runId}/events`);

    const close = () => {
      try {
        es.close();
      } catch {
        /* noop */
      }
      resolve();
    };

    const ingest = (raw: string) => {
      let payload: SsePayload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      const data = (payload.data ?? {}) as Record<string, unknown>;

      if (payload.kind === 'finding' && data.kind === 'grounded_citation') {
        const supports = !!data.supports_claim;
        patchCitationVerification(editor, match, {
          state: supports ? 'supports' : 'rejects',
          supports,
          confidence:
            typeof data.confidence === 'number' ? data.confidence : undefined,
          exactQuote:
            typeof data.exact_quote === 'string' ? data.exact_quote : undefined,
          pageNumber:
            typeof data.page_number === 'number'
              ? data.page_number
              : data.page_number === null
                ? null
                : undefined,
          sectionPath:
            typeof data.section_path === 'string'
              ? data.section_path
              : data.section_path === null
                ? null
                : undefined,
          rationale:
            typeof data.rationale === 'string' ? data.rationale : undefined,
          niaTookMs:
            typeof data.nia_took_ms === 'number' ? data.nia_took_ms : undefined,
          verifiedAt: new Date().toISOString(),
        });
      } else if (payload.kind === 'step' && data.step === 'nia_not_ready') {
        const rationale =
          typeof data.rationale === 'string' ? data.rationale : undefined;
        const status =
          typeof data.status === 'string' ? data.status : undefined;
        patchCitationVerification(editor, match, {
          state: 'not_ready',
          message:
            rationale ??
            payload.message ??
            (status ? `Nia source status: ${status}` : 'Nia is still indexing this paper'),
        });
      } else if (payload.kind === 'status') {
        const status = (data.status as string | undefined) ?? null;
        if (status === 'failed' || status === 'cancelled') {
          patchCitationVerification(editor, match, {
            state: 'error',
            message: payload.message ?? `run ${status}`,
          });
        }
        if (
          status === 'succeeded' ||
          status === 'failed' ||
          status === 'cancelled'
        ) {
          close();
        }
      } else if (payload.kind === 'error') {
        patchCitationVerification(editor, match, {
          state: 'error',
          message: payload.message ?? 'agent error',
        });
      }
    };

    for (const kind of ['status', 'log', 'step', 'finding', 'error'] as const) {
      es.addEventListener(kind, (ev) => ingest((ev as MessageEvent).data));
    }
    es.onmessage = (ev) => ingest(ev.data);
    es.onerror = () => {
      // EventSource auto-reconnects; tolerate transient failures.
    };
  });
}
