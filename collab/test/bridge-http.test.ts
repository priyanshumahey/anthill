import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';

import { AgentBridge } from '../src/agent-bridge';
import type { EditResponse, SnapshotResponse, StateResponse } from '../src/types';


const KNOWN_DOC_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_DOC_ID = '00000000-0000-4000-8000-0000000000ff';

let storedTitle: string | null = 'Initial title';
const titleUpdates: { title: string; at: string }[] = [];

const fakeSupabase = {
  from(table: string) {
    if (table !== 'documents') {
      throw new Error(`unexpected table: ${table}`);
    }
    let mode: 'select' | 'update' | null = null;
    let updatePatch: Record<string, unknown> = {};
    let filterId: string | null = null;
    return {
      select(_cols: string) {
        mode = 'select';
        return this;
      },
      update(patch: Record<string, unknown>) {
        mode = 'update';
        updatePatch = patch;
        return this;
      },
      eq(_col: string, value: string) {
        filterId = value;
        return this;
      },
      async maybeSingle() {
        if (mode !== 'select') throw new Error('unexpected maybeSingle');
        if (filterId === KNOWN_DOC_ID) {
          return { data: { id: KNOWN_DOC_ID, title: storedTitle }, error: null };
        }
        return { data: null, error: null };
      },
      async single() {
        const r = await this.maybeSingle();
        return r;
      },
      then(resolve: (value: { data: null; error: null }) => unknown) {
        if (mode === 'update' && filterId === KNOWN_DOC_ID) {
          if (typeof updatePatch.title === 'string') {
            storedTitle = updatePatch.title as string;
            titleUpdates.push({
              title: updatePatch.title as string,
              at: (updatePatch.updated_at as string) ?? new Date().toISOString(),
            });
          }
        }
        resolve({ data: null, error: null });
        return this;
      },
    };
  },
};

let server: Server | undefined;
let bridge: AgentBridge | undefined;
let baseUrl = '';
const BRIDGE_PORT = 18889;
const HP_PORT = 18888;
const SECRET = 'test-secret';

beforeAll(async () => {
  const hp = new Server({ port: HP_PORT, name: 'test-collab', quiet: true });
  server = hp;
  await hp.listen();

  bridge = new AgentBridge({
    port: BRIDGE_PORT,
    hocuspocus: hp.hocuspocus,
    supabase: fakeSupabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    auth: { sharedSecret: SECRET, enforceIdentity: true },
  });
  bridge.start();
  baseUrl = `http://localhost:${BRIDGE_PORT}`;
});

afterAll(async () => {
  await bridge?.stop();
  await server?.destroy();
});

interface FetchOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  noAuth?: boolean;
}

async function call<T = unknown>(
  path: string,
  opts: FetchOpts = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (!opts.noAuth) {
    headers['x-agent-token'] = headers['x-agent-token'] ?? SECRET;
    headers['x-agent-id'] = headers['x-agent-id'] ?? 'test-agent';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, body };
}


