import { DashboardHeader } from "@/components/dashboard-header";
import { AgentsPanel } from "@/components/agents-panel";

export default function AgentsPage() {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-y-auto p-6">
        <div>
          <h1 className="text-lg font-medium">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Background tasks. Start a run, then watch the trace stream live.
          </p>
        </div>
        <AgentsPanel />
      </main>
    </>
  );
}
