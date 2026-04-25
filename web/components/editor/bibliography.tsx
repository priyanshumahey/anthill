'use client';

/**
 * Live bibliography for a Plate document.
 *
 * Walks the editor's current value, collects every inline `citation` element
 * (inserted by the citation-suggest plugin), dedupes by `arxivId`, and
 * renders a numbered list below the editor.
 *
 * Reactivity note: we deliberately read `editor.children` via `useEditorRef`
 * and subscribe with `useEditorVersion` rather than using `useEditorValue`.
 * `slate-yjs`'s `YjsEditor.connect` hydrates the document by direct
 * assignment to `editor.children` with no Slate ops, so `versionValue`
 * (which `useEditorValue` listens to) never ticks for the initial Yjs sync
 * after a page refresh — the bibliography would render once with the empty
 * pre-hydration value and stay stuck. `versionEditor` is bumped by Plate's
 * wrapped `onChange`, which YjsEditor.connect *does* call, so subscribing
 * there refreshes the bibliography as soon as the Yjs state lands.
 *
 * Must be mounted inside the `<Plate>` provider tree.
 */

import * as React from 'react';

import type { TElement, Value } from 'platejs';
import { useEditorRef, useEditorVersion } from 'platejs/react';
import { BookOpen, ExternalLink } from 'lucide-react';

import type {
  CitationCandidate,
  TCitationElement,
} from '@/components/ui/citation-node';

interface BibliographyEntry {
  arxivId: string;
  title: string | null;
  /** Best (highest) score we've seen for this paper. */
  bestScore: number;
  /** How many distinct citation badges in the doc reference this paper. */
  references: number;
  /** Distinct chunk indices cited from this paper, sorted. */
  chunks: number[];
  /** Other papers that came up in the same searches as this one. */
  alsoConsidered: Set<string>;
}

function isCitationElement(node: unknown): node is TCitationElement {
  return (
    !!node &&
    typeof node === 'object' &&
    (node as { type?: unknown }).type === 'citation' &&
    typeof (node as { arxivId?: unknown }).arxivId === 'string'
  );
}

function collectCitations(value: Value | undefined): TCitationElement[] {
  if (!Array.isArray(value)) return [];
  const out: TCitationElement[] = [];
  const visit = (node: unknown) => {
    if (isCitationElement(node)) out.push(node);
    const children = (node as TElement | undefined)?.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  for (const block of value) visit(block);
  return out;
}

function aggregate(citations: TCitationElement[]): BibliographyEntry[] {
  const byId = new Map<string, BibliographyEntry>();

  for (const c of citations) {
    const key = c.arxivId;
    let entry = byId.get(key);
    if (!entry) {
      entry = {
        arxivId: key,
        title: c.title ?? null,
        bestScore: typeof c.score === 'number' ? c.score : 0,
        references: 0,
        chunks: [],
        alsoConsidered: new Set(),
      };
      byId.set(key, entry);
    }

    entry.references += 1;
    if (typeof c.score === 'number' && c.score > entry.bestScore) {
      entry.bestScore = c.score;
    }
    if (!entry.title && c.title) entry.title = c.title;
    if (!entry.chunks.includes(c.chunkIndex)) entry.chunks.push(c.chunkIndex);

    const trace = (c.trace ?? []) as CitationCandidate[];
    for (const t of trace) {
      if (t.arxivId !== key) entry.alsoConsidered.add(t.arxivId);
    }
  }

  for (const entry of byId.values()) entry.chunks.sort((a, b) => a - b);

  // Stable order: by arxivId so the list doesn't shuffle as scores drift.
  return Array.from(byId.values()).sort((a, b) =>
    a.arxivId.localeCompare(b.arxivId, undefined, { numeric: true }),
  );
}

export function Bibliography() {
  const editor = useEditorRef();
  // Subscribe to versionEditor so we re-render on every change Plate sees,
  // including the post-Yjs-hydration `editor.onChange()` call that fires
  // with no operations.
  const version = useEditorVersion();
  const value = editor?.children as Value | undefined;

  const entries = React.useMemo(
    () => aggregate(collectCitations(value)),
    // value is mutated in place by Slate, so the array reference can stay
    // stable across edits. `version` is the actual change signal here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, value],
  );

  if (entries.length === 0) return null;

  const total = entries.reduce((n, e) => n + e.references, 0);

  return (
    <section
      aria-label="Bibliography"
      className="border-t border-border pt-6"
      contentEditable={false}
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BookOpen className="size-4 text-muted-foreground" />
          References
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {entries.length} paper{entries.length === 1 ? '' : 's'}
          {total !== entries.length && (
            <> · {total} citation{total === 1 ? '' : 's'}</>
          )}
        </span>
      </header>

      <ol className="flex flex-col gap-2 text-sm">
        {entries.map((entry, i) => (
          <li
            key={entry.arxivId}
            className="flex items-baseline gap-2 leading-snug"
          >
            <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              [{i + 1}]
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <a
                href={`https://arxiv.org/abs/${entry.arxivId}`}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-baseline gap-1.5 text-foreground hover:underline"
              >
                <span>{entry.title ?? `arXiv:${entry.arxivId}`}</span>
                <ExternalLink className="size-3 shrink-0 self-center opacity-50 group-hover:opacity-100" />
              </a>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                <span>arXiv:{entry.arxivId}</span>
                {entry.references > 1 && (
                  <>
                    <span className="opacity-50">·</span>
                    <span>cited {entry.references}×</span>
                  </>
                )}
                {entry.chunks.length > 0 && (
                  <>
                    <span className="opacity-50">·</span>
                    <span>
                      chunk{entry.chunks.length === 1 ? '' : 's'}{' '}
                      {entry.chunks.join(', ')}
                    </span>
                  </>
                )}
                {entry.bestScore > 0 && (
                  <>
                    <span className="opacity-50">·</span>
                    <span>{(entry.bestScore * 100).toFixed(0)}% match</span>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
