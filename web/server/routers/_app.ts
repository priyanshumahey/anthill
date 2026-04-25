import { z } from "zod";

import { backendFetch } from "../api";
import { publicProcedure, router } from "../trpc";
import { agentsRouter } from "./agents";
import { documentsRouter } from "./documents";

const healthSchema = z.object({
  status: z.string(),
  version: z.string(),
  collection: z.string().optional(),
  chunks: z.number().int().optional(),
  model_loaded: z.boolean().optional(),
});

const searchHitSchema = z.object({
  arxiv_id: z.string(),
  chunk_index: z.number().int(),
  text: z.string(),
  score: z.number(),
  title: z.string().nullable().optional(),
  char_start: z.number().int().nullable().optional(),
  char_end: z.number().int().nullable().optional(),
});

const searchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
  took_ms: z.number().int(),
});

const paperChunkSchema = z.object({
  index: z.number().int(),
  text: z.string(),
  char_start: z.number().int().nullable().optional(),
  char_end: z.number().int().nullable().optional(),
});

const paperResponseSchema = z.object({
  arxiv_id: z.string(),
  title: z.string().nullable(),
  chunks: z.array(paperChunkSchema),
});

export const appRouter = router({
  agents: agentsRouter,
  documents: documentsRouter,

  health: publicProcedure.query(async () => {
    const data = await backendFetch<unknown>("/healthz");
    return healthSchema.parse(data);
  }),

  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1),
        k: z.number().int().min(1).max(50).default(8),
        arxivIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const data = await backendFetch<unknown>("/search", {
        method: "POST",
        body: {
          query: input.query,
          k: input.k,
          arxiv_ids: input.arxivIds,
        },
      });
      return searchResponseSchema.parse(data);
    }),

  getPaper: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const data = await backendFetch<unknown>(
        `/papers/${encodeURIComponent(input.id)}`,
      );
      return paperResponseSchema.parse(data);
    }),
});

export type AppRouter = typeof appRouter;
