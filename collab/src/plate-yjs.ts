import * as Y from 'yjs';

import type {
  PlateBlock,
  PlateLeaf,
  PlateValue,
  SnapshotBlock,
} from './types';

const FRAGMENT_NAME = 'content';

const RESERVED_KEYS = new Set(['type', 'children']);

export function getContentFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(FRAGMENT_NAME);
}

export function plateBlockToYText(block: PlateBlock): Y.XmlText {
  const yt = new Y.XmlText();

  for (const [k, v] of Object.entries(block)) {
    if (k === 'children') continue;
    if (v === undefined) continue;
    yt.setAttribute(k, v);
  }

  const children = Array.isArray(block.children) ? block.children : [];
  const delta = childrenToInsertDelta(children);
  if (delta.length > 0) {
    yt.applyDelta(delta, { sanitize: false });
  }

  return yt;
}

interface InsertDeltaOp {
  insert: string | Y.XmlText;
  attributes?: Record<string, unknown>;
}

function childrenToInsertDelta(
  children: (PlateLeaf | PlateBlock)[],
): InsertDeltaOp[] {
  return children.map((c) => {
    if (isPlateBlock(c)) {
      return { insert: plateBlockToYText(c) };
    }
    const leaf = c as PlateLeaf;
    const text = typeof leaf.text === 'string' ? leaf.text : '';
    const marks: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(leaf)) {
      if (k === 'text') continue;
      marks[k] = v;
    }
    const op: InsertDeltaOp = { insert: text };
    if (Object.keys(marks).length > 0) op.attributes = marks;
    return op;
  });
}

function isPlateBlock(value: unknown): value is PlateBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'children' in (value as Record<string, unknown>) &&
    Array.isArray((value as { children?: unknown }).children)
  );
}

/**
 * An inline element child of a paragraph (most importantly, citation badges
 * inserted by the editor's citation-suggest plugin). These are full
 * `PlateBlock` shapes nested inside a parent block's `children`, distinct
 * from text leaves, and the bridge must preserve them across destructive
 * agent edits like `setBlockText` and `replaceBlock` — otherwise an agent
 * that just wants to rewrite the prose ends up silently nuking the
 * provenance metadata that powers the editor's reference list.
 */
export function extractInlineElements(block: PlateBlock): PlateBlock[] {
  if (!Array.isArray(block.children)) return [];
  return block.children.filter(isPlateBlock);
}

/**
 * Replace a block's text with a new run, while keeping any inline element
 * children (citations, etc.) appended after the new text. Pass
 * `dropInlines: true` to recover the legacy "wipe everything" behaviour.
 *
 * Returns the inline elements that were preserved so the caller can
 * surface a count back to the agent.
 */
export function setBlockTextPreservingInlines(
  yt: Y.XmlText,
  text: string,
  opts: { dropInlines?: boolean } = {},
): PlateBlock[] {
  const preserved = opts.dropInlines
    ? []
    : extractInlineElements(yTextToPlateBlock(yt));

  if (yt.length > 0) yt.delete(0, yt.length);
  if (text) yt.insert(0, text);

  if (preserved.length > 0) {
    // Without an explicit `retain`, applyDelta inserts at position 0 and
    // would put the citations BEFORE the freshly inserted text. Retain
    // past the current length so they land at the end of the block.
    const ops: InsertDeltaOp[] = preserved.map((el) => ({
      insert: plateBlockToYText(el),
    }));
    const delta: Array<InsertDeltaOp | { retain: number }> =
      yt.length > 0 ? [{ retain: yt.length }, ...ops] : ops;
    yt.applyDelta(delta as InsertDeltaOp[], { sanitize: false });
  }

  return preserved;
}

/**
 * Append a list of inline elements (cloned via the Plate roundtrip) to the
 * end of `yt`'s content. Used when an agent's `replaceBlock` would
 * otherwise drop citations from the original block.
 */
export function appendInlineElements(
  yt: Y.XmlText,
  inlines: PlateBlock[],
): void {
  if (inlines.length === 0) return;
  const ops: InsertDeltaOp[] = inlines.map((el) => ({
    insert: plateBlockToYText(el),
  }));
  const delta: Array<InsertDeltaOp | { retain: number }> =
    yt.length > 0 ? [{ retain: yt.length }, ...ops] : ops;
  yt.applyDelta(delta as InsertDeltaOp[], { sanitize: false });
}


interface DeltaReadOp {
  insert?: string | Y.XmlText;
  attributes?: Record<string, unknown>;
}

export function yTextToPlateBlock(yt: Y.XmlText): PlateBlock {
  const attrs = yt.getAttributes();
  const block: PlateBlock = { type: 'p', children: [] };
  for (const [k, v] of Object.entries(attrs)) block[k] = v;
  if (typeof block.type !== 'string') block.type = 'p';

  const delta = yt.toDelta() as DeltaReadOp[];
  for (const op of delta) {
    if (typeof op.insert === 'string') {
      const leaf: PlateLeaf = { text: op.insert };
      if (op.attributes) Object.assign(leaf, op.attributes);
      block.children.push(leaf);
    } else if (op.insert instanceof Y.XmlText) {
      block.children.push(yTextToPlateBlock(op.insert));
    }
  }

  if (block.children.length === 0) {
    block.children.push({ text: '' });
  }
  return block;
}

