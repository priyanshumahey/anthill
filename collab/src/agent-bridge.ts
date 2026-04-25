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
  basePath?: string;
}

interface DocMeta {
  title: string | null;
  hasLiveClients: boolean;
}

export class AgentBridge {
  private readonly idempotency = new IdempotencyCache<EditResponse>();
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

  async stop(): Promise<void> {
    for (const [, p] of this.warmConns) {
      try {
        const conn = await p;
        await conn.disconnect();
      } catch {
      }
    }
    this.warmConns.clear();
  }


  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = stripPrefix(url.pathname, this.cfg.basePath ?? '');
    const method = req.method.toUpperCase();

    try {
      if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      if (method === 'GET' && path === '/healthz') {
        return cors(json({ status: 'ok', version: BRIDGE_VERSION }));
      }
      if (method === 'GET' && path === '/.well-known/agent.json') {
        return cors(json(this.discoveryDoc()));
      }

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
    }

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

  private async withDoc(
    documentId: string,
    fn: (doc: import('yjs').Doc, meta: DocMeta) => Promise<Response>,
  ): Promise<Response> {
    if (!documentId || documentId.length > 200) {
      return errorResponse(400, 'BAD_REQUEST', 'invalid document id');
    }

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

      let response: Response | null = null;
      await conn.transact(async (transactDoc: import('yjs').Doc) => {
        response = await fn(transactDoc, meta);
      });
      return response ?? errorResponse(500, 'INTERNAL_ERROR', 'no response produced');
    } catch (err) {
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
    existing.catch(() => this.warmConns.delete(documentId));
    return existing;
  }
}

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
