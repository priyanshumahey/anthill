import { DashboardHeader } from "@/components/dashboard-header";
import { AgentRunDetail } from "@/components/agent-run-detail";

export default async function AgentRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto p-6">
        <AgentRunDetail runId={id} />
      </main>
    </>
  );
}
