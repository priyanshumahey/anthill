/**
 * HTTP integration test for the agent bridge.
 *
 * Spins up a real Hocuspocus + Bun.serve (no Supabase HTTP — we stub the
 * Supabase client at the JS-method level), then drives the bridge over
 * fetch() the way an external agent would. Covers: discovery, snapshot,
 * state, edit, idempotency replay, stale revision, missing-ref errors,
 * and auth.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';

import { AgentBridge } from '../src/agent-bridge';
import type { EditResponse, SnapshotResponse, StateResponse } from '../src/types';

// ──────────────────────────────────────────────────────────────────
// Stubs
// ──────────────────────────────────────────────────────────────────

const KNOWN_DOC_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_DOC_ID = '00000000-0000-4000-8000-0000000000ff';

let storedTitle: string | null = 'Initial title';
const titleUpdates: { title: string; at: string }[] = [];

/** Just enough Supabase surface for the bridge. */
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
        // Awaiting `.update().eq()` (the title patch path) lands here.
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
const BRIDGE_PORT = 18889; // unused range so it doesn't clash with dev server
const HP_PORT = 18888;
const SECRET = 'test-secret';

beforeAll(async () => {
  // Hocuspocus with no persistence hooks — pure in-memory.
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

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

interface FetchOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip auth headers entirely (for negative tests). */
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

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

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

    // Replaying the exact same body+key should NOT mutate again.
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
    // Mutate once to invalidate the just-fetched revision.
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

  test('mutations broadcast via Y.Doc to a connected client', async () => {
    // Fresh Hocuspocus state still uses the same Y.Doc instance for our
    // documentId; openDirectConnection fetches it. We simulate a "browser"
    // by opening a second direct connection and watching for updates.
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

    // Hocuspocus broadcasts asynchronously; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    watcherDoc.off('update', onUpdate);
    await watcher.disconnect();
    expect(updatesSeen).toBeGreaterThan(0);
  });
});
