import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createClient } from "@/lib/supabase/server";
import { publicProcedure, router } from "../trpc";

/**
 * Documents router.
 *
 * Source of truth for content: Supabase `documents.content` (jsonb, Plate value).
 * Realtime: clients subscribe to postgres_changes on `documents` for live sync.
 *
 * Auth model (for now): any authenticated user can list/create/open/edit every doc.
 */

type DocumentRow = {
  id: string;
  title: string;
  content: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Plate value is an array of element nodes; we store it as jsonb.
const plateValueSchema = z.array(z.record(z.string(), z.unknown()));

async function getSupabase() {
  return createClient();
}

async function requireUser() {
  const supabase = await getSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return { supabase, user };
}

const DEFAULT_CONTENT = [
  { type: "h1", children: [{ text: "Untitled" }] },
  { type: "p", children: [{ text: "" }] },
];

export const documentsRouter = router({
  list: publicProcedure.query(async () => {
    const { supabase } = await requireUser();
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, created_by, created_at, updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message,
      });
    }
    return data ?? [];
  }),

  create: publicProcedure
    .input(
      z.object({
        title: z.string().min(1).max(200).default("Untitled"),
      }),
    )
    .mutation(async ({ input }) => {
      const { supabase, user } = await requireUser();
      const { data, error } = await supabase
        .from("documents")
        .insert({
          title: input.title,
          content: DEFAULT_CONTENT,
          created_by: user.id,
        })
        .select("id, title, created_by, created_at, updated_at")
        .single();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      return data;
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const { supabase } = await requireUser();
      const { data, error } = await supabase
        .from("documents")
        .select("*")
        .eq("id", input.id)
        .maybeSingle();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      if (!data) throw new TRPCError({ code: "NOT_FOUND" });
      return data as DocumentRow;
    }),

  /** Persist a Plate value. Called by the editor's debounced autosave. */
  save: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        content: plateValueSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const { supabase } = await requireUser();
      const patch: Record<string, unknown> = { content: input.content };
      if (input.title) patch.title = input.title;
      const { data, error } = await supabase
        .from("documents")
        .update(patch)
        .eq("id", input.id)
        .select("id, updated_at")
        .single();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      return data;
    }),

  /**
   * AI-driven edit: appends a few blocks to the doc.
   *
   * In a real system this is where you'd call an LLM with the current content
   * + the user's instruction and synthesize the new Plate value. For now we
   * just append a block so we can prove the realtime broadcast works.
   */
  aiAppend: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        prompt: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const { supabase } = await requireUser();
      const { data: row, error: readErr } = await supabase
        .from("documents")
        .select("content")
        .eq("id", input.id)
        .single();
      if (readErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: readErr.message,
        });
      }
      const current = Array.isArray(row?.content) ? row.content : [];
      const appended = [
        ...current,
        { type: "h2", children: [{ text: "AI response" }] },
        {
          type: "blockquote",
          children: [
            {
              type: "p",
              children: [
                { text: "You asked: ", bold: true },
                { text: input.prompt },
              ],
            },
          ],
        },
        {
          type: "p",
          children: [
            {
              text:
                "This block was inserted by the server-side AI mutation. " +
                "Because it writes to Supabase and Realtime broadcasts the row " +
                "change, every connected editor refreshes its content.",
            },
          ],
        },
      ];

      const { data, error } = await supabase
        .from("documents")
        .update({ content: appended })
        .eq("id", input.id)
        .select("id, updated_at")
        .single();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      return data;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { supabase } = await requireUser();
      const { error } = await supabase
        .from("documents")
        .delete()
        .eq("id", input.id);
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      return { success: true };
    }),
});
