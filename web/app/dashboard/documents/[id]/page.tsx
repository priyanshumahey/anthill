import { notFound, redirect } from "next/navigation";

import { DashboardHeader } from "@/components/dashboard-header";
import { DocumentEditor } from "@/components/document-editor";
import { createClient } from "@/lib/supabase/server";
import { serverApi } from "@/lib/trpc-server";

type Params = { id: string };

export default async function DocumentPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/auth/login");

  let doc;
  try {
    doc = await serverApi.documents.get({ id });
  } catch (err) {
    console.error("[document page] failed to load doc", id, err);
    notFound();
  }

  const meta = (authUser.user_metadata ?? {}) as {
    full_name?: string;
    name?: string;
    avatar_url?: string;
  };
  const user = {
    id: authUser.id,
    name: meta.full_name ?? meta.name ?? authUser.email ?? "User",
    avatar: meta.avatar_url ?? null,
  };

  return (
    <>
      <DashboardHeader />
      <main className="flex flex-1 flex-col overflow-hidden">
        <DocumentEditor
          id={doc.id}
          initialTitle={doc.title}
          initialContent={doc.content as unknown[]}
          user={user}
        />
      </main>
    </>
  );
}
