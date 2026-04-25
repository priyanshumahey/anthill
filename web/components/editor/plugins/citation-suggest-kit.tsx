'use client';

/**
 * Citation suggestion plugin.
 *
 * UX:
 *   1. User types in a paragraph.
 *   2. After ~1.2s of inactivity, the current block's text is sent to the
 *      FastAPI semantic-search backend via /api/citations/suggest.
 *   3. The top hit is rendered as a ghost-text pill anchored to the caret —
 *      "[arXiv:1234.5678] Foo bar et al · Tab to insert".
 *   4. Tab inserts an inline `citation` element carrying the full search
 *      trace (query, latency, top-k candidates). Esc dismisses.
 *   5. The inserted badge is clickable: a popover surfaces the trace so the
 *      user can audit *why* the agent picked this paper.
 *
 * The plugin owns no React state directly — debounce timer / abort
 * controller live in module-scope refs (one editor per page in this app)
 * and the "active suggestion" payload sits in plugin options so React can
 * react via `usePluginOption`.
 *
 * Yjs note: the inserted citation is a plain Plate element with primitive +
 * JSON-serialisable fields, so the existing @platejs/yjs binding propagates
 * it to all collaborators just like any other inline node.
 */

import * as React from 'react';

import type { PlateEditor } from 'platejs/react';
import {
  createPlatePlugin,
  useEditorPlugin,
  usePluginOption,
} from 'platejs/react';
import { Loader2, Sparkles, X } from 'lucide-react';

import {
  CitationElement,
  type CitationCandidate,
  type TCitationElement,
} from '@/components/ui/citation-node';

// ── Types ──────────────────────────────────────────────────────────────────

interface BackendHit {
  arxiv_id: string;
  chunk_index: number;
  text: string;
  score: number;
  title?: string | null;
  char_start?: number | null;
  char_end?: number | null;
}

interface BackendResponse {
  query: string;
  hits: BackendHit[];
  took_ms: number;
}

interface ActiveSuggestion {
  /** Block id (or fallback path key) the suggestion is anchored to. */
  blockId: string;
  query: string;
  hits: BackendHit[];
  takenMs: number;
  fetchedAt: string;
}

interface CitationSuggestOptions {
  enabled: boolean;
  debounceMs: number;
  /** Don't fire a search until the paragraph has at least this many chars. */
  minChars: number;
  /** How many candidates to ask the backend for. */
  topK: number;
  /** Maximum number of citation badges to insert in one Tab acceptance. */
  maxInsert: number;
  /** Drop candidates whose absolute score falls below this. */
  minScore: number;
  /** Drop candidates whose score gap from the top exceeds this fraction. */
  scoreGap: number;
  /** Currently displayed suggestion, or null. */
  suggestion: ActiveSuggestion | null;
  /** True while a backend request is in flight. */
  pending: boolean;
  /** Last error message, if any. Surfaced inline so the user knows. */
  error: string | null;
}

// ── Module-scope mutable refs (one editor per page) ────────────────────────
// Stored outside plugin options so they don't trigger React re-renders.

const refs = {
  timer: null as ReturnType<typeof setTimeout> | null,
  abort: null as AbortController | null,
  /** Last block + text we observed in onChange. */
  blockId: null as string | null,
  blockText: '',
  /** Last paragraph text we actually issued a search for. */
  lastQueriedText: '',
  /** blockId -> latest fetched suggestion text, used to skip duplicate fetches. */
  resolvedFor: new Map<string, string>(),
};

function clearTimer() {
  if (refs.timer) {
    clearTimeout(refs.timer);
    refs.timer = null;
  }
}