describe('agent bridge HTTP', () => {
  test('GET /healthz works without auth', async () => {
    const r = await call<{ status: string; version: string }>('/healthz', {
      noAuth: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  test('GET /.well-known/agent.json advertises ops', async () => {
    const r = await call<{ ops: string[]; protocol: string; endpoints: Record<string, string> }>(
      '/.well-known/agent.json',
      { noAuth: true },
    );
    expect(r.status).toBe(200);
    expect(r.body.protocol).toBe('anthill-agent-bridge/1');
    expect(r.body.ops).toContain('appendBlocks');
    expect(r.body.endpoints.snapshot).toBe('/documents/{id}/snapshot');
  });

  test('rejects requests missing the shared secret', async () => {
    const r = await call(`/documents/${KNOWN_DOC_ID}/snapshot`, { noAuth: true });
    expect(r.status).toBe(401);
  });

  test('rejects edit requests missing the agent id', async () => {
    const r = await call(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      body: { ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'x' }] }] }] },
      headers: { 'x-agent-token': SECRET },
      noAuth: true,
    });
    expect(r.status).toBe(401);
  });

  test('returns 404 for unknown documents', async () => {
    const r = await call(`/documents/${MISSING_DOC_ID}/snapshot`);
    expect(r.status).toBe(404);
  });

  test('snapshot of an empty doc has zero blocks', async () => {
    const r = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    expect(r.status).toBe(200);
    expect(r.body.blockCount).toBe(0);
    expect(r.body.blocks).toEqual([]);
    expect(r.body.baseRevision.startsWith('rev1_')).toBe(true);
  });

  test('appendBlocks then snapshot reflects the change with provenance', async () => {
    const edit = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'append-1', 'x-agent-id': 'test-agent', 'x-agent-run-id': 'r1' },
      body: {
        ops: [
          {
            type: 'appendBlocks',
            blocks: [
              { type: 'h1', children: [{ text: 'Hello' }] },
              { type: 'p', children: [{ text: 'World' }] },
            ],
          },
        ],
      },
    });
    expect(edit.status).toBe(200);
    expect(edit.body.applied).toBe(1);
    expect(edit.body.newRefs).toEqual(['b1', 'b2']);
    expect(edit.body.blockCount).toBe(2);

    const snap = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    expect(snap.body.blocks.map((b) => b.text)).toEqual(['Hello', 'World']);
    expect(snap.body.blocks[0].proof?.author).toBe('ai:test-agent');
    expect(snap.body.blocks[0].proof?.runId).toBe('r1');
  });

  test('idempotency replay returns the cached response', async () => {
    const body = {
      ops: [
        {
          type: 'appendBlocks',
          blocks: [{ type: 'p', children: [{ text: 'idem-test' }] }],
        },
      ],
    };
    const first = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-key-1' },
      body,
    });
    const beforeCount = first.body.blockCount;

    const replay = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-key-1' },
      body,
    });
    expect(replay.body.blockCount).toBe(beforeCount);
    expect(replay.body.newRefs).toEqual(first.body.newRefs);
  });

  test('idempotency key reuse with different body returns 409', async () => {
    await call(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-clash' },
      body: { ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'A' }] }] }] },
    });
    const r = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-clash' },
      body: { ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'B' }] }] }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY');
  });

  test('stale baseRevision is rejected with 409', async () => {
    const snap = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    await call(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'mutate-then-stale' },
      body: { ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'shift' }] }] }] },
    });
    const r = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'stale-attempt' },
      body: {
        baseRevision: snap.body.baseRevision,
        ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'late' }] }] }],
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('STALE_REVISION');
  });

  test('missing block ref returns 404 BLOCK_REF_NOT_FOUND', async () => {
    const r = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'bad-ref' },
      body: { ops: [{ type: 'deleteBlock', ref: 'b9999' }] },
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('BLOCK_REF_NOT_FOUND');
  });

  test('setTitle persists via Supabase patch', async () => {
    const before = titleUpdates.length;
    const r = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'title-1' },
      body: { ops: [{ type: 'setTitle', title: 'Renamed by agent' }] },
    });
    expect(r.status).toBe(200);
    expect(titleUpdates.length).toBe(before + 1);
    expect(titleUpdates.at(-1)?.title).toBe('Renamed by agent');
  });

  test('GET /state returns the full Plate value', async () => {
    const r = await call<StateResponse>(`/documents/${KNOWN_DOC_ID}/state`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.value)).toBe(true);
    expect(r.body.value.length).toBeGreaterThan(0);
    expect(r.body.value[0].type).toBeDefined();
  });

  test('presence write succeeds and round-trips via /state read after', async () => {
    const r = await call(`/documents/${KNOWN_DOC_ID}/presence`, {
      method: 'POST',
      body: { status: 'thinking', message: 'about citations' },
    });
    expect(r.status).toBe(200);
  });

  test('appendInline adds a citation to an existing block', async () => {
    // Append a fresh paragraph we can safely cite.
    const append = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'cite-anchor' },
      body: {
        ops: [
          {
            type: 'appendBlocks',
            blocks: [
              {
                type: 'p',
                children: [{ text: 'Transformers dominate sequence modelling tasks.' }],
              },
            ],
          },
        ],
      },
    });
    const anchorRef = append.body.newRefs[0]!;

    const cite = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'cite-insert' },
      body: {
        ops: [
          {
            type: 'appendInline',
            ref: anchorRef,
            element: {
              type: 'citation',
              arxivId: '1706.03762',
              chunkIndex: 0,
              title: 'Attention Is All You Need',
              score: 0.92,
              children: [{ text: '' }],
            },
          },
        ],
      },
    });
    expect(cite.status).toBe(200);
    expect(cite.body.applied).toBe(1);

    const snap = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    const block = snap.body.blocks.find((b) => b.ref === anchorRef);
    expect(block?.inlines?.[0]?.type).toBe('citation');
    expect(block?.inlines?.[0]?.label).toBe('[cite:arXiv:1706.03762]');
  });

  test('appendInline on a missing ref returns 404', async () => {
    const r = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'cite-bad-ref' },
      body: {
        ops: [
          {
            type: 'appendInline',
            ref: 'b9999',
            element: { type: 'citation', children: [{ text: '' }] },
          },
        ],
      },
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('BLOCK_REF_NOT_FOUND');
  });

  test('addNote inserts a comment block right after the anchor', async () => {
    const append = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'note-anchor' },
      body: {
        ops: [
          {
            type: 'appendBlocks',
            blocks: [{ type: 'p', children: [{ text: 'Anchor for a comment.' }] }],
          },
        ],
      },
    });
    const anchorRef = append.body.newRefs[0]!;

    const note = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'note-insert' },
      body: {
        ops: [
          {
            type: 'addNote',
            anchorRef,
            kind: 'comment',
            body: 'Consider adding a citation for this claim.',
          },
        ],
      },
    });
    expect(note.status).toBe(200);
    expect(note.body.newRefs).toHaveLength(1);

    const snap = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    const noteRef = note.body.newRefs[0]!;
    const inserted = snap.body.blocks.find((b) => b.ref === noteRef);
    expect(inserted?.type).toBe('blockquote');
    expect(inserted?.attrs.noteKind).toBe('comment');
    expect(inserted?.attrs.noteAnchorRef).toBe(anchorRef);
    expect(inserted?.text).toBe('Consider adding a citation for this claim.');
  });

  test('addNote rejects unknown kind and missing body', async () => {
    const append = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'note-anchor-2' },
      body: {
        ops: [
          {
            type: 'appendBlocks',
            blocks: [{ type: 'p', children: [{ text: 'Anchor 2.' }] }],
          },
        ],
      },
    });
    const anchorRef = append.body.newRefs[0]!;

    const badKind = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'note-bad-kind' },
      body: { ops: [{ type: 'addNote', anchorRef, kind: 'bogus', body: 'x' }] },
    });
    expect(badKind.status).toBe(400);

    const badBody = await call<{ error: string }>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'note-bad-body' },
      body: { ops: [{ type: 'addNote', anchorRef, kind: 'comment', body: '' }] },
    });
    expect(badBody.status).toBe(400);
  });

  test('addNote suggestion stores rationale + replacement attrs', async () => {
    const append = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'sug-anchor' },
      body: {
        ops: [
          {
            type: 'appendBlocks',
            blocks: [{ type: 'p', children: [{ text: 'Original phrasing.' }] }],
          },
        ],
      },
    });
    const anchorRef = append.body.newRefs[0]!;

    const sug = await call<EditResponse>(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'sug-insert' },
      body: {
        ops: [
          {
            type: 'addNote',
            anchorRef,
            kind: 'suggestion',
            body: 'Tighten the wording.',
            rationale: 'Tighten the wording.',
            replacement: 'Sharper phrasing.',
          },
        ],
      },
    });
    expect(sug.status).toBe(200);

    const snap = await call<SnapshotResponse>(`/documents/${KNOWN_DOC_ID}/snapshot`);
    const noteRef = sug.body.newRefs[0]!;
    const inserted = snap.body.blocks.find((b) => b.ref === noteRef);
    expect(inserted?.attrs.noteKind).toBe('suggestion');
    expect(inserted?.attrs.noteRationale).toBe('Tighten the wording.');
    expect(inserted?.attrs.noteReplacement).toBe('Sharper phrasing.');
  });

  test('discovery doc lists the new ops', async () => {
    const r = await call<{ ops: string[] }>('/.well-known/agent.json', { noAuth: true });
    expect(r.body.ops).toContain('appendInline');
    expect(r.body.ops).toContain('addNote');
  });

  test('mutations broadcast via Y.Doc to a connected client', async () => {
    if (!server) throw new Error('server not started');
    const hp = (server as { hocuspocus: import('@hocuspocus/server').Hocuspocus }).hocuspocus;

    const watcher = await hp.openDirectConnection(KNOWN_DOC_ID, { isWatcher: true });
    const watcherDoc = (watcher as unknown as { document: Y.Doc }).document;
    let updatesSeen = 0;
    const onUpdate = () => {
      updatesSeen++;
    };
    watcherDoc.on('update', onUpdate);

    await call(`/documents/${KNOWN_DOC_ID}/edit`, {
      method: 'POST',
      headers: { 'idempotency-key': 'broadcast-1' },
      body: { ops: [{ type: 'appendBlocks', blocks: [{ type: 'p', children: [{ text: 'broadcasted' }] }] }] },
    });

    await new Promise((r) => setTimeout(r, 50));
    watcherDoc.off('update', onUpdate);
    await watcher.disconnect();
    expect(updatesSeen).toBeGreaterThan(0);
  });
});
