'use client';

/**
 * Inline citation element.
 *
 * Rendered as a clickable badge (`[arXiv:1234.5678]`) inside the editor.
 * Opens a popover containing the AI's "trace": the exact paragraph text
 * that was sent to the semantic-search backend, the top hit + score, and
 * the runner-up candidates that were considered. This makes the agent's
 * citation choice inspectable instead of opaque.
 *
 * Inserted by the citation-suggest plugin when the user accepts a ghost
 * suggestion (Tab). Persists through Yjs as a regular Plate element.
 */

import * as React from 'react';

import type { TElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { Sparkles, ExternalLink, ChevronDown } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface CitationCandidate {
  arxivId: string;
  chunkIndex: number;
  title?: string | null;
  score: number;
  /** Matched chunk text from the backend; clipped to ~600 chars at insert time. */
  snippet?: string | null;
}

export interface TCitationElement extends TElement {
  type: 'citation';
  arxivId: string;
  chunkIndex: number;
  title?: string | null;
  score?: number;
  /** First few hundred chars of the matched chunk for context. */
  snippet?: string | null;
  /** Paragraph text that was embedded for the semantic search. */
  query?: string | null;
  /** Backend search latency for the originating query. */
  takenMs?: number | null;
  /** ISO timestamp of when the suggestion was fetched. */
  searchedAt?: string | null;
  /** Top-k candidates returned by the backend, in score order. */
  trace?: CitationCandidate[];
  children: [{ text: '' }];
}

function citationLabel(el: TCitationElement) {
  return `[arXiv:${el.arxivId}]`;
}

export function CitationElement(props: PlateElementProps<TCitationElement>) {
  const { element } = props;
  const selected = useSelected();
  const readOnly = useReadOnly();
  const [open, setOpen] = React.useState(false);

  return (
    <PlateElement
      {...props}
      as="span"
      className="mx-px align-baseline"
      attributes={{
        ...props.attributes,
        contentEditable: false,
        draggable: !readOnly,
      }}
    >
      {props.children}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0 text-[11px] font-medium leading-tight text-primary align-baseline transition hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-ring',
            selected && 'ring-2 ring-ring',
          )}
          onMouseDown={(e) => {
            // Prevent Plate from moving the selection into the void node.
            e.preventDefault();
          }}
        >
          <span className="font-mono">{citationLabel(element)}</span>
          {typeof element.score === 'number' && (
            <span className="tabular-nums opacity-70">
              {(element.score * 100).toFixed(0)}%
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[22rem] gap-3 p-3 text-xs"
        >
          <CitationTrace element={element} />
        </PopoverContent>
      </Popover>
    </PlateElement>
  );
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function CitationTrace({ element }: { element: TCitationElement }) {
  const trace = element.trace ?? [];
  const others = trace.filter(
    (t) => !(t.arxivId === element.arxivId && t.chunkIndex === element.chunkIndex),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Header: title + meta */}
      <div className="flex flex-col gap-1.5">
        <a
          href={`https://arxiv.org/abs/${element.arxivId}`}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-start gap-1.5 text-sm font-medium leading-snug hover:underline"
        >
          <span className="line-clamp-2 flex-1">
            {element.title ?? `arXiv:${element.arxivId}`}
          </span>
          <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-50 group-hover:opacity-100" />
        </a>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
          <span>arXiv:{element.arxivId}</span>
          <span className="opacity-50">·</span>
          <span>chunk {element.chunkIndex}</span>
          {typeof element.score === 'number' && (
            <>
              <span className="opacity-50">·</span>
              <span className="tabular-nums">
                {(element.score * 100).toFixed(0)}% match
              </span>
            </>
          )}
        </div>
        {element.snippet && (
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
            {element.snippet}
          </p>
        )}
      </div>

      {/* Why this — the agent's input that led here */}
      {element.query && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3" /> Searched for
          </div>
          <p className="line-clamp-3 text-[11px] italic text-foreground/80">
            “{truncate(element.query, 220)}”
          </p>
          {(element.takenMs != null || element.searchedAt) && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {typeof element.takenMs === 'number' && (
                <span className="tabular-nums">{element.takenMs} ms</span>
              )}
              {element.takenMs != null && element.searchedAt && (
                <span className="opacity-50">·</span>
              )}
              {element.searchedAt && (
                <time dateTime={element.searchedAt}>
                  {new Date(element.searchedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              )}
            </div>
          )}
        </div>
      )}

      {/* Runners-up */}
      {others.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Also considered
          </div>
          <ol className="flex flex-col gap-0.5">
            {others.slice(0, 4).map((t) => (
              <RunnerUp key={`${t.arxivId}-${t.chunkIndex}`} candidate={t} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function RunnerUp({ candidate }: { candidate: CitationCandidate }) {
  const [open, setOpen] = React.useState(false);
  const hasSnippet = !!candidate.snippet;

  return (
    <li className="rounded">
      <div className="flex items-center gap-2 px-1.5 py-1">
        <a
          href={`https://arxiv.org/abs/${candidate.arxivId}`}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-1 flex-1 text-[11px] hover:underline"
        >
          {candidate.title ?? `arXiv:${candidate.arxivId}`}
        </a>
        <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
          {(candidate.score * 100).toFixed(0)}%
        </span>
        {hasSnippet && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide snippet' : 'Show snippet'}
            onClick={() => setOpen((v) => !v)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'size-3 transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        )}
      </div>
      {open && hasSnippet && (
        <p className="mx-1.5 mb-1.5 line-clamp-4 whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
          {candidate.snippet}
        </p>
      )}
    </li>
  );
}
