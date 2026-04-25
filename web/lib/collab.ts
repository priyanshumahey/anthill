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
