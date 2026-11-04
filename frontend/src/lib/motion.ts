import { useLayoutEffect, type RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)
export { gsap, ScrollTrigger }

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Reveal every `[data-reveal]` inside `scope` once it enters the viewport.
 * Elements sharing the same `data-reveal` group value stagger together.
 */
export function useReveal(scope: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = scope.current
    if (!root || reducedMotion()) {
      root?.querySelectorAll<HTMLElement>('[data-reveal]').forEach(el => {
        el.style.opacity = '1'
        el.style.transform = 'none'
        el.dataset.in = '1'
      })
      return
    }
    const ctx = gsap.context(() => {
      const groups = new Map<string, HTMLElement[]>()
      root.querySelectorAll<HTMLElement>('[data-reveal]').forEach(el => {
        const g = el.dataset.reveal || 'solo:' + Math.random()
        groups.set(g, [...(groups.get(g) || []), el])
      })
      groups.forEach(els => {
        gsap.fromTo(
          els,
          { opacity: 0, y: 18 },
          {
            opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08,
            scrollTrigger: { trigger: els[0], start: 'top 85%', once: true },
            onStart: () => els.forEach(el => (el.dataset.in = '1')),
          },
        )
      })
    }, root)
    return () => ctx.revert()
  }, [scope])
}

/* helpers shared with the scenes */
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
export const remap = (p: number, a: number, b: number) => clamp01((p - a) / (b - a))
export const smooth = (t: number) => t * t * (3 - 2 * t)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const damp = (cur: number, target: number, lambda: number, dt: number) =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt))
