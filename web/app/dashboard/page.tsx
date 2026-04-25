import { DashboardHeader } from "@/components/dashboard-header"

export default function DashboardHomePage() {
  return (
    <>
      <DashboardHeader />
      <main className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <h1 className="text-lg font-medium">Home</h1>
        <p className="text-sm text-muted-foreground">
          Welcome to your dashboard.
        </p>
      </main>
    </>
  )
}
