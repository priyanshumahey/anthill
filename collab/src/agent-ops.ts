import * as Y from 'yjs';

import type {
  AgentIdentity,
  BridgeOrigin,
  EditOp,
  PlateBlock,
} from './types';
import {
  appendInlineElements,
  blockCountOf,
  extractInlineElements,
  getBlockByRef,
  getContentFragment,
  plateBlockToYText,
  positionAfterRef,
  setBlockTextPreservingInlines,
  yTextToPlateBlock,
} from './plate-yjs';

export interface ApplyOpsResult {
  applied: number;
  newRefs: string[];
  /** How many inline elements (citations, ...) were auto-preserved across
   *  destructive ops in this batch. */
  preservedInlines: number;
}

export class BridgeOpError extends Error {
  constructor(
    public readonly code:
      | 'BAD_REQUEST'
      | 'BLOCK_REF_NOT_FOUND'
      | 'INLINE_ELEMENTS_WOULD_BE_LOST'
      | 'INTERNAL_ERROR',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BridgeOpError';
  }
}

export function applyOps(
  doc: Y.Doc,
  identity: AgentIdentity,
  ops: EditOp[],
  meta: { idempotencyKey?: string; setTitle?: (title: string) => void } = {},
): ApplyOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new BridgeOpError('BAD_REQUEST', 'ops must be a non-empty array');
  }

  validateOps(ops);

  const fragment = getContentFragment(doc);
  const origin: BridgeOrigin = {
    source: 'agent-bridge',
    agentId: identity.agentId,
    runId: identity.runId,
    idempotencyKey: meta.idempotencyKey,
  };

  let pendingTitle: string | null = null;
  const newRefs: string[] = [];
  let preservedInlines = 0;

  const undoManager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set<unknown>([origin]),
    captureTimeout: 0,
  });

  let opError: unknown = null;
  Y.transact(
    doc,
    () => {
      try {
      for (const op of ops) {
        switch (op.type) {
          case 'appendBlocks': {
            const startCount = blockCountOf(fragment);
            const els = op.blocks.map((b) =>
              plateBlockToYText(stampProvenance(b, identity)),
            );
            fragment.insert(fragment.length, els);
            for (let i = 0; i < els.length; i++) {
              newRefs.push(`b${startCount + i + 1}`);
            }
            break;
          }
          case 'insertBlocksAfter': {
            const insertAt = positionAfterRef(fragment, op.afterRef);
            if (insertAt === null) {
              throw new BridgeOpError(
                'BLOCK_REF_NOT_FOUND',
                `afterRef ${op.afterRef} not found`,
                { ref: op.afterRef },
              );
            }
            const anchorOrdinal = ordinalOfRef(op.afterRef);
            const els = op.blocks.map((b) =>
              plateBlockToYText(stampProvenance(b, identity)),
            );
            fragment.insert(insertAt, els);
            for (let i = 0; i < els.length; i++) {
              newRefs.push(`b${anchorOrdinal + 1 + i}`);
            }
            break;
          }
          case 'insertBlocksBefore': {
            const found = getBlockByRef(fragment, op.beforeRef);
            if (!found) {
              throw new BridgeOpError(
                'BLOCK_REF_NOT_FOUND',
                `beforeRef ${op.beforeRef} not found`,
                { ref: op.beforeRef },
              );
            }
            const beforeOrdinal = ordinalOfRef(op.beforeRef);
            const els = op.blocks.map((b) =>
              plateBlockToYText(stampProvenance(b, identity)),
            );
            fragment.insert(found.index, els);
            for (let i = 0; i < els.length; i++) {
              newRefs.push(`b${beforeOrdinal + i}`);
            }
            break;
          }
          case 'replaceBlock': {
            const found = getBlockByRef(fragment, op.ref);
            if (!found) {
              throw new BridgeOpError(
                'BLOCK_REF_NOT_FOUND',
                `ref ${op.ref} not found`,
                { ref: op.ref },
              );
            }
            const refOrdinal = ordinalOfRef(op.ref);
            // Snapshot any inline children (citations, ...) before the
            // original block disappears, so we can re-attach them to the
            // last new block. Agents almost never know these exist when
            // they call replaceBlock based on the text preview.
            const carriedInlines = op.dropInlineElements
              ? []
              : extractInlineElements(yTextToPlateBlock(found.element));
            const els = op.blocks.map((b) =>
              plateBlockToYText(stampProvenance(b, identity)),
            );
            fragment.delete(found.index, 1);
            fragment.insert(found.index, els);
            for (let i = 0; i < els.length; i++) {
              newRefs.push(`b${refOrdinal + i}`);
            }
            if (carriedInlines.length > 0 && els.length > 0) {
              appendInlineElements(els[els.length - 1]!, carriedInlines);
              preservedInlines += carriedInlines.length;
            }
            break;
          }
          case 'deleteBlock': {
            const found = getBlockByRef(fragment, op.ref);
            if (!found) {
              throw new BridgeOpError(
                'BLOCK_REF_NOT_FOUND',
                `ref ${op.ref} not found`,
                { ref: op.ref },
              );
            }
            if (!op.dropInlineElements) {
              const inlines = extractInlineElements(
                yTextToPlateBlock(found.element),
              );
              if (inlines.length > 0) {
                throw new BridgeOpError(
                  'INLINE_ELEMENTS_WOULD_BE_LOST',
                  `block ${op.ref} carries ${inlines.length} inline element(s) (e.g. citations); pass "dropInlineElements": true to delete anyway, or replaceBlock with a block that re-uses them`,
                  {
                    ref: op.ref,
                    inlineTypes: inlines.map((i) => i.type),
                  },
                );
              }
            }
            fragment.delete(found.index, 1);
            break;
          }
          case 'setBlockText': {
            const found = getBlockByRef(fragment, op.ref);
            if (!found) {
              throw new BridgeOpError(
                'BLOCK_REF_NOT_FOUND',
                `ref ${op.ref} not found`,
                { ref: op.ref },
              );
            }
            const kept = setBlockTextPreservingInlines(
              found.element,
              op.text,
              { dropInlines: op.dropInlineElements === true },
            );
            preservedInlines += kept.length;
            found.element.setAttribute(
              'proofTypedBy',
              `ai:${identity.agentId}`,
            );
            if (identity.runId) {
              found.element.setAttribute('proofRunId', identity.runId);
            }
            break;
          }
          case 'setTitle': {
            pendingTitle = op.title;
            break;
          }
          default:
            throw new BridgeOpError(
              'BAD_REQUEST',
              `unknown op type: ${(op as { type: string }).type}`,
            );
        }
      }
      } catch (err) {
        opError = err;
      }
    },
    origin,
  );

  if (opError) {
    try {
      while (undoManager.canUndo()) undoManager.undo();
    } finally {
      undoManager.destroy();
    }
    throw opError;
  }
  undoManager.destroy();

  if (pendingTitle !== null && meta.setTitle) {
    meta.setTitle(pendingTitle);
  }

  return { applied: ops.length, newRefs, preservedInlines };
}

