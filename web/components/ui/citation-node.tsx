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
  useEditorRef,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { Sparkles, ExternalLink, ChevronDown, BadgeCheck, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { runCitationVerification } from '@/lib/citation-verification';
import { cn } from '@/lib/utils';

export interface CitationCandidate {
  arxivId: string;
  chunkIndex: number;
  title?: string | null;
  score: number;
  /** Matched chunk text from the backend; clipped to ~600 chars at insert time. */
  snippet?: string | null;
}

/**
 * Verification verdict from the Nia document agent. Filled asynchronously
 * after the citation is inserted — `state` walks `pending` -> one of the
 * terminals as the agent run progresses. The element is updated through Yjs
 * so collaborators see the badge change colour live.
 */
export interface CitationVerification {
  state: 'pending' | 'supports' | 'rejects' | 'not_ready' | 'error';
  /** Source agent run id, useful for "open trace" debugging. */
  runId?: string;
  /** True when the paper actually backs the writer's claim. */
  supports?: boolean;
  /** 0.0–1.0; how strongly Nia thinks the paper supports/rejects. */
  confidence?: number;
  /** Verbatim quote pulled from the paper. */
  exactQuote?: string;
  /** Page number in the source PDF, if known. */
  pageNumber?: number | null;
  /** "Methods > Architecture" style breadcrumb. */
  sectionPath?: string | null;
  /** One-sentence rationale the writer can read. */
  rationale?: string;
  /** Total wall time spent inside Nia. */
  niaTookMs?: number;
  /** Human-readable error message when state === 'error'. */
  message?: string;
  /** ISO timestamp of when the verdict was recorded. */
  verifiedAt?: string;
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
  /** Nia verification verdict, populated asynchronously. */
  verification?: CitationVerification;
  children: [{ text: '' }];
}

function citationLabel(el: TCitationElement) {
  return `[arXiv:${el.arxivId}]`;
}

export function CitationElement(props: PlateElementProps<TCitationElement>) {
  const { element } = props;
  const editor = useEditorRef();
  const selected = useSelected();
  const readOnly = useReadOnly();
  const [open, setOpen] = React.useState(false);

  const verification = element.verification;
  const tone = verificationTone(verification);

  const handleRecheck = React.useCallback(() => {
    const claim = element.query;
    if (!claim) return;
    void runCitationVerification(editor, element, claim);
  }, [editor, element]);
  const canRecheck = !readOnly && !!element.query;

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
            'inline-flex cursor-pointer items-center gap-1 rounded-sm border px-1.5 py-0 text-[11px] font-medium leading-tight align-baseline transition focus:outline-none focus:ring-2 focus:ring-ring',
            tone.badge,
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
          {tone.icon ? <tone.icon className={cn('size-3', tone.iconClass)} /> : null}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[24rem] gap-3 p-3 text-xs"
        >
          <CitationTrace
            element={element}
            onRecheck={canRecheck ? handleRecheck : undefined}
          />
        </PopoverContent>
      </Popover>
    </PlateElement>
  );
}

interface BadgeTone {
  badge: string;
  icon: React.ComponentType<{ className?: string }> | null;
  iconClass: string;
}

const TONE_NEUTRAL: BadgeTone = {
  badge: 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
  icon: null,
  iconClass: '',
};

