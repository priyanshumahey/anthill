/**
 * Plate <-> Yjs converters that mirror @slate-yjs/core's wire format.
 *
 * IMPORTANT: every Plate / Slate **Element** is encoded as a `Y.XmlText`,
 * NOT a `Y.XmlElement`. Element fields (`type`, `id`, alignment, …) live
 * in the XmlText's *attributes*; children are written into the XmlText's
 * delta (string inserts for text leaves, nested Y.XmlText inserts for
 * element children). Calling `setBlockText` on a Y.XmlElement, or
 * inserting a Y.XmlElement at the top level, makes Plate's editor throw
 * `yText.toDelta is not a function` because the binding expects only
 * `Y.XmlText` siblings.
 *
 * Reference (bundled inside web/node_modules/@slate-yjs/core/dist/index.js):
 *
 *   slateNodesToInsertDelta(nodes) ->
 *     nodes.map(n => Text.isText(n)
 *       ? { insert: n.text, attributes: marks(n) }
 *       : { insert: slateElementToYText(n) })
 *
 *   slateElementToYText({ children, ...attrs }) ->
 *     const t = new Y.XmlText();
 *     for (const [k,v] of Object.entries(attrs)) t.setAttribute(k, v);
 *     t.applyDelta(slateNodesToInsertDelta(children), { sanitize: false });
 *     return t;
 */

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

// ──────────────────────────────────────────────────────────────────
// Plate value → Yjs (write side)
// ──────────────────────────────────────────────────────────────────

/**
 * Build a `Y.XmlText` for a single Plate block. The returned XmlText is
 * detached and ready to be inserted into a parent (fragment / parent
 * delta) inside a `Y.transact`.
 */
export function plateBlockToYText(block: PlateBlock): Y.XmlText {
  const yt = new Y.XmlText();

  // Element-level attrs (type + everything except children).
  for (const [k, v] of Object.entries(block)) {
    if (k === 'children') continue;
    if (v === undefined) continue;
    yt.setAttribute(k, v);
  }

  // Children → delta. `sanitize: false` matches slate-yjs.
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

// ──────────────────────────────────────────────────────────────────
// Yjs → Plate value (read side)
// ──────────────────────────────────────────────────────────────────

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
    // Y.XmlElement at the top level is illegal for Plate; we skip them so
    // a half-broken doc still renders something sensible.
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Returns the `Y.XmlText` block at ordinal index `i` (0-based) in the
 * fragment, or `null`. Stable refs `b<i+1>` map via this function. Only
 * counts `Y.XmlText` siblings — strays of any other kind are skipped.
 *
 * `index` in the return value is the *positional* index in the fragment
 * (suitable for fragment.delete / insert), NOT the XmlText ordinal.
 */
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

/**
 * Like getBlockByRef but for the *positional* slot AFTER the Nth XmlText
 * sibling, used by insertBlocksAfter. Returns the positional index
 * suitable for fragment.insert.
 */
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
    });
    i++;
  }
  return out;
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
      } else if (Array.isArray((c as PlateBlock).children)) {
        walk((c as PlateBlock).children);
      }
    }
  };
  walk(block.children);
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ──────────────────────────────────────────────────────────────────
// Convenience
// ──────────────────────────────────────────────────────────────────

export function plateParagraph(
  text: string,
  attrs: Record<string, unknown> = {},
): PlateBlock {
  return { type: 'p', children: [{ text }], ...attrs };
}

/**
 * Replace the entire text content of an existing block (Y.XmlText). Wipes
 * children and drops formatting. Caller must already be inside
 * `Y.transact`.
 */
export function setYTextPlainText(yt: Y.XmlText, text: string): void {
  if (yt.length > 0) yt.delete(0, yt.length);
  if (text) yt.insert(0, text);
}

/**
 * Strip every top-level `Y.XmlElement` sibling from the fragment. Plate
 * cannot render them and the editor crashes with `yText.toDelta is not a
 * function`. Used by the cleanup script and as a defensive sweep before
 * any read-back. Caller must wrap in `Y.transact`.
 */
export function pruneIllegalChildren(fragment: Y.XmlFragment): number {
  let removed = 0;
  // Walk from the end so positional indexes remain valid.
  const arr = fragment.toArray();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!(arr[i] instanceof Y.XmlText)) {
      fragment.delete(i, 1);
      removed++;
    }
  }
  return removed;
}