function stampProvenance(
  block: PlateBlock,
  identity: AgentIdentity,
): PlateBlock {
  const stamped: PlateBlock = {
    ...block,
    proofAuthor: `ai:${identity.agentId}`,
  };
  if (identity.runId) stamped.proofRunId = identity.runId;
  if (Array.isArray(block.children)) {
    stamped.children = block.children.map((c) =>
      isPlateBlockLike(c) ? stampProvenance(c as PlateBlock, identity) : c,
    );
  }
  return stamped;
}

function isPlateBlockLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in (value as Record<string, unknown>) &&
    Array.isArray((value as { children?: unknown }).children)
  );
}

function ordinalOfRef(ref: string): number {
  const m = ref.match(/^b(\d+)$/);
  if (!m) return 0;
  return Number(m[1]);
}

function validateOps(ops: EditOp[]): void {
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string') {
      throw new BridgeOpError(
        'BAD_REQUEST',
        `ops[${i}] is missing a type`,
        { index: i },
      );
    }
    switch (op.type) {
      case 'appendBlocks':
      case 'insertBlocksAfter':
      case 'insertBlocksBefore':
      case 'replaceBlock':
        if (!Array.isArray(op.blocks) || op.blocks.length === 0) {
          throw new BridgeOpError(
            'BAD_REQUEST',
            `ops[${i}] (${op.type}) requires a non-empty 'blocks' array`,
            { index: i },
          );
        }
        for (const [j, b] of op.blocks.entries()) {
          if (!b || typeof b !== 'object' || typeof b.type !== 'string') {
            throw new BridgeOpError(
              'BAD_REQUEST',
              `ops[${i}].blocks[${j}] is missing a Plate 'type'`,
              { index: i, block: j },
            );
          }
          if (!Array.isArray(b.children)) {
            throw new BridgeOpError(
              'BAD_REQUEST',
              `ops[${i}].blocks[${j}] is missing a 'children' array`,
              { index: i, block: j },
            );
          }
        }
        break;
      case 'deleteBlock':
      case 'setBlockText':
        if (typeof op.ref !== 'string' || !op.ref) {
          throw new BridgeOpError(
            'BAD_REQUEST',
            `ops[${i}] (${op.type}) requires a 'ref'`,
            { index: i },
          );
        }
        if (op.type === 'setBlockText' && typeof op.text !== 'string') {
          throw new BridgeOpError(
            'BAD_REQUEST',
            `ops[${i}] setBlockText requires a string 'text'`,
            { index: i },
          );
        }
        break;
      case 'insertBlocksAfter':
      case 'insertBlocksBefore':
        break;
      case 'setTitle':
        if (typeof op.title !== 'string' || !op.title.trim()) {
          throw new BridgeOpError(
            'BAD_REQUEST',
            `ops[${i}] setTitle requires a non-empty 'title'`,
            { index: i },
          );
        }
        break;
      default:
        throw new BridgeOpError(
          'BAD_REQUEST',
          `ops[${i}] has unknown type: ${(op as { type: string }).type}`,
          { index: i },
        );
    }
    if (op.type === 'insertBlocksAfter' && typeof op.afterRef !== 'string') {
      throw new BridgeOpError(
        'BAD_REQUEST',
        `ops[${i}] insertBlocksAfter requires 'afterRef'`,
        { index: i },
      );
    }
    if (op.type === 'insertBlocksBefore' && typeof op.beforeRef !== 'string') {
      throw new BridgeOpError(
        'BAD_REQUEST',
        `ops[${i}] insertBlocksBefore requires 'beforeRef'`,
        { index: i },
      );
    }
    if (op.type === 'replaceBlock' && typeof op.ref !== 'string') {
      throw new BridgeOpError(
        'BAD_REQUEST',
        `ops[${i}] replaceBlock requires 'ref'`,
        { index: i },
      );
    }
  }
}
