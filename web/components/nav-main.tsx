"use client"

import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type * as React from "react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export type NavItem = {
  title: string
  url: string
  icon?: LucideIcon
  exact?: boolean
}

export type NavSection = {
  label?: string
  items: NavItem[]
}

function isItemActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.url
  return pathname === item.url || pathname.startsWith(`${item.url}/`)
}

export function NavMain({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname()

  return (
    <>
      {sections.map((section, idx) => (
        <SidebarGroup key={section.label ?? `section-${idx}`}>
          {section.label ? (
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          ) : null}
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={<Link href={item.url} />}
                      size="sm"
                      tooltip={item.title}
                      isActive={isItemActive(pathname, item)}
                    >
                      {Icon ? <Icon className="size-4" /> : null}
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}