function verificationTone(v: CitationVerification | undefined): BadgeTone {
  if (!v) return TONE_NEUTRAL;
  switch (v.state) {
    case 'pending':
      return {
        badge: 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
        icon: Loader2,
        iconClass: 'animate-spin opacity-70',
      };
    case 'supports':
      return {
        badge:
          'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
        icon: BadgeCheck,
        iconClass: 'opacity-90',
      };
    case 'rejects':
      return {
        badge:
          'border-amber-400/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300',
        icon: AlertTriangle,
        iconClass: 'opacity-90',
      };
    case 'not_ready':
      return {
        badge:
          'border-muted-foreground/30 bg-muted/40 text-muted-foreground hover:bg-muted/60',
        icon: Loader2,
        iconClass: 'opacity-60',
      };
    case 'error':
      return {
        badge:
          'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15',
        icon: AlertTriangle,
        iconClass: 'opacity-90',
      };
    default:
      return TONE_NEUTRAL;
  }
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function CitationTrace({
  element,
  onRecheck,
}: {
  element: TCitationElement;
  onRecheck?: () => void;
}) {
  const trace = element.trace ?? [];
  const others = trace.filter(
    (t) => !(t.arxivId === element.arxivId && t.chunkIndex === element.chunkIndex),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Nia verification — the headline */}
      {element.verification && (
        <NiaVerification v={element.verification} onRecheck={onRecheck} />
      )}

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

// ── Nia verification block ─────────────────────────────────────────────────

function NiaVerification({
  v,
  onRecheck,
}: {
  v: CitationVerification;
  onRecheck?: () => void;
}) {
  if (v.state === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 p-2 text-[11px] text-primary">
        <Loader2 className="size-3 animate-spin" />
        <span>Verifying with Nia…</span>
      </div>
    );
  }

  if (v.state === 'not_ready') {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-muted-foreground/30 bg-muted/40 p-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium">
          <Loader2 className="size-3 opacity-60" />
          Nia hasn&apos;t finished indexing this paper
        </div>
        {v.message ? (
          <blockquote className="rounded bg-background/70 px-2 py-1.5 text-[11px] italic leading-snug text-foreground/80">
            &ldquo;{v.message}&rdquo;
          </blockquote>
        ) : (
          <p className="text-[10px] opacity-80">
            Indexing a fresh arXiv paper into Nia takes a couple of minutes. The
            citation stays as-is in the meantime.
          </p>
        )}
        {onRecheck && (
          <RecheckButton onClick={onRecheck} label="Re-check now" tone="muted" />
        )}
      </div>
    );
  }

  if (v.state === 'error') {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-3" /> Nia verification failed
        </div>
        {v.message && <p className="text-[10px] opacity-80">{v.message}</p>}
        {onRecheck && (
          <RecheckButton onClick={onRecheck} label="Try again" tone="destructive" />
        )}
      </div>
    );
  }

  const supports = v.state === 'supports';
  const tone = supports
    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  const Icon = supports ? BadgeCheck : AlertTriangle;
  const headline = supports
    ? 'Verified by Nia'
    : 'This paper does not support your claim';
  const conf =
    typeof v.confidence === 'number'
      ? `${Math.round(v.confidence * 100)}% confidence`
      : null;

  return (
    <div className={cn('flex flex-col gap-2 rounded-md border p-2', tone)}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <Icon className="size-3.5" />
        <span>{headline}</span>
        {conf && (
          <span className="ml-auto font-mono text-[10px] tabular-nums opacity-80">
            {conf}
          </span>
        )}
      </div>

      {v.exactQuote && (
        <blockquote className="rounded bg-background/70 px-2 py-1.5 text-[11px] italic leading-snug text-foreground/90">
          &ldquo;{v.exactQuote}&rdquo;
        </blockquote>
      )}

      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] opacity-90">
        {typeof v.pageNumber === 'number' && <span>p.{v.pageNumber}</span>}
        {v.sectionPath && (
          <>
            {typeof v.pageNumber === 'number' && <span className="opacity-50">·</span>}
            <span>{v.sectionPath}</span>
          </>
        )}
        {typeof v.niaTookMs === 'number' && (
          <>
            <span className="opacity-50">·</span>
            <span className="tabular-nums">{(v.niaTookMs / 1000).toFixed(1)}s</span>
          </>
        )}
        {onRecheck && (
          <button
            type="button"
            onClick={onRecheck}
            className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 font-sans text-[10px] opacity-70 transition hover:bg-background/60 hover:opacity-100"
            title="Re-run Nia verification for this citation"
          >
            <RefreshCw className="size-2.5" /> Re-check
          </button>
        )}
      </div>

      {v.rationale && (
        <p className="text-[10px] leading-snug opacity-90">{v.rationale}</p>
      )}
    </div>
  );
}

function RecheckButton({
  onClick,
  label,
  tone,
}: {
  onClick: () => void;
  label: string;
  tone: 'muted' | 'destructive';
}) {
  const cls =
    tone === 'destructive'
      ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
      : 'border-muted-foreground/30 bg-background/60 text-foreground hover:bg-background';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-medium transition',
        cls,
      )}
    >
      <RefreshCw className="size-3" />
      {label}
    </button>
  );
}
