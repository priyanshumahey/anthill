import { z } from "zod";

import { backendFetch } from "../api";
import { publicProcedure, router } from "../trpc";

const paperSchema = z.object({
  id: z.string(),
  title: z.string(),
  abstract: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
});

const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(paperSchema),
});

const healthSchema = z.object({
  status: z.string(),
  version: z.string(),
});

export const appRouter = router({
  health: publicProcedure.query(async () => {
    const data = await backendFetch<unknown>("/health");
    return healthSchema.parse(data);
  }),

  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(10),
      }),
    )
    .mutation(async ({ input }) => {
      const data = await backendFetch<unknown>("/search", {
        method: "POST",
        body: input,
      });
      return searchResponseSchema.parse(data);
    }),

  getPaper: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const data = await backendFetch<unknown>(
        `/papers/${encodeURIComponent(input.id)}`,
      );
      return paperSchema.parse(data);
    }),
});

export type AppRouter = typeof appRouter;
