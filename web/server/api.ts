import { TRPCError } from "@trpc/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const SHARED_SECRET = process.env.ANTHILL_SHARED_SECRET ?? "";

type RequestOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

export async function backendFetch<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const { method = "GET", body, signal } = opts;
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (SHARED_SECRET) headers["X-Anthill-Secret"] = SHARED_SECRET;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: res.status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
      message: `Backend ${method} ${path} failed (${res.status}): ${text}`,
    });
  }

  return (await res.json()) as T;
}

/** Backend URL + secret header. Used by route handlers that need to stream
 *  responses straight through (e.g. the SSE proxy for agent events). */
export function backendStreamConfig(): { url: string; headers: HeadersInit } {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (SHARED_SECRET) headers["X-Anthill-Secret"] = SHARED_SECRET;
  return { url: BACKEND_URL, headers };
}
