/**
 * Auth + identity extraction for the agent bridge.
 *
 * Tier 1 (v1):
 *   - Shared secret via `X-Agent-Token` header. Set
 *     `ANTHILL_AGENT_BRIDGE_SECRET=<random>` in the collab server env. If
 *     the secret is empty, the bridge runs in "open" mode and accepts any
 *     request (dev only — logged loudly at startup).
 *   - Agent identity from `X-Agent-Id` header. Required for every
 *     mutation route so provenance can be attributed.
 *   - Optional `X-Agent-Run-Id` header — backend run id, surfaces in
 *     provenance + Yjs origin for tracing.
 *
 * Tier 2 (later, mirroring proof-sdk):
 *   - Per-document scoped tokens (viewer/commenter/editor roles).
 *   - JWT-signed agent identities (so untrusted agents can't impersonate).
 */

import type { AgentIdentity, BridgeErrorBody } from './types';

export interface AuthConfig {
  /** Required header value. Empty string = open mode (dev only). */
  sharedSecret: string;
  /** When true, requests must carry both token + agent id headers. */
  enforceIdentity?: boolean;
}

export interface AuthResult {
  ok: true;
  identity: AgentIdentity;
}

export interface AuthFailure {
  ok: false;
  status: number;
  body: BridgeErrorBody;
}

export function authenticate(
  req: Request,
  config: AuthConfig,
): AuthResult | AuthFailure {
  const token = req.headers.get('x-agent-token') ?? '';
  const agentId = (req.headers.get('x-agent-id') ?? '').trim();
  const agentName = (req.headers.get('x-agent-name') ?? '').trim() || undefined;
  const runId = (req.headers.get('x-agent-run-id') ?? '').trim() || undefined;

  if (config.sharedSecret) {
    if (!token || token !== config.sharedSecret) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'UNAUTHORIZED',
          message:
            'Missing or invalid X-Agent-Token header. Set it to the shared secret configured in the collab server.',
        },
      };
    }
  }

  const enforceIdentity = config.enforceIdentity ?? true;
  if (enforceIdentity && !agentId) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'UNAUTHORIZED',
        message:
          'Missing X-Agent-Id header. Every bridge call must identify the agent (e.g. literature_search, claude-code).',
      },
    };
  }

  return {
    ok: true,
    identity: {
      agentId: agentId || 'anonymous',
      agentName,
      runId,
    },
  };
}

/** Read-only routes: identity nice-to-have but not strictly required. */
export function authenticateReadonly(
  req: Request,
  config: AuthConfig,
): AuthResult | AuthFailure {
  return authenticate(req, { ...config, enforceIdentity: false });
}
