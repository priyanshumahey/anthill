import Link from "next/link"

import { SurfaceHero } from "@/components/surface-hero"

export default function Page() {
  return (
    <div className="dark relative min-h-svh overflow-hidden bg-neutral-950 font-sans text-neutral-200">
      {/* Hero background */}
      <SurfaceHero className="absolute inset-0 h-full w-full" />

      {/* Atmospheric overlays */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 75% 10%, rgba(255,140,60,0.18), transparent 60%), radial-gradient(60% 60% at 0% 100%, rgba(60,90,140,0.15), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neutral-950/40 via-neutral-950/10 to-neutral-950/80"
      />
      {/* film grain / noise via SVG */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.6'/></svg>\")",
        }}
      />

      {/* Top nav */}
      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-neutral-950">
            <LogoMark />
          </span>
          <span className="text-sm font-semibold tracking-tight">Anthill</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <Link
            href="/auth/login"
            className="hidden text-neutral-300 hover:text-white sm:block"
          >
            Sign in
          </Link>
          <Link
            href="/auth/sign-up"
            className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-neutral-950 hover:bg-neutral-200"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero content */}
      <main className="relative z-10 mx-auto flex min-h-[calc(100svh-80px)] max-w-5xl flex-col items-center justify-center gap-8 px-6 pb-24 text-center">
        <h1 className="text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Research,
          <br />
          <span className="bg-gradient-to-r from-orange-300 via-amber-200 to-white bg-clip-text text-transparent">
            collaboratively explored.
          </span>
        </h1>
        <p className="max-w-xl text-pretty text-base leading-relaxed text-neutral-300">
          A collaborative workspace for writing papers with autonomous agents
          that handle literature review, reviewer feedback, and the long tail
          of citations.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/auth/sign-up"
            className="rounded-full bg-orange-500 px-5 py-2.5 text-sm font-medium text-neutral-950 shadow-lg shadow-orange-500/20 hover:bg-orange-400"
          >
            Start writing
          </Link>
          <Link
            href="/auth/login"
            className="rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm text-neutral-200 backdrop-blur hover:bg-white/10"
          >
            Sign in
          </Link>
        </div>
      </main>
    </div>
  )
}

function LogoMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M3 13 L8 2 L13 13 L10.5 13 L8 7.5 L5.5 13 Z" />
    </svg>
  )
}
