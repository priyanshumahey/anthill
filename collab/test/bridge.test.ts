/**
 * Pure-logic tests for the agent bridge.
 *
 * These exercise plate-yjs converters, op application, idempotency, and
 * revision tokens in isolation (no HTTP, no Hocuspocus, no Supabase).
 *
 * The HTTP-level integration test lives in `bridge-http.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';

import {
  blockCountOf,
  fragmentToPlateValue,
  getBlockByRef,
  getContentFragment,
  plateBlockToYText,
  plateParagraph,
  pruneIllegalChildren,
  snapshotBlocks,
  yTextToPlateBlock,
} from '../src/plate-yjs';
import { applyOps, BridgeOpError } from '../src/agent-ops';
import { computeRevision } from '../src/revision';
import { IdempotencyCache } from '../src/idempotency';
import type { AgentIdentity, EditOp, PlateBlock } from '../src/types';

function freshDoc(initial?: PlateBlock[]): Y.Doc {
  const doc = new Y.Doc();
  if (initial) {
    const fragment = getContentFragment(doc);
    Y.transact(doc, () => {
      fragment.insert(
        0,
        initial.map((b) => plateBlockToYText(b)),
      );
    });
  }
  return doc;
}

const AGENT: AgentIdentity = { agentId: 'test', runId: 'run-1' };

// ──────────────────────────────────────────────────────────────────
// plate-yjs converters
// ──────────────────────────────────────────────────────────────────

describe('plate-yjs', () => {
  test('round-trips a simple paragraph', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'Hello world' }] },
    ]);
    const value = fragmentToPlateValue(getContentFragment(doc));
    expect(value).toHaveLength(1);
    expect(value[0].type).toBe('p');
    expect(value[0].children).toEqual([{ text: 'Hello world' }]);
  });

  test('round-trips block attributes', () => {
    const doc = freshDoc([
      {
        type: 'h1',
        align: 'center',
        children: [{ text: 'Title' }],
      },
    ]);
    const value = fragmentToPlateValue(getContentFragment(doc));
    expect(value[0].align).toBe('center');
  });

  test('round-trips formatting marks', () => {
    const doc = freshDoc([
      {
        type: 'p',
        children: [
          { text: 'plain ' },
          { text: 'bold', bold: true },
          { text: ' end' },
        ],
      },
    ]);
    const block = fragmentToPlateValue(getContentFragment(doc))[0];
    expect(block.children).toEqual([
      { text: 'plain ' },
      { text: 'bold', bold: true },
      { text: ' end' },
    ]);
  });

  test('serializes structured attrs and reads them back', () => {
    const doc = freshDoc([
      {
        type: 'p',
        meta: { foo: 'bar' },
        children: [{ text: 'x' }],
      },
    ]);
    const block = fragmentToPlateValue(getContentFragment(doc))[0];
    expect(block.meta).toEqual({ foo: 'bar' });
  });

  test('snapshot blocks have stable ordinal refs', () => {
    const doc = freshDoc([
      { type: 'h1', children: [{ text: 'Title' }] },
      { type: 'p', children: [{ text: 'Para' }] },
    ]);
    const snapshot = snapshotBlocks(getContentFragment(doc));
    expect(snapshot.map((b) => b.ref)).toEqual(['b1', 'b2']);
    expect(snapshot[0].text).toBe('Title');
    expect(snapshot[1].type).toBe('p');
  });

  test('getBlockByRef resolves valid and rejects invalid refs', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'a' }] },
      { type: 'p', children: [{ text: 'b' }] },
    ]);
    const fragment = getContentFragment(doc);
    expect(getBlockByRef(fragment, 'b1')?.index).toBe(0);
    expect(getBlockByRef(fragment, 'b2')?.index).toBe(1);
    expect(getBlockByRef(fragment, 'b3')).toBeNull();
    expect(getBlockByRef(fragment, 'banana')).toBeNull();
    expect(getBlockByRef(fragment, 'b0')).toBeNull();
  });

  test('blockCount and snapshot agree', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'a' }] },
      { type: 'p', children: [{ text: 'b' }] },
      { type: 'p', children: [{ text: 'c' }] },
    ]);
    expect(blockCountOf(getContentFragment(doc))).toBe(3);
    expect(snapshotBlocks(getContentFragment(doc))).toHaveLength(3);
  });

  test('plateParagraph helper builds a flat block', () => {
    const block = plateParagraph('hi');
    expect(block).toEqual({ type: 'p', children: [{ text: 'hi' }] });
  });

  test('xmlElementToPlateBlock-equivalent: empty XmlText reads as empty leaf', () => {
    const doc = new Y.Doc();
    const fragment = getContentFragment(doc);
    Y.transact(doc, () => {
      const yt = new Y.XmlText();
      yt.setAttribute('type', 'p');
      fragment.insert(0, [yt]);
    });
    const yt = getContentFragment(doc).toArray()[0] as Y.XmlText;
    const block = yTextToPlateBlock(yt);
    expect(block.type).toBe('p');
    expect(block.children).toEqual([{ text: '' }]);
  });

  test('top-level Y.XmlElement strays are pruned', () => {
    // Simulate a half-broken doc with a stray XmlElement (Plate would crash).
    const doc = new Y.Doc();
    const fragment = getContentFragment(doc);
    Y.transact(doc, () => {
      fragment.insert(0, [
        plateBlockToYText({ type: 'p', children: [{ text: 'good' }] }),
        new Y.XmlElement('rogue'),
        plateBlockToYText({ type: 'p', children: [{ text: 'also good' }] }),
      ]);
    });
    expect(blockCountOf(fragment)).toBe(2); // already skips the stray
    let pruned = 0;
    Y.transact(doc, () => {
      pruned = pruneIllegalChildren(fragment);
    });
    expect(pruned).toBe(1);
    expect(fragment.toArray().length).toBe(2);
    const value = fragmentToPlateValue(fragment);
    expect(value.map((b) => b.children)).toEqual([
      [{ text: 'good' }],
      [{ text: 'also good' }],
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────
// edit ops
// ──────────────────────────────────────────────────────────────────

describe('agent-ops.applyOps', () => {
  test('rejects empty ops array', () => {
    const doc = freshDoc();
    expect(() => applyOps(doc, AGENT, [])).toThrow(BridgeOpError);
  });

  test('appendBlocks adds blocks at the end with provenance', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'first' }] },
    ]);
    const result = applyOps(doc, AGENT, [
      {
        type: 'appendBlocks',
        blocks: [
          plateParagraph('second'),
          plateParagraph('third'),
        ],
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.newRefs).toEqual(['b2', 'b3']);

    const blocks = snapshotBlocks(getContentFragment(doc));
    expect(blocks.map((b) => b.text)).toEqual(['first', 'second', 'third']);
    expect(blocks[1].proof?.author).toBe('ai:test');
    expect(blocks[1].proof?.runId).toBe('run-1');
    expect(blocks[0].proof).toBeUndefined();
  });

  test('insertBlocksAfter inserts at the right position', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'A' }] },
      { type: 'p', children: [{ text: 'C' }] },
    ]);
    applyOps(doc, AGENT, [
      { type: 'insertBlocksAfter', afterRef: 'b1', blocks: [plateParagraph('B')] },
    ]);
    expect(snapshotBlocks(getContentFragment(doc)).map((b) => b.text)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  test('insertBlocksBefore inserts at the right position', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'B' }] },
    ]);
    applyOps(doc, AGENT, [
      { type: 'insertBlocksBefore', beforeRef: 'b1', blocks: [plateParagraph('A')] },
    ]);
    expect(snapshotBlocks(getContentFragment(doc)).map((b) => b.text)).toEqual([
      'A',
      'B',
    ]);
  });

  test('replaceBlock replaces in-place', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'old' }] },
    ]);
    const result = applyOps(doc, AGENT, [
      { type: 'replaceBlock', ref: 'b1', blocks: [plateParagraph('new')] },
    ]);
    expect(result.newRefs).toEqual(['b1']);
    expect(snapshotBlocks(getContentFragment(doc))[0].text).toBe('new');
  });

  test('deleteBlock removes a block', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'A' }] },
      { type: 'p', children: [{ text: 'B' }] },
    ]);
    applyOps(doc, AGENT, [{ type: 'deleteBlock', ref: 'b1' }]);
    const blocks = snapshotBlocks(getContentFragment(doc));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('B');
  });

  test('setBlockText overwrites existing text', () => {
    const doc = freshDoc([
      { type: 'p', children: [{ text: 'old' }] },
    ]);
    applyOps(doc, AGENT, [{ type: 'setBlockText', ref: 'b1', text: 'updated' }]);
    expect(snapshotBlocks(getContentFragment(doc))[0].text).toBe('updated');
  });

  test('throws BLOCK_REF_NOT_FOUND for missing ref', () => {
    const doc = freshDoc();
    expect(() =>
      applyOps(doc, AGENT, [{ type: 'deleteBlock', ref: 'b99' }]),
    ).toThrow('b99');
  });

  test('throws BAD_REQUEST for missing block type', () => {
    const doc = freshDoc();
    expect(() =>
      applyOps(doc, AGENT, [
        // @ts-expect-error — intentional bad payload
        { type: 'appendBlocks', blocks: [{ children: [{ text: 'x' }] }] },
      ]),
    ).toThrow('type');
  });

  test('setTitle calls the setTitle callback once', () => {
    const doc = freshDoc();
    let titleSeen: string | null = null;
    applyOps(
      doc,
      AGENT,
      [{ type: 'setTitle', title: 'New title' }] as EditOp[],
      { setTitle: (t) => (titleSeen = t) },
    );
    expect(titleSeen).toBe('New title');
  });

  test('all-or-nothing: a failing op rolls back the whole batch', () => {
    const doc = freshDoc([{ type: 'p', children: [{ text: 'one' }] }]);
    expect(() =>
      applyOps(doc, AGENT, [
        { type: 'appendBlocks', blocks: [plateParagraph('two')] },
        { type: 'deleteBlock', ref: 'bxxx' }, // invalid ref → throws inside transact
      ]),
    ).toThrow();
    // The bad ref is caught by validateOps before any mutation runs, so the
    // doc is unchanged.
    const blocks = snapshotBlocks(getContentFragment(doc));
    expect(blocks.map((b) => b.text)).toEqual(['one']);
  });

  test('mutations carry the bridge origin tag', () => {
    const doc = freshDoc();
    // Touch the fragment so any Yjs-internal type-init transactions fire
    // BEFORE we attach the listener. We only care about applyOps's own.
    getContentFragment(doc);
    const seen: unknown[] = [];
    doc.on('afterTransaction', (tx) => seen.push(tx.origin));
    applyOps(doc, AGENT, [
      { type: 'appendBlocks', blocks: [plateParagraph('x')] },
    ], { idempotencyKey: 'idem-1' });
    const ours = seen.find(
      (o) => o && typeof o === 'object' && (o as { source?: string }).source === 'agent-bridge',
    ) as { source?: string; agentId?: string; idempotencyKey?: string } | undefined;
    expect(ours).toBeDefined();
    expect(ours!.source).toBe('agent-bridge');
    expect(ours!.agentId).toBe('test');
    expect(ours!.idempotencyKey).toBe('idem-1');
  });
});

// ──────────────────────────────────────────────────────────────────
// revision
// ──────────────────────────────────────────────────────────────────

describe('revision', () => {
  test('changes when document mutates', () => {
    const doc = freshDoc();
    const r1 = computeRevision(doc);
    applyOps(doc, AGENT, [
      { type: 'appendBlocks', blocks: [plateParagraph('x')] },
    ]);
    const r2 = computeRevision(doc);
    expect(r2).not.toBe(r1);
    expect(r1.startsWith('rev1_')).toBe(true);
    expect(r2.startsWith('rev1_')).toBe(true);
  });

  test('stable when nothing mutates', () => {
    const doc = freshDoc([{ type: 'p', children: [{ text: 'a' }] }]);
    expect(computeRevision(doc)).toBe(computeRevision(doc));
  });
});

// ──────────────────────────────────────────────────────────────────
// idempotency
// ──────────────────────────────────────────────────────────────────

describe('idempotency cache', () => {
  test('returns cached entries for matching body hash', () => {
    const cache = new IdempotencyCache<string>();
    const body = { ops: [{ type: 'append' }] };
    const hash = IdempotencyCache.hashBody(body);
    cache.put('k1', hash, 200, 'first response');
    const got = cache.get('k1');
    expect(got?.response).toBe('first response');
    expect(got?.bodyHash).toBe(hash);
  });

  test('hashBody is stable across key order', () => {
    const a = IdempotencyCache.hashBody({ a: 1, b: 2 });
    const b = IdempotencyCache.hashBody({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test('hashBody differs for different content', () => {
    const a = IdempotencyCache.hashBody({ ops: [{ type: 'x' }] });
    const b = IdempotencyCache.hashBody({ ops: [{ type: 'y' }] });
    expect(a).not.toBe(b);
  });

  test('expired entries are evicted lazily', () => {
    const cache = new IdempotencyCache<string>(0); // immediately expires
    cache.put('k', 'h', 200, 'r');
    expect(cache.get('k')).toBeNull();
  });
});
