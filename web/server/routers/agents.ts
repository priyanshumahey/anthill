import { z } from "zod";

import { backendFetch } from "../api";
import { publicProcedure, router } from "../trpc";

// ---- Schemas mirroring backend/agents/types.py ----

const runStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

const runEventSchema = z.object({
  seq: z.number().int(),
  run_id: z.string(),
  at: z.string(), // ISO; tRPC superjson keeps Date too but backend returns string
  kind: z.string(),
  message: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

const agentRunSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: runStatusSchema,
  input: z.record(z.string(), z.unknown()),
  document_id: z.string().nullable().optional(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});

const listRunsResponseSchema = z.object({ runs: z.array(agentRunSchema) });
const runDetailResponseSchema = z.object({
  run: agentRunSchema,
  events: z.array(runEventSchema),
});
const agentsListResponseSchema = z.object({
  agents: z.array(z.object({ name: z.string() })),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;

export const agentsRouter = router({
  /** List all registered agents on the backend. */
  list: publicProcedure.query(async () => {
    const data = await backendFetch<unknown>("/agents");
    return agentsListResponseSchema.parse(data);
  }),

  /** Recent runs, optionally filtered by agent or document. */
  listRuns: publicProcedure
    .input(
      z
        .object({
          agent: z.string().optional(),
          documentId: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({}),
    )
    .query(async ({ input }) => {
      const params = new URLSearchParams();
      if (input.agent) params.set("agent", input.agent);
      if (input.documentId) params.set("document_id", input.documentId);
      params.set("limit", String(input.limit));
      const data = await backendFetch<unknown>(`/agents/runs?${params}`);
      return listRunsResponseSchema.parse(data);
    }),

  /** Single run + its full trace snapshot. Live updates come from the SSE proxy. */
  getRun: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const data = await backendFetch<unknown>(
        `/agents/runs/${encodeURIComponent(input.id)}`,
      );
      return runDetailResponseSchema.parse(data);
    }),

  /** Enqueue a new run. Returns immediately with the run id. */
  createRun: publicProcedure
    .input(
      z.object({
        agent: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
        documentId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const data = await backendFetch<unknown>("/agents/runs", {
        method: "POST",
        body: {
          agent: input.agent,
          input: input.input,
          document_id: input.documentId,
        },
      });
      return agentRunSchema.parse(data);
    }),

  cancelRun: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const data = await backendFetch<unknown>(
        `/agents/runs/${encodeURIComponent(input.id)}/cancel`,
        { method: "POST" },
      );
      return agentRunSchema.parse(data);
    }),
});
