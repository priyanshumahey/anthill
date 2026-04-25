import { DashboardHeader } from "@/components/dashboard-header"

export default function WorkspacesPage() {
  return (
    <>
      <DashboardHeader />
      <main className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <h1 className="text-lg font-medium">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          Your workspaces will appear here.
        </p>
      </main>
    </>
  )
}
