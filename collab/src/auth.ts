import type { AgentIdentity, BridgeErrorBody } from './types';

export interface AuthConfig {
  sharedSecret: string;
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

export function authenticateReadonly(
  req: Request,
  config: AuthConfig,
): AuthResult | AuthFailure {
  return authenticate(req, { ...config, enforceIdentity: false });
}
