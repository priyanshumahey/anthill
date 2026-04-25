"use client"

import { Home, LayoutGrid } from "lucide-react"
import type * as React from "react"

import { NavMain, type NavSection } from "@/components/nav-main"
import { NavUser, type NavUserProps } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarRail,
} from "@/components/ui/sidebar"

const sections: NavSection[] = [
    {
        items: [
            { title: "Home", url: "/dashboard", icon: Home, exact: true },
            { title: "Workspaces", url: "/dashboard/workspaces", icon: LayoutGrid },
        ],
    },
]

export function AppSidebar({
    user,
    ...props
}: React.ComponentProps<typeof Sidebar> & {
    user: NavUserProps
}) {
    return (
        <Sidebar collapsible="icon" className="border-r-0" {...props}>
            <SidebarHeader className="overflow-hidden pb-0">
                <TeamSwitcher />
            </SidebarHeader>
            <SidebarContent className="gap-0 pt-2">
                <NavMain sections={sections} />
            </SidebarContent>
            <SidebarFooter className="border-t border-sidebar-border/60">
                <NavUser user={user} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    )
}