function abortInFlight() {
  if (refs.abort) {
    try {
      refs.abort.abort();
    } catch {
      /* noop */
    }
    refs.abort = null;
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: CitationSuggestOptions = {
  enabled: true,
  debounceMs: 1200,
  minChars: 30,
  topK: 5,
  // Insert up to 3 closely-clustered citations on Tab. Most accepted
  // suggestions become a single badge; we only stack when several hits
  // are nearly tied, which is exactly when picking just one is wrong.
  maxInsert: 3,
  minScore: 0.55,
  scoreGap: 0.08,
  suggestion: null,
  pending: false,
  error: null,
};

export const CitationSuggestPlugin = createPlatePlugin({
  key: 'citationSuggest',
  // Keep a higher priority so our Tab/Esc handlers run before plate's
  // default tab-indent behaviour.
  priority: 200,
  options: DEFAULT_OPTIONS,
  handlers: {
    onChange: ({ editor, getOption, setOption }) => {
      if (!getOption('enabled')) return;

      const blockEntry = editor.api.block({ highest: true });
      if (!blockEntry) return;
      const [blockNode, blockPath] = blockEntry as [
        Record<string, unknown>,
        number[],
      ];

      // Skip code blocks / non-prose blocks.
      const blockType = String(blockNode?.type ?? '');
      if (
        blockType === 'code_block' ||
        blockType === 'code_line' ||
        blockType === 'pre'
      ) {
        if (getOption('suggestion')) setOption('suggestion', null);
        return;
      }

      const blockId =
        (blockNode?.id as string | undefined) ?? blockPath.join('.');
      const text = editor.api.string(blockPath).trim();

      const blockChanged = blockId !== refs.blockId;
      const textChanged = text !== refs.blockText;

      // Cursor moved to a new paragraph — drop any active suggestion that
      // belonged to the previous one.
      if (blockChanged) {
        clearTimer();
        abortInFlight();
        if (getOption('suggestion')) setOption('suggestion', null);
        if (getOption('pending')) setOption('pending', false);
        if (getOption('error')) setOption('error', null);
      }

      refs.blockId = blockId;
      refs.blockText = text;

      // Pure selection move inside the same block — nothing to do.
      if (!textChanged && !blockChanged) return;

      // Text edited — invalidate the suggestion that was for the old text.
      if (textChanged && getOption('suggestion')) {
        setOption('suggestion', null);
      }

      clearTimer();

      if (text.length < getOption('minChars')) return;

      // Avoid re-querying the exact same paragraph twice in a row.
      if (refs.resolvedFor.get(blockId) === text) return;

      const debounce = getOption('debounceMs');
      refs.timer = setTimeout(() => {
        refs.timer = null;
        void runSuggest({
          editor,
          blockId,
          text,
          topK: getOption('topK'),
          setOption,
        });
      }, debounce);
    },

    onKeyDown: ({ event, editor, getOption, setOption }) => {
      const sug = getOption('suggestion');
      if (!sug) return;

      // Accept with Tab (no shift). Esc dismisses.
      if (event.key === 'Tab' && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        acceptSuggestion(editor, sug, {
          maxInsert: getOption('maxInsert'),
          minScore: getOption('minScore'),
          scoreGap: getOption('scoreGap'),
        });
        setOption('suggestion', null);
        refs.lastQueriedText = '';
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOption('suggestion', null);
        // Remember we dismissed this exact text so we don't re-fire instantly.
        if (refs.blockId) refs.resolvedFor.set(refs.blockId, refs.blockText);
        return true;
      }
    },
  },
  render: {
    afterEditable: () => <CitationGhostOverlay />,
  },
}).extendApi(({ editor, setOption }) => ({
  /** Manually dismiss any active suggestion / pending request. */
  dismiss: () => {
    clearTimer();
    abortInFlight();
    setOption('suggestion', null);
    setOption('pending', false);
    setOption('error', null);
  },
  /** Accept the active suggestion programmatically. */
  accept: () => {
    const sug = editor.getOption(CitationSuggestPlugin, 'suggestion');
    if (!sug) return;
    acceptSuggestion(editor, sug, {
      maxInsert: editor.getOption(CitationSuggestPlugin, 'maxInsert'),
      minScore: editor.getOption(CitationSuggestPlugin, 'minScore'),
      scoreGap: editor.getOption(CitationSuggestPlugin, 'scoreGap'),
    });
    setOption('suggestion', null);
  },
}));

// ── Citation node plugin (the inline void element) ─────────────────────────

export const CitationPlugin = createPlatePlugin({
  key: 'citation',
  node: {
    type: 'citation',
    isElement: true,
    isInline: true,
    isVoid: true,
    component: CitationElement,
  },
});

// ── Backend interaction ────────────────────────────────────────────────────

async function runSuggest(args: {
  editor: PlateEditor;
  blockId: string;
  text: string;
  topK: number;
  setOption: <K extends keyof CitationSuggestOptions>(
    key: K,
    value: CitationSuggestOptions[K],
  ) => void;
}) {
  const { editor, blockId, text, topK, setOption } = args;

  abortInFlight();
  refs.abort = new AbortController();
  refs.lastQueriedText = text;

  setOption('pending', true);
  setOption('error', null);

  const startedAt = Date.now();

  try {
    const res = await fetch('/api/citations/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, k: topK }),
      signal: refs.abort.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`backend ${res.status}: ${detail.slice(0, 160)}`);
    }

    const data = (await res.json()) as BackendResponse;

    // Stale: cursor moved off this block while we were waiting.
    if (refs.blockId !== blockId) return;
    // Stale: user kept typing and the text we queried is no longer current.
    if (refs.blockText !== text) return;

    refs.resolvedFor.set(blockId, text);

    if (!data.hits || data.hits.length === 0) {
      // Nothing useful — silently dismiss.
      setOption('suggestion', null);
      return;
    }

    const suggestion: ActiveSuggestion = {
      blockId,
      query: data.query,
      hits: data.hits,
      takenMs: data.took_ms ?? Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
    };

    setOption('suggestion', suggestion);

    // No-op editor reference to silence the unused-var lint while keeping
    // the option open to read editor state in future enhancements.
    void editor;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    const message = err instanceof Error ? err.message : 'search failed';
    setOption('error', message);
  } finally {
    setOption('pending', false);
    refs.abort = null;
  }
}

// ── Acceptance: insert one or more inline citation nodes ───────────────────

interface AcceptOptions {
  maxInsert: number;
  minScore: number;
  scoreGap: number;
}

/**
 * Pick the citations worth inserting from a returned hit list. We keep
 * everything that is (a) above an absolute score floor and (b) within
 * `scoreGap` of the top hit, deduped by paper. This avoids stacking 5
 * near-identical badges when a single concept maps cleanly to one paper,
 * while letting closely-clustered hits all show up together.
 */
function selectAcceptedHits(
  hits: BackendHit[],
  opts: AcceptOptions,
): BackendHit[] {
  if (hits.length === 0) return [];
  const top = hits[0]!;
  const seen = new Set<string>();
  const picked: BackendHit[] = [];
  for (const h of hits) {
    if (picked.length >= opts.maxInsert) break;
    if (h.score < opts.minScore) continue;
    if (top.score - h.score > opts.scoreGap) continue;
    if (seen.has(h.arxiv_id)) continue; // one badge per paper
    seen.add(h.arxiv_id);
    picked.push(h);
  }
  // Fallback: even if filters reject everything, always keep the top hit.
  if (picked.length === 0) picked.push(top);
  return picked;
}

function acceptSuggestion(
  editor: PlateEditor,
  sug: ActiveSuggestion,
  opts: AcceptOptions,
) {
  const accepted = selectAcceptedHits(sug.hits, opts);
  if (accepted.length === 0) return;

  const trace: CitationCandidate[] = sug.hits.map((h) => ({
    arxivId: h.arxiv_id,
    chunkIndex: h.chunk_index,
    title: h.title ?? null,
    score: h.score,
    snippet: h.text ? h.text.slice(0, 600) : null,
  }));

  const nodes: TCitationElement[] = accepted.map((h) => ({
    type: 'citation',
    arxivId: h.arxiv_id,
    chunkIndex: h.chunk_index,
    title: h.title ?? null,
    score: h.score,
    snippet: h.text ? h.text.slice(0, 600) : null,
    query: sug.query,
    takenMs: sug.takenMs,
    searchedAt: sug.fetchedAt,
    trace,
    children: [{ text: '' }],
  }));

  // Insert as separate inline void nodes so each is independently clickable.
  editor.tf.insertNodes(nodes);
  try {
    editor.tf.move({ unit: 'offset' });
  } catch {
    /* selection may already be past the void */
  }
}

// ── Floating ghost overlay ─────────────────────────────────────────────────

function CitationGhostOverlay() {
  const { editor } = useEditorPlugin(CitationSuggestPlugin);
  const suggestion = usePluginOption(CitationSuggestPlugin, 'suggestion');
  const pending = usePluginOption(CitationSuggestPlugin, 'pending');
  const error = usePluginOption(CitationSuggestPlugin, 'error');
  const maxInsert = usePluginOption(CitationSuggestPlugin, 'maxInsert');
  const minScore = usePluginOption(CitationSuggestPlugin, 'minScore');
  const scoreGap = usePluginOption(CitationSuggestPlugin, 'scoreGap');

  const accepted = React.useMemo(
    () =>
      suggestion
        ? selectAcceptedHits(suggestion.hits, { maxInsert, minScore, scoreGap })
        : [],
    [suggestion, maxInsert, minScore, scoreGap],
  );

  const visible = !!suggestion || pending || !!error;
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(
    null,
  );

  // Recompute caret position whenever visibility flips, on scroll/resize, or
  // on selection change while visible.
  React.useEffect(() => {
    if (!visible) {
      setPos(null);
      return;
    }

    const update = () => {
      const rect = currentCaretRect();
      if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    document.addEventListener('selectionchange', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('selectionchange', update);
    };
  }, [visible]);

  if (!visible || !pos) return null;

  const top = accepted[0];
  const extra = accepted.length - 1;

  return (
    <div
      role="status"
      aria-live="polite"
      // Don't steal focus from the editor when the user clicks the chip.
      onMouseDown={(e) => e.preventDefault()}
      className="pointer-events-auto fixed z-50 flex max-w-[440px] items-center gap-2 rounded-md border border-border bg-background/95 px-2 py-1 text-xs shadow-lg backdrop-blur"
      style={{ top: pos.top, left: pos.left }}
    >
      {pending && !top && (
        <>
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
          <span className="italic text-muted-foreground">
            searching citations…
          </span>
        </>
      )}

      {error && !pending && !top && (
        <>
          <span className="size-1.5 rounded-full bg-red-500" />
          <span className="text-muted-foreground">
            citation search failed: {error}
          </span>
          <button
            type="button"
            className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
            aria-label="Dismiss"
            onClick={() => editor.getApi(CitationSuggestPlugin).dismiss()}
          >
            <X className="size-3" />
          </button>
        </>
      )}

      {top && (
        <>
          <Sparkles className="size-3 shrink-0 text-primary" />
          <span className="max-w-[220px] truncate text-foreground">
            {top.title ?? `arXiv:${top.arxiv_id}`}
          </span>
          {extra > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0 font-mono text-[10px] tabular-nums text-primary">
              +{extra}
            </span>
          )}
          <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
            {(top.score * 100).toFixed(0)}%
          </span>
          <span className="ml-1 flex items-center gap-1 text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] leading-none">
              Tab
            </kbd>
            insert
            <span className="mx-1 opacity-50">·</span>
            <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] leading-none">
              Esc
            </kbd>
          </span>
          <button
            type="button"
            className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
            aria-label="Dismiss"
            onClick={() => editor.getApi(CitationSuggestPlugin).dismiss()}
          >
            <X className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}

function currentCaretRect(): DOMRect | null {
  if (typeof window === 'undefined') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  let rect = range.getBoundingClientRect();

  // Empty leaf / start-of-block: the range rect is zero-sized. Fall back to
  // the focus container's rect so the chip still anchors sensibly.
  if (rect.width === 0 && rect.height === 0) {
    const node = sel.focusNode as Node | null;
    const el = (node?.nodeType === 1 ? node : node?.parentNode) as Element | null;
    if (el) rect = el.getBoundingClientRect();
  }
  return rect;
}

// ── Public kit ─────────────────────────────────────────────────────────────

/**
 * Spread into the Plate `plugins` array. Order matters: `CitationPlugin`
 * registers the inline void node so its component is mounted; the suggest
 * plugin reads/writes the doc through the same editor.
 */
export const CitationSuggestKit = [CitationPlugin, CitationSuggestPlugin];
