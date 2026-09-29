import { useEffect, useRef } from 'react'
import styles from './ChatBackground.module.css'

/**
 * Ambient palette dust behind the message thread.
 *
 * Entrance: a waterline rises from the bottom of the thread and carries the dust
 * up with it. When it reaches the top the water fades and the dust keeps drifting
 * slowly inside — upward with a gentle sway, respawning at the bottom.
 *
 * 2D canvas, no dependencies. 30 fps, DPR ≤ 2. Sleeps when the tab is hidden or
 * the pane is off-screen. prefers-reduced-motion → one static frame, no motion.
 */

type LayerSpec = { color: string; count: number; size: number; opacity: number }
type Particle = { x: number; y: number; ty: number; r: number; lag: number; layer: number; speed: number; phase: number }

const LAYERS: LayerSpec[] = [
  { color: '91,58,142',  count: 1.0,  size: 2.6, opacity: 0.20 }, // VIP purple
  { color: '217,140,95', count: 0.7,  size: 1.9, opacity: 0.16 }, // terracotta
  { color: '14,14,14',   count: 0.45, size: 1.4, opacity: 0.10 }, // ink dust
]

const FILL_MS   = 1700          // how long the water takes to reach the top
const FADE_MS   = 420           // how long the water takes to disappear once full
const WATER     = '91,58,142'   // the wash colour (VIP purple, very faint)
const FPS = 30, FRAME_MS = 1000 / FPS

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

type Props = { /** replay the fill when this changes (e.g. the active thread id) */ replayKey?: string | number }

export function ChatBackground({ replayKey }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    let w = 0, h = 0, dpr = 1
    let particles: Particle[] = []
    let raf = 0, last = 0
    let t0 = 0                     // fill start timestamp
    let settled = reduced          // true once the water has gone → drift mode
    let t = 0                      // drift clock
    let visible = !document.hidden, onScreen = true

    /* ---------- particles ---------- */
    function build() {
      const base = w < 760 ? 55 : 110
      particles = []
      LAYERS.forEach((spec, li) => {
        const n = Math.floor(base * spec.count)
        for (let i = 0; i < n; i++) {
          particles.push({
            x: Math.random() * w,
            ty: Math.random() * h,                       // where the water will leave it
            y: h + 20,
            r: spec.size * (0.7 + Math.random() * 0.6),
            lag: 6 + Math.random() * 26,                 // how far below the surface it rides
            layer: li,
            speed: (0.12 + Math.random() * 0.4) * (h / 600),   // px per frame @30fps once drifting
            phase: Math.random() * Math.PI * 2,
          })
        }
      })
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      const nw = Math.max(1, Math.floor(rect.width)), nh = Math.max(1, Math.floor(rect.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rebuild = particles.length === 0 || Math.abs(nw - w) > 200
      const sy = h ? nh / h : 1
      w = nw; h = nh
      canvas!.width = Math.floor(w * dpr); canvas!.height = Math.floor(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (rebuild) build()
      else for (const p of particles) { p.ty *= sy; p.y *= sy }   // keep relative placement on height changes
      if (reduced) drawSettled()          // motion users get repainted by the loop
    }

    /* ---------- drawing ---------- */
    function drawDust(filter?: (p: Particle) => boolean) {
      for (let li = 0; li < LAYERS.length; li++) {
        const spec = LAYERS[li]
        ctx!.beginPath()
        for (const p of particles) {
          if (p.layer !== li || (filter && !filter(p))) continue
          ctx!.moveTo(p.x + p.r, p.y)
          ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        }
        ctx!.fillStyle = `rgba(${spec.color},${spec.opacity})`
        ctx!.fill()
      }
    }

    function drawSettled() {
      for (const p of particles) p.y = p.ty
      ctx!.clearRect(0, 0, w, h)
      drawDust()
    }

    /** waterline y at x for a given base level */
    const surface = (x: number, level: number, time: number) =>
      level + Math.sin(x * 0.018 + time * 0.0042) * 7 + Math.sin(x * 0.041 - time * 0.0061) * 3

    function drawFill(now: number) {
      const k = clamp01((now - t0) / FILL_MS)
      const level = h * (1 - easeOutCubic(k)) - 12            // overshoot past the top edge
      const fadeK = k < 1 ? 0 : clamp01((now - t0 - FILL_MS) / FADE_MS)
      const washAlpha = 0.07 * (1 - fadeK)

      // particles ride the surface until it passes their resting spot
      for (const p of particles) {
        const s = surface(p.x, level, now) + p.lag
        p.y = Math.max(p.ty, s)
      }

      ctx!.clearRect(0, 0, w, h)

      if (washAlpha > 0.001) {
        // the water: body + slightly brighter meniscus at the top
        ctx!.beginPath()
        ctx!.moveTo(0, h + 2)
        for (let x = 0; x <= w; x += 6) ctx!.lineTo(x, surface(x, level, now))
        ctx!.lineTo(w, h + 2)
        ctx!.closePath()
        const g = ctx!.createLinearGradient(0, Math.max(0, level), 0, h)
        g.addColorStop(0, `rgba(${WATER},${washAlpha * 1.6})`)
        g.addColorStop(0.12, `rgba(${WATER},${washAlpha})`)
        g.addColorStop(1, `rgba(${WATER},${washAlpha * 0.35})`)
        ctx!.fillStyle = g
        ctx!.fill()
      }

      // only dust that is under the surface exists yet
      drawDust(p => p.y >= surface(p.x, level, now) - 2)

      return fadeK >= 1
    }

    function drawDrift() {
      t += 0.016
      for (const p of particles) {
        p.y -= p.speed
        p.x += Math.sin(t + p.phase) * 0.18
        if (p.y < -p.r * 2) { p.y = h + p.r * 2; p.x = Math.random() * w }
        else if (p.x < -10) p.x = w + 10
        else if (p.x > w + 10) p.x = -10
      }
      ctx!.clearRect(0, 0, w, h)
      drawDust()
    }

    /* ---------- loop ---------- */
    function step(now: number) {
      raf = requestAnimationFrame(step)
      if (now - last < FRAME_MS) return
      last = now
      if (settled) { drawDrift(); return }
      if (!t0) t0 = now
      if (drawFill(now)) {              // water gone → hand the particles to the drift, in place
        settled = true
        for (const p of particles) p.y = p.ty
      }
    }
    function start() { if (reduced || raf || !visible || !onScreen) return; last = 0; raf = requestAnimationFrame(step) }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0 }

    const onVis = () => { visible = !document.hidden; visible ? start() : stop() }
    document.addEventListener('visibilitychange', onVis)
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop() })
    io.observe(canvas)
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    resize()
    if (reduced) drawSettled(); else start()

    return () => {
      stop(); ro.disconnect(); io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [replayKey])

  return <canvas ref={ref} className={styles.bg} aria-hidden="true" />
}
