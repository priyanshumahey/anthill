/**
 * Anthill agent bridge — HTTP surface mounted next to the Hocuspocus
 * WebSocket server. External agents (Claude Code, Copilot, our own
 * backend agents) call this surface to read snapshots and apply
 * block-level edits to a live document.
 *
 * Design notes
 * ────────────
 * - The bridge accesses each document via Hocuspocus'
 *   `openDirectConnection(slug)`. That gives us a `Y.Doc` whose updates
 *   broadcast to every connected browser AND fire `onStoreDocument`
 *   (so Supabase persistence is unchanged).
 * - All mutations run in one `Y.transact` with a tagged origin so the
 *   editor can later attribute them in undo/redo & UI overlays.
 * - Errors map to a small typed `BridgeErrorBody` so the client SDKs
 *   can dispatch off `error` codes.
 */

import type { Hocuspocus } from '@hocuspocus/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Y from 'yjs';

import { authenticate, authenticateReadonly, type AuthConfig } from './auth';
import {
  applyOps,
  BridgeOpError,
  type ApplyOpsResult,
} from './agent-ops';
import { IdempotencyCache } from './idempotency';
import { computeRevision } from './revision';
import {
  blockCountOf,
  fragmentToPlateValue,
  getContentFragment,
  pruneIllegalChildren,
  snapshotBlocks,
} from './plate-yjs';
import {
  BRIDGE_VERSION,
  EDIT_OP_TYPES,
  PROTOCOL_VERSION,
  SUPPORTED_BLOCK_TYPES,
  type BridgeErrorBody,
  type BridgeErrorCode,
  type DiscoveryDoc,
  type EditRequest,
  type EditResponse,
  type SnapshotResponse,
  type StateResponse,
} from './types';

export interface AgentBridgeConfig {
  port: number;
  hocuspocus: Hocuspocus;
  supabase: SupabaseClient;
  auth: AuthConfig;
  /** Path prefix; defaults to ''. */
  basePath?: string;
}

interface DocMeta {
  title: string | null;
  hasLiveClients: boolean;
}

export class AgentBridge {
  private readonly idempotency = new IdempotencyCache<EditResponse>();
  /**
   * Per-document long-lived "warm" direct connections. Hocuspocus unloads a
   * document the moment its connection count hits zero, so naive
   * open→mutate→disconnect on every request would discard the in-memory
   * Y.Doc between calls (we'd reload from Supabase each time, losing any
   * un-persisted state and racing with the debounced storeDocument hook).
   * Pinning one connection per document keeps the canonical doc resident
   * for the bridge's lifetime; we reuse it across requests.
   */
  private readonly warmConns = new Map<
    string,
    Promise<import('@hocuspocus/server').DirectConnection>
  >();

  constructor(private readonly cfg: AgentBridgeConfig) {}

  start(): ReturnType<typeof Bun.serve> {
    const server = Bun.serve({
      port: this.cfg.port,
      fetch: (req) => this.handle(req),
    });
    console.log(
      `[agent-bridge] listening http://localhost:${server.port}` +
        (this.cfg.auth.sharedSecret
          ? ' (shared-secret auth enabled)'
          : ' (OPEN MODE — set ANTHILL_AGENT_BRIDGE_SECRET to lock down)'),
    );
    return server;
  }

