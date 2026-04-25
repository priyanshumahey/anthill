"use client"

import { Check, ChevronsUpDown, Plus } from "lucide-react"
import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

type Org = {
  id: string
  name: string
  plan?: string
}

// Replace with your real organizations source (tRPC, server fetch, etc.).
const orgs: Org[] = [
  { id: "personal", name: "Personal", plan: "Free" },
  { id: "anthill", name: "Anthill", plan: "Pro" },
]

const STORAGE_KEY = "anthill.activeOrgId"

export function TeamSwitcher() {
  const { isMobile } = useSidebar()
  const [activeOrgId, setActiveOrgId] = React.useState<string>(orgs[0].id)

  // Hydrate from localStorage on mount so the choice persists across reloads.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && orgs.some((o) => o.id === stored)) {
      setActiveOrgId(stored)
    }
  }, [])

  const active = orgs.find((o) => o.id === activeOrgId) ?? orgs[0]

  const selectOrg = (id: string) => {
    setActiveOrgId(id)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <span className="text-sm font-semibold">
                  {active.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active.name}</span>
                {active.plan ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {active.plan}
                  </span>
                ) : null}
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Organizations
              </DropdownMenuLabel>
              {orgs.map((org) => (
                <DropdownMenuItem
                  key={org.id}
                  className="gap-2 p-2"
                  onClick={() => selectOrg(org.id)}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                    <span className="text-xs font-medium">
                      {org.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <span className="flex-1 truncate">{org.name}</span>
                  {org.id === active.id ? (
                    <Check className="size-4 text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" disabled>
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <span className="text-muted-foreground">Add organization</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
