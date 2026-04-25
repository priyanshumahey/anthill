/**
 * Stable cursor color per user (so reloads don't reshuffle).
 * Server-side import-safe (no DOM/React).
 */
const CURSOR_COLORS = [
  '#E57373', // red
  '#64B5F6', // blue
  '#81C784', // green
  '#FFB74D', // orange
  '#BA68C8', // purple
  '#4DD0E1', // cyan
  '#FF8A65', // deep orange
  '#AED581', // light green
  '#F06292', // pink
  '#7986CB', // indigo
] as const;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function cursorColorForUser(userId?: string | null): string {
  if (!userId) {
    return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
  }
  return CURSOR_COLORS[hashString(userId) % CURSOR_COLORS.length];
}

export function getCollabWsUrl(): string {
  const url = process.env.NEXT_PUBLIC_HOCUSPOCUS_URL?.trim();
  if (!url) {
    // Fallback to localhost for dev convenience.
    return 'ws://localhost:8888';
  }
  return url;
}

/**
 * HTTP base URL for the agent bridge (HTTP API on the same /collab
 * process, default port 8889). The browser shows this in the "Connect
 * agent" dialog so external agents know where to point. Defaults derive
 * from `NEXT_PUBLIC_HOCUSPOCUS_URL` so localhost-with-tunnels works
 * without extra env wiring.
 */
export function getAgentBridgeUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_AGENT_BRIDGE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // Derive from the WS url: ws://host:8888 → http://host:8889.
  const ws = process.env.NEXT_PUBLIC_HOCUSPOCUS_URL?.trim();
  if (ws) {
    try {
      const parsed = new URL(ws);
      const httpProto = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      // Map :8888 → :8889 by default, but keep host as-is (so dev
      // tunnels and custom ports still work — operators can override
      // with NEXT_PUBLIC_AGENT_BRIDGE_URL).
      const port = parsed.port === '8888' ? '8889' : parsed.port;
      const portSuffix = port ? `:${port}` : '';
      return `${httpProto}//${parsed.hostname}${portSuffix}`;
    } catch {
      // fall through to default
    }
  }
  return 'http://localhost:8889';
}