export function fragmentToPlateValue(fragment: Y.XmlFragment): PlateValue {
  const out: PlateValue = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) {
      out.push(yTextToPlateBlock(child));
    }
  }
  return out;
}

export function getBlockByRef(
  fragment: Y.XmlFragment,
  ref: string,
): { index: number; element: Y.XmlText } | null {
  const m = ref.match(/^b(\d+)$/);
  if (!m) return null;
  const ordinal = Number(m[1]);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  const target = ordinal - 1;
  let textCursor = 0;
  let positional = 0;
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) {
      if (textCursor === target) {
        return { index: positional, element: child };
      }
      textCursor++;
    }
    positional++;
  }
  return null;
}

export function positionAfterRef(
  fragment: Y.XmlFragment,
  ref: string,
): number | null {
  const found = getBlockByRef(fragment, ref);
  if (!found) return null;
  return found.index + 1;
}

export function snapshotBlocks(fragment: Y.XmlFragment): SnapshotBlock[] {
  const out: SnapshotBlock[] = [];
  let i = 1;
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    const block = yTextToPlateBlock(child);
    const inlines = inlineSummariesOf(block);
    const text = previewText(block);
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(block)) {
      if (RESERVED_KEYS.has(k)) continue;
      if (k === 'proofAuthor' || k === 'proofRunId' || k === 'proofTypedBy') {
        continue;
      }
      attrs[k] = v;
    }
    const proof =
      block.proofAuthor || block.proofTypedBy
        ? {
            author: (block.proofAuthor as string | undefined) ??
              (block.proofTypedBy as string | undefined),
            runId: block.proofRunId as string | undefined,
          }
        : undefined;
    out.push({
      ref: `b${i}`,
      type: typeof block.type === 'string' ? block.type : 'p',
      text,
      attrs,
      proof,
      inlines: inlines.length > 0 ? inlines : undefined,
    });
    i++;
  }
  return out;
}

/**
 * Per-inline-element summary surfaced in snapshots so an agent can see what
 * non-text children live inside a block (citations, mentions, etc.) and
 * decide whether/how to preserve them on a destructive edit.
 */
function inlineSummariesOf(
  block: PlateBlock,
): Array<{ type: string; label?: string; attrs: Record<string, unknown> }> {
  const out: Array<{
    type: string;
    label?: string;
    attrs: Record<string, unknown>;
  }> = [];
  for (const child of block.children) {
    if (!isPlateBlockChild(child)) continue;
    const c = child as PlateBlock;
    const type = typeof c.type === 'string' ? c.type : 'inline';
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === 'type' || k === 'children') continue;
      attrs[k] = v;
    }
    out.push({ type, label: inlineLabelFor(type, attrs), attrs });
  }
  return out;
}

function isPlateBlockChild(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'children' in (value as Record<string, unknown>) &&
    Array.isArray((value as { children?: unknown }).children)
  );
}

function inlineLabelFor(
  type: string,
  attrs: Record<string, unknown>,
): string | undefined {
  if (type === 'citation') {
    const arxivId = typeof attrs.arxivId === 'string' ? attrs.arxivId : null;
    if (arxivId) return `[cite:arXiv:${arxivId}]`;
  }
  return undefined;
}

export function blockCountOf(fragment: Y.XmlFragment): number {
  let n = 0;
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) n++;
  }
  return n;
}

function previewText(block: PlateBlock): string {
  const parts: string[] = [];
  const walk = (children: (PlateLeaf | PlateBlock)[]) => {
    for (const c of children) {
      if ('text' in c && typeof c.text === 'string') {
        parts.push(c.text);
        continue;
      }
      const inlineType = (c as PlateBlock).type;
      if (typeof inlineType === 'string') {
        const label = inlineLabelFor(
          inlineType,
          c as unknown as Record<string, unknown>,
        );
        if (label) {
          parts.push(label);
          continue;
        }
      }
      if (Array.isArray((c as PlateBlock).children)) {
        walk((c as PlateBlock).children);
      }
    }
  };
  walk(block.children);
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 240);
}


export function plateParagraph(
  text: string,
  attrs: Record<string, unknown> = {},
): PlateBlock {
  return { type: 'p', children: [{ text }], ...attrs };
}

export function setYTextPlainText(yt: Y.XmlText, text: string): void {
  if (yt.length > 0) yt.delete(0, yt.length);
  if (text) yt.insert(0, text);
}

export function pruneIllegalChildren(fragment: Y.XmlFragment): number {
  let removed = 0;
  const arr = fragment.toArray();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!(arr[i] instanceof Y.XmlText)) {
      fragment.delete(i, 1);
      removed++;
    }
  }
  return removed;
}
