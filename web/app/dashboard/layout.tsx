import type * as React from "react"
import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { createClient } from "@/lib/supabase/server"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    redirect("/auth/login")
  }

  const meta = (authUser.user_metadata ?? {}) as {
    full_name?: string
    name?: string
    avatar_url?: string
  }
  const user = {
    name: meta.full_name ?? meta.name ?? authUser.email ?? "User",
    email: authUser.email ?? "",
    avatar: meta.avatar_url,
  }

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset className="flex h-svh min-w-0 flex-col">
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
