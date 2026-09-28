import { useEffect, useRef } from 'react'
import styles from './ChatBackground.module.css'

/**
 * Ambient palette dust behind the message thread.
 * 2D canvas, no dependencies. Round dots, upward drift with a slow sway.
 * Sleeps when: tab hidden, element off-screen, or prefers-reduced-motion (paints one frame).
 * Capped at 30 fps and DPR 2.
 */

type LayerSpec = { color: string; count: number; size: number; opacity: number }
type Particle = { x: number; y: number; r: number; speed: number; phase: number; layer: number }

const LAYERS: LayerSpec[] = [
  { color: '91,58,142',  count: 1.0,  size: 2.6, opacity: 0.20 }, // VIP purple
  { color: '217,140,95', count: 0.7,  size: 1.9, opacity: 0.16 }, // terracotta
  { color: '14,14,14',   count: 0.45, size: 1.4, opacity: 0.10 }, // ink dust
]

const FPS = 30
const FRAME_MS = 1000 / FPS

export function ChatBackground() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    let w = 0, h = 0, dpr = 1
    let particles: Particle[] = []
    let raf = 0
    let last = 0
    let t = 0
    let visible = !document.hidden
    let onScreen = true

    function spawn(p: Particle, fromBottom: boolean) {
      const spec = LAYERS[p.layer]
      p.x = Math.random() * w
      p.y = fromBottom ? h + spec.size * 2 : Math.random() * h
      p.r = spec.size * (0.7 + Math.random() * 0.6)
      p.speed = (0.12 + Math.random() * 0.4) * (h / 600)      // px per frame @30fps, scaled to height
      p.phase = Math.random() * Math.PI * 2
    }

    function build() {
      const base = w < 760 ? 55 : 110
      particles = []
      LAYERS.forEach((spec, li) => {
        const n = Math.floor(base * spec.count)
        for (let i = 0; i < n; i++) {
          const p: Particle = { x: 0, y: 0, r: 0, speed: 0, phase: 0, layer: li }
          spawn(p, false)
          particles.push(p)
        }
      })
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      const nw = Math.max(1, Math.floor(rect.width))
      const nh = Math.max(1, Math.floor(rect.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rebuild = particles.length === 0 || Math.abs(nw - w) > 200
      w = nw; h = nh
      canvas!.width = Math.floor(w * dpr)
      canvas!.height = Math.floor(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (rebuild) build()
      if (reduced) draw()
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h)
      // one path per layer → three fill calls per frame
      for (let li = 0; li < LAYERS.length; li++) {
        const spec = LAYERS[li]
        ctx!.beginPath()
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i]
          if (p.layer !== li) continue
          ctx!.moveTo(p.x + p.r, p.y)
          ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        }
        ctx!.fillStyle = `rgba(${spec.color},${spec.opacity})`
        ctx!.fill()
      }
    }

    function step(now: number) {
      raf = requestAnimationFrame(step)
      if (now - last < FRAME_MS) return
      last = now
      t += 0.016

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        p.y -= p.speed
        p.x += Math.sin(t + p.phase) * 0.18
        if (p.y < -p.r * 2) spawn(p, true)
        else if (p.x < -10) p.x = w + 10
        else if (p.x > w + 10) p.x = -10
      }
      draw()
    }

    function start() {
      if (reduced || raf || !visible || !onScreen) return
      last = 0
      raf = requestAnimationFrame(step)
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const onVis = () => { visible = !document.hidden; visible ? start() : stop() }
    document.addEventListener('visibilitychange', onVis)

    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting
      onScreen ? start() : stop()
    })
    io.observe(canvas)

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    resize()
    start()

    return () => {
      stop()
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return <canvas ref={ref} className={styles.bg} aria-hidden="true" />
}
