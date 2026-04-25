/**
 * Citation suggestion endpoint.
 *
 * Called by the editor's debounced typing-pause hook. Forwards the current
 * paragraph text to the local FastAPI semantic-search backend and returns the
 * top-k matching arXiv chunks. Used to render the ghost-text citation hint
 * and to back the click-through trace popover.
 */

import { NextResponse, type NextRequest } from "next/server";

import { backendFetch } from "@/server/api";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 1200;
const DEFAULT_K = 5;
const MAX_K = 8;

type BackendHit = {
  arxiv_id: string;
  chunk_index: number;
  text: string;
  score: number;
  title?: string | null;
  char_start?: number | null;
  char_end?: number | null;
};

type BackendResponse = {
  query: string;
  hits: BackendHit[];
  took_ms: number;
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const raw =
    typeof (body as { query?: unknown })?.query === "string"
      ? ((body as { query: string }).query as string)
      : "";
  const query = raw.trim();
  if (!query) {
    return NextResponse.json({ error: "empty query" }, { status: 400 });
  }

  // Keep the latest tail of the paragraph so very long blocks still embed
  // around the freshly written context.
  const truncated =
    query.length > MAX_QUERY_CHARS ? query.slice(-MAX_QUERY_CHARS) : query;

  const requestedK = Number((body as { k?: unknown })?.k);
  const k = Number.isFinite(requestedK)
    ? Math.min(Math.max(Math.trunc(requestedK), 1), MAX_K)
    : DEFAULT_K;

  try {
    const data = await backendFetch<BackendResponse>("/search", {
      method: "POST",
      body: { query: truncated, k },
      signal: req.signal,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json(null, { status: 408 });
    }
    const message = err instanceof Error ? err.message : "backend error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
