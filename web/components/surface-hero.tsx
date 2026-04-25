"use client"

import { useEffect, useRef } from "react"

/**
 * Smooth animated 3D surface ("surf") plot rendered to canvas.
 * Used as a full-bleed hero background.
 */
export function SurfaceHero({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const N = 96
    const size = 10

    const heightAt = (x: number, z: number) => {
      const g = (cx: number, cz: number, s: number, a: number) =>
        a * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * s * s))
      return (
        g(-1.8, -1.0, 2.4, 4.2) +
        g(2.6, 1.0, 1.8, 2.4) +
        g(2.8, -2.6, 1.5, -2.8) +
        Math.sin(x * 0.5 + z * 0.3) * 0.22 +
        Math.cos(x * 0.3 - z * 0.6) * 0.18
      )
    }

    const grid: { x: number; z: number; h: number }[][] = []
    for (let i = 0; i < N; i++) {
      const row: { x: number; z: number; h: number }[] = []
      for (let j = 0; j < N; j++) {
        const x = (i / (N - 1) - 0.5) * 2 * size
        const z = (j / (N - 1) - 0.5) * 2 * size
        row.push({ x, z, h: heightAt(x, z) })
      }
      grid.push(row)
    }

    const t0 = performance.now()

    const draw = () => {
      const t = (performance.now() - t0) / 1000
      ctx.clearRect(0, 0, width, height)

      const angle = t * 0.12
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      const pitch = 0.58
      const tiltCos = Math.cos(pitch)
      const tiltSin = Math.sin(pitch)
      const focal = Math.min(width, height) * 1.55
      const cx = width / 2
      const cy = height * 0.62
      const camDist = 26

      type V = { sx: number; sy: number; depth: number; h: number; ok: boolean }
      const proj: V[][] = new Array(N)
      for (let i = 0; i < N; i++) {
        const row: V[] = new Array(N)
        for (let j = 0; j < N; j++) {
          const p = grid[i][j]
          const wobble =
            Math.sin(t * 0.6 + p.x * 0.18 + p.z * 0.18) * 0.05
          const h = p.h + wobble
          const rx = p.x * cosA - p.z * sinA
          const rz = p.x * sinA + p.z * cosA
          const ty = h * tiltCos - rz * tiltSin
          const tz = h * tiltSin + rz * tiltCos
          const depth = tz + camDist
          const ok = depth > 0.5
          const sx = ok ? cx + (rx / depth) * focal : 0
          const sy = ok ? cy - (ty / depth) * focal : 0
          row[j] = { sx, sy, depth, h, ok }
        }
        proj[i] = row
      }

      type Quad = {
        depth: number
        a: V
        b: V
        c: V
        d: V
        avgH: number
        nz: number
      }
      const quads: Quad[] = []
      for (let i = 0; i < N - 1; i++) {
        for (let j = 0; j < N - 1; j++) {
          const a = proj[i][j]
          const b = proj[i + 1][j]
          const c = proj[i + 1][j + 1]
          const d = proj[i][j + 1]
          if (!a.ok || !b.ok || !c.ok || !d.ok) continue
          const depth = (a.depth + b.depth + c.depth + d.depth) * 0.25
          const avgH = (a.h + b.h + c.h + d.h) * 0.25
          const ux = b.sx - a.sx
          const uy = b.sy - a.sy
          const vx = d.sx - a.sx
          const vy = d.sy - a.sy
          const cross = Math.abs(ux * vy - uy * vx)
          const nz = Math.max(0, Math.min(1, cross / 800))
          quads.push({ depth, a, b, c, d, avgH, nz })
        }
      }
      quads.sort((p, q) => q.depth - p.depth)

      // Smooth shaded fill, slight overdraw to hide seams.
      for (const q of quads) {
        const heightT = Math.max(0, Math.min(1, (q.avgH + 3) / 8))
        const lum = 0.14 + q.nz * 0.5 + heightT * 0.28
        const r = Math.round(255 * Math.min(1, lum + heightT * 0.42))
        const g = Math.round(255 * Math.min(1, lum * 0.78 + heightT * 0.12))
        const bch = Math.round(255 * Math.min(1, lum * 0.6))
        ctx.fillStyle = `rgba(${r},${g},${bch},1)`
        ctx.beginPath()
        ctx.moveTo(q.a.sx, q.a.sy)
        ctx.lineTo(q.b.sx, q.b.sy)
        ctx.lineTo(q.c.sx, q.c.sy)
        ctx.lineTo(q.d.sx, q.d.sy)
        ctx.closePath()
        ctx.fill()
        // tiny stroke same color = anti-seam
        ctx.strokeStyle = `rgba(${r},${g},${bch},1)`
        ctx.lineWidth = 0.6
        ctx.stroke()
      }

      // Sparse iso-line wires for graph feel.
      ctx.strokeStyle = "rgba(255,255,255,0.10)"
      ctx.lineWidth = 0.6
      const step = 8
      for (let i = 0; i < N; i += step) {
        ctx.beginPath()
        for (let j = 0; j < N; j++) {
          const v = proj[i][j]
          if (!v.ok) continue
          if (j === 0) ctx.moveTo(v.sx, v.sy)
          else ctx.lineTo(v.sx, v.sy)
        }
        ctx.stroke()
      }
      for (let j = 0; j < N; j += step) {
        ctx.beginPath()
        for (let i = 0; i < N; i++) {
          const v = proj[i][j]
          if (!v.ok) continue
          if (i === 0) ctx.moveTo(v.sx, v.sy)
          else ctx.lineTo(v.sx, v.sy)
        }
        ctx.stroke()
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className={className} />
}