  /** Drop and destroy every warm connection. Call before process exit. */
  async stop(): Promise<void> {
    for (const [, p] of this.warmConns) {
      try {
        const conn = await p;
        await conn.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.warmConns.clear();
  }

  // ──────────────────────────────────────────────────────────────────
  // Routing
  // ──────────────────────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = stripPrefix(url.pathname, this.cfg.basePath ?? '');
    const method = req.method.toUpperCase();

    try {
      // CORS preflight
      if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      // Public routes
      if (method === 'GET' && path === '/healthz') {
        return cors(json({ status: 'ok', version: BRIDGE_VERSION }));
      }
      if (method === 'GET' && path === '/.well-known/agent.json') {
        return cors(json(this.discoveryDoc()));
      }

      // Document-scoped routes: /documents/:id/{snapshot|state|edit|presence|repair}
      const docMatch = path.match(/^\/documents\/([^/]+)\/(snapshot|state|edit|presence|repair)\/?$/);
      if (docMatch) {
        const documentId = decodeURIComponent(docMatch[1]);
        const sub = docMatch[2];
        if (method === 'GET' && sub === 'snapshot') return cors(await this.snapshot(req, documentId));
        if (method === 'GET' && sub === 'state') return cors(await this.state(req, documentId));
        if (method === 'POST' && sub === 'edit') return cors(await this.edit(req, documentId));
        if (method === 'POST' && sub === 'presence') return cors(await this.presence(req, documentId));
        if (method === 'POST' && sub === 'repair') return cors(await this.repair(req, documentId));
        return cors(errorResponse(405, 'BAD_REQUEST', `method ${method} not allowed on ${path}`));
      }

      return cors(errorResponse(404, 'NOT_FOUND', `route ${method} ${path} not found`));
    } catch (err) {
      console.error('[agent-bridge] unhandled error', err);
      return cors(
        errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Routes
  // ──────────────────────────────────────────────────────────────────

  private discoveryDoc(): DiscoveryDoc {
    return {
      protocol: PROTOCOL_VERSION,
      version: BRIDGE_VERSION,
      auth: { header: 'X-Agent-Token', type: 'shared-secret' },
      identity: { header: 'X-Agent-Id' },
      endpoints: {
        snapshot: '/documents/{id}/snapshot',
        state: '/documents/{id}/state',
        edit: '/documents/{id}/edit',
        presence: '/documents/{id}/presence',
      },
      ops: EDIT_OP_TYPES,
      blockTypes: SUPPORTED_BLOCK_TYPES,
    };
  }

  private async snapshot(req: Request, documentId: string): Promise<Response> {
    const auth = authenticateReadonly(req, this.cfg.auth);
    if (!auth.ok) return errorResponse(auth.status, auth.body.error, auth.body.message);

    return this.withDoc(documentId, async (doc, meta) => {
      const fragment = getContentFragment(doc);
      const body: SnapshotResponse = {
        documentId,
        title: meta.title,
        baseRevision: computeRevision(doc),
        blockCount: blockCountOf(fragment),
        blocks: snapshotBlocks(fragment),
        hasLiveClients: meta.hasLiveClients,
      };
      return json(body);
    });
  }

  private async state(req: Request, documentId: string): Promise<Response> {
    const auth = authenticateReadonly(req, this.cfg.auth);
    if (!auth.ok) return errorResponse(auth.status, auth.body.error, auth.body.message);

    return this.withDoc(documentId, async (doc, meta) => {
      const fragment = getContentFragment(doc);
      const body: StateResponse = {
        documentId,
        title: meta.title,
        baseRevision: computeRevision(doc),
        value: fragmentToPlateValue(fragment),
      };
      return json(body);
    });
  }

  private async edit(req: Request, documentId: string): Promise<Response> {
    const auth = authenticate(req, this.cfg.auth);
    if (!auth.ok) return errorResponse(auth.status, auth.body.error, auth.body.message);

    const idemKey = req.headers.get('idempotency-key')?.trim() || '';
    let body: EditRequest;
    try {
      body = (await req.json()) as EditRequest;
    } catch {
      return errorResponse(400, 'BAD_REQUEST', 'invalid JSON body');
    }

    // Replay from idempotency cache if same key + same body.
    if (idemKey) {
      const bodyHash = IdempotencyCache.hashBody(body);
      const cached = this.idempotency.get(idemKey);
      if (cached) {
        if (cached.bodyHash !== bodyHash) {
          return errorResponse(
            409,
            'IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY',
            'Idempotency-Key was reused with a different request body.',
          );
        }
        return json(cached.response, { status: cached.status, headers: { 'idempotency-replay': 'true' } });
      }
    }

    const ops = body.ops;
    if (!Array.isArray(ops) || ops.length === 0) {
      return errorResponse(400, 'BAD_REQUEST', 'body.ops must be a non-empty array');
    }

    let result: ApplyOpsResult | null = null;
    let titleToPersist: string | null = null;
    let staleRevision = false;
    let opError: BridgeOpError | null = null;

    const docResp = await this.withDoc(documentId, async (doc, _meta) => {
      // Optimistic locking: if caller pinned a revision and it's stale, 409.
      if (body.baseRevision && body.baseRevision !== computeRevision(doc)) {
        staleRevision = true;
        return errorResponse(
          409,
          'STALE_REVISION',
          'baseRevision is stale; refetch /snapshot and retry.',
        );
      }
      try {
        result = applyOps(doc, auth.identity, ops, {
          idempotencyKey: idemKey || undefined,
          setTitle: (t) => {
            titleToPersist = t;
          },
        });
      } catch (err) {
        if (err instanceof BridgeOpError) {
          opError = err;
        } else {
          throw err;
        }
        return errorResponse(
          400,
          'BAD_REQUEST',
          err instanceof Error ? err.message : String(err),
        );
      }
      const fragment = getContentFragment(doc);
      const responseBody: EditResponse = {
        applied: result.applied,
        baseRevision: computeRevision(doc),
        blockCount: blockCountOf(fragment),
        newRefs: result.newRefs,
      };
      // Cache the success response under the idempotency key.
      if (idemKey) {
        this.idempotency.put(
          idemKey,
          IdempotencyCache.hashBody(body),
          200,
          responseBody,
        );
      }
      return json(responseBody);
    });

    if (staleRevision) return docResp;
    if (opError) {
      const e = opError as BridgeOpError;
      return errorResponse(
        e.code === 'BLOCK_REF_NOT_FOUND' ? 404 : 400,
        e.code,
        e.message,
        e.details,
      );
    }

    // Persist title outside the Yjs transaction (Supabase row, not CRDT).
    if (titleToPersist !== null) {
      try {
        const { error } = await this.cfg.supabase
          .from('documents')
          .update({ title: titleToPersist, updated_at: new Date().toISOString() })
          .eq('id', documentId);
        if (error) {
          console.warn(`[agent-bridge] title update failed doc=${documentId}: ${error.message}`);
        }
      } catch (err) {
        console.warn(`[agent-bridge] title update threw doc=${documentId}:`, err);
      }
    }

    return docResp;
  }

  private async presence(req: Request, documentId: string): Promise<Response> {
    const auth = authenticate(req, this.cfg.auth);
    if (!auth.ok) return errorResponse(auth.status, auth.body.error, auth.body.message);

    let body: { status?: string; message?: string } = {};
    try {
      body = (await req.json()) as { status?: string; message?: string };
    } catch {
      // Allow empty body.
    }

    // We piggy-back on Yjs awareness: write a per-agent entry into the doc's
    // awareness state. The browser editor's PresenceStack already renders
    // anyone with an `agent` flag.
    return this.withDoc(documentId, async (doc, _meta) => {
      const awarenessShared = doc.getMap<unknown>('agent_presence');
      awarenessShared.set(auth.identity.agentId, {
        agentId: auth.identity.agentId,
        agentName: auth.identity.agentName ?? auth.identity.agentId,
        runId: auth.identity.runId ?? null,
        status: body.status ?? 'active',
        message: body.message ?? null,
        updatedAt: new Date().toISOString(),
      });
      return json({ ok: true });
    });
  }

  /**
   * Repair endpoint: strips top-level `Y.XmlElement` siblings (illegal
   * under slate-yjs's encoding) from the document. Generates Yjs delete
   * ops so connected clients converge live, no reload needed. Also a
   * useful escape hatch when an external tool puts the CRDT in a
   * surprising state.
   */
  private async repair(req: Request, documentId: string): Promise<Response> {
    const auth = authenticate(req, this.cfg.auth);
    if (!auth.ok) return errorResponse(auth.status, auth.body.error, auth.body.message);

    return this.withDoc(documentId, async (doc, _meta) => {
      const fragment = getContentFragment(doc);
      let removed = 0;
      Y.transact(
        doc,
        () => {
          removed = pruneIllegalChildren(fragment);
        },
        { source: 'agent-bridge', kind: 'repair', agentId: auth.identity.agentId },
      );
      return json({
        ok: true,
        documentId,
        removed,
        blockCount: blockCountOf(fragment),
        baseRevision: computeRevision(doc),
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Doc access via Hocuspocus directConnection
  // ──────────────────────────────────────────────────────────────────

  private async withDoc(
    documentId: string,
    fn: (doc: import('yjs').Doc, meta: DocMeta) => Promise<Response>,
  ): Promise<Response> {
    if (!documentId || documentId.length > 200) {
      return errorResponse(400, 'BAD_REQUEST', 'invalid document id');
    }

    // Check the doc actually exists in Supabase. This avoids creating
    // empty Yjs ghosts via openDirectConnection for typoed slugs.
    const { data: row, error: readErr } = await this.cfg.supabase
      .from('documents')
      .select('id, title')
      .eq('id', documentId)
      .maybeSingle();
    if (readErr) {
      return errorResponse(500, 'INTERNAL_ERROR', `supabase read: ${readErr.message}`);
    }
    if (!row) {
      return errorResponse(404, 'NOT_FOUND', `document ${documentId} not found`);
    }

    const conn = await this.getWarmConnection(documentId);

    try {
      // Hocuspocus opens the doc internally; we get it via `conn.document`.
      const internalDoc = (conn as unknown as { document?: { hasConnections?: () => boolean } & import('yjs').Doc })
        .document;
      if (!internalDoc) {
        return errorResponse(500, 'INTERNAL_ERROR', 'no document on direct connection');
      }
      const meta: DocMeta = {
        title: (row.title as string | null) ?? null,
        hasLiveClients:
          typeof internalDoc.hasConnections === 'function'
            ? internalDoc.hasConnections()
            : false,
      };

      // Run the caller. Mutations they perform inside Y.transact will be
      // batched and broadcast to every connected client when the
      // transaction commits, then `onStoreDocument` debounces a write
      // back to Supabase.
      let response: Response | null = null;
      await conn.transact(async (transactDoc: import('yjs').Doc) => {
        response = await fn(transactDoc, meta);
      });
      return response ?? errorResponse(500, 'INTERNAL_ERROR', 'no response produced');
    } catch (err) {
      // If the warm connection died (e.g. document was unloaded by another
      // path), drop the cached promise so the next call re-opens.
      this.warmConns.delete(documentId);
      throw err;
    }
  }

  private getWarmConnection(
    documentId: string,
  ): Promise<import('@hocuspocus/server').DirectConnection> {
    let existing = this.warmConns.get(documentId);
    if (existing) return existing;
    existing = this.cfg.hocuspocus.openDirectConnection(documentId, {
      isAgentBridge: true,
    });
    this.warmConns.set(documentId, existing);
    // If opening fails, evict so the next request retries cleanly.
    existing.catch(() => this.warmConns.delete(documentId));
    return existing;
  }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(
  status: number,
  error: BridgeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: BridgeErrorBody = { error, message };
  if (details) body.details = details;
  return json(body, { status });
}

function cors(res: Response): Response {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set(
    'access-control-allow-headers',
    'content-type, x-agent-token, x-agent-id, x-agent-name, x-agent-run-id, idempotency-key',
  );
  return res;
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
}
