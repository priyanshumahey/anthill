import Link from "next/link"
import { SurfaceHero } from "@/components/surface-hero"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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
        <nav className="hidden items-center gap-7 text-sm text-neutral-300 md:flex">
          <Link href="#" className="hover:text-white">Product</Link>
          <Link href="#" className="hover:text-white">Research</Link>
          <Link href="#" className="hover:text-white">Docs</Link>
          <Link href="#" className="hover:text-white">Pricing</Link>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <Link href="#login" className="hidden text-neutral-300 hover:text-white sm:block">
            Sign in
          </Link>
          <Link
            href="#login"
            className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-neutral-950 hover:bg-neutral-200"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero content */}
      <main className="relative z-10 mx-auto flex min-h-[calc(100svh-80px)] max-w-7xl flex-col items-center justify-center gap-12 px-6 pb-24 lg:flex-row lg:items-center lg:justify-between lg:gap-10 lg:px-10">
        <section className="max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-neutral-300 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Now in private beta
          </span>
          <h1 className="mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Research,
            <br />
            <span className="bg-gradient-to-r from-orange-300 via-amber-200 to-white bg-clip-text text-transparent">
              collaboratively explored.
            </span>
          </h1>
          <p className="mt-5 max-w-md text-pretty text-base leading-relaxed text-neutral-300">
            A collaborative workspace for writing papers with autonomous agents
            that handle literature review, reviewer feedback, and the long tail
            of citations.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="#login"
              className="rounded-full bg-orange-500 px-5 py-2.5 text-sm font-medium text-neutral-950 shadow-lg shadow-orange-500/20 hover:bg-orange-400"
            >
              Start writing
            </Link>
            <Link
              href="#"
              className="rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm text-neutral-200 backdrop-blur hover:bg-white/10"
            >
              Watch demo
            </Link>
          </div>

          <dl className="mt-12 grid max-w-md grid-cols-3 gap-6 text-sm">
            {[
              { k: "Papers indexed", v: "2.3M" },
              { k: "Avg review", v: "<3 min" },
              { k: "Live coauthors", v: "∞" },
            ].map((s) => (
              <div key={s.k}>
                <dt className="text-neutral-400">{s.k}</dt>
                <dd className="mt-1 font-mono text-lg text-neutral-100">{s.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Login card */}
        <section id="login" className="w-full max-w-sm">
          <div className="relative rounded-2xl border border-white/10 bg-neutral-950/55 p-7 shadow-2xl shadow-black/50 backdrop-blur-xl">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-2xl"
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.06), transparent 30%)",
              }}
            />
            <div className="relative">
              <h2 className="text-lg font-semibold tracking-tight">
                Sign in to Anthill
              </h2>
              <p className="mt-1 text-sm text-neutral-400">
                Continue to your workspace.
              </p>

              <div className="mt-6 grid grid-cols-2 gap-2">
                <button className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-neutral-200 hover:bg-white/[0.08]">
                  <GoogleMark /> Google
                </button>
                <button className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-neutral-200 hover:bg-white/[0.08]">
                  <GithubMark /> GitHub
                </button>
              </div>

              <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-neutral-500">
                <span className="h-px flex-1 bg-white/10" />
                or
                <span className="h-px flex-1 bg-white/10" />
              </div>

              <form className="flex flex-col gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email" className="text-xs text-neutral-300">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@lab.edu"
                    className="border-white/10 bg-white/[0.04] text-neutral-100 placeholder:text-neutral-500"
                  />
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-xs text-neutral-300">
                      Password
                    </Label>
                    <Link href="#" className="text-xs text-neutral-400 hover:text-white">
                      Forgot?
                    </Link>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    className="border-white/10 bg-white/[0.04] text-neutral-100 placeholder:text-neutral-500"
                  />
                </div>
                <Button
                  type="submit"
                  className="mt-1 w-full rounded-lg bg-white text-neutral-950 hover:bg-neutral-200"
                >
                  Continue
                </Button>
              </form>

              <p className="mt-5 text-center text-xs text-neutral-400">
                New to Anthill?{" "}
                <Link href="#" className="text-neutral-100 hover:underline">
                  Create an account
                </Link>
              </p>
            </div>
          </div>
        </section>
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

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4">
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.4 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.5 0 9.2-3.9 9.2-9.4 0-.6-.1-1.1-.2-1.6H12z"/>
    </svg>
  )
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  )
}
