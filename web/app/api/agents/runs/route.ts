/**
 * Proxies `POST /agents/runs` to the FastAPI backend.
 *
 * Used by the editor when it wants to fire a fresh agent run from the
 * browser without going through tRPC (e.g. the citation-suggest plugin
 * firing `ground_citation` per accepted citation).
 *
 * The server-side `X-Anthill-Secret` header is added in `backendFetch`.
 */

import { NextResponse, type NextRequest } from "next/server";

import { backendFetch } from "@/server/api";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const obj = (body ?? {}) as Record<string, unknown>;
  const agent = typeof obj.agent === "string" ? obj.agent : "";
  if (!agent) {
    return NextResponse.json({ error: "agent is required" }, { status: 400 });
  }

  const input =
    obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)
      ? (obj.input as Record<string, unknown>)
      : {};
  const document_id =
    typeof obj.document_id === "string"
      ? obj.document_id
      : typeof obj.documentId === "string"
        ? (obj.documentId as string)
        : undefined;

  try {
    const data = await backendFetch<unknown>("/agents/runs", {
      method: "POST",
      body: { agent, input, document_id },
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "backend error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
