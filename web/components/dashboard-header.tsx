"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { trpc } from "@/lib/trpc";

type Crumb = {
  label: string;
  href?: string;
};

const STATIC_LABELS: Record<string, string> = {
  dashboard: "Home",
  documents: "Documents",
  workspaces: "Workspaces",
  search: "Search",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useBreadcrumbs(): Crumb[] {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);

  // Detect /dashboard/documents/[id] and resolve title from the API.
  const id =
    segments[0] === "dashboard" &&
    segments[1] === "documents" &&
    segments[2] &&
    UUID_RE.test(segments[2])
      ? segments[2]
      : null;

  // Only fire the query when we're actually on a doc page; reuses tRPC cache
  // if the user navigated from the documents list.
  const docQuery = trpc.documents.get.useQuery(
    { id: id ?? "" },
    { enabled: Boolean(id) },
  );

  const crumbs: Crumb[] = [];
  let acc = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    acc += `/${segment}`;
    if (i === 0 && segment === "dashboard") {
      crumbs.push({ label: "Home", href: "/dashboard" });
      continue;
    }
    if (i === 2 && id) {
      crumbs.push({
        label: docQuery.data?.title ?? "Document",
      });
      continue;
    }
    crumbs.push({
      label: STATIC_LABELS[segment] ?? segment,
      href: acc,
    });
  }
  return crumbs;
}

export type DashboardHeaderProps = {
  /** Optional content rendered on the right side of the header. */
  actions?: React.ReactNode;
};

export function DashboardHeader({ actions }: DashboardHeaderProps) {
  const crumbs = useBreadcrumbs();
  const last = crumbs.length - 1;

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => (
            <React.Fragment key={`${crumb.label}-${index}`}>
              <BreadcrumbItem>
                {index === last || !crumb.href ? (
                  <BreadcrumbPage className="max-w-[40ch] truncate">
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={<Link href={crumb.href} />}
                    className="max-w-[24ch] truncate"
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {index < last && <BreadcrumbSeparator />}
            </React.Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  );
}
