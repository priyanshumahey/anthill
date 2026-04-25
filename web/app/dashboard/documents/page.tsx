import { DashboardHeader } from "@/components/dashboard-header";
import { DocumentsList } from "@/components/documents-list";

export default function DocumentsPage() {
  return (
    <>
      <DashboardHeader />
      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h1 className="text-lg font-medium">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Collaborative rich-text documents. Every signed-in user can open
            and edit the same docs; AI can edit them too. All changes sync live
            via Supabase Realtime.
          </p>
        </div>
        <DocumentsList />
      </main>
    </>
  );
}
