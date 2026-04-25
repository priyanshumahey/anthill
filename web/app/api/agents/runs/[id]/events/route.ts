import type { NextRequest } from "next/server";

import { backendStreamConfig } from "@/server/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxies the backend's `/agents/runs/:id/events` Server-Sent Events stream.
 *
 * The browser hits this Next route (no secret needed). We add the
 * `X-Anthill-Secret` header server-side and pipe the response body through.
 * The upstream connection is aborted automatically when the client disconnects
 * because we forward `request.signal`.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return new Response("missing run id", { status: 400 });

  const { url, headers } = backendStreamConfig();
  const upstream = await fetch(
    `${url}/agents/runs/${encodeURIComponent(id)}/events`,
    { headers, signal: request.signal, cache: "no-store" },
  );

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || "upstream error", {
      status: upstream.status || 502,
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
