import { DashboardHeader } from "@/components/dashboard-header";
import { SearchPanel } from "@/components/search-panel";

export default function SearchPage() {
  return (
    <>
      <DashboardHeader />
      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h1 className="text-lg font-medium">Search</h1>
          <p className="text-sm text-muted-foreground">
            Semantic search over the indexed arXiv corpus. Queries are embedded
            with the local Harrier model and matched against ChromaDB by cosine
            similarity.
          </p>
        </div>
        <SearchPanel />
      </main>
    </>
  );
}
