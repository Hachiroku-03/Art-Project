import { forwardRef, useLayoutEffect, useRef } from 'react'
import { Band } from './Band'                 // wrapper only — no CTA here
import styles from './Manifesto.module.css'   // the numbered list
import { gsap, reducedMotion } from '../../lib/motion'

const LINES = [
  ['Balances are sums,', 'never columns.'],
  ['A work is shown', 'at its own proportions.'],
  ['The artist\u2019s name', 'comes before the handle.'],
  ['The catalogue stays sealed', 'until you hold a paddle.'],
  ['Money can\u2019t be edited \u2014', 'only added to.'],
]

/** Dark band. Each statement brightens as it crosses the centre of the viewport — a spot finding the next work. */
export const Manifesto = forwardRef<HTMLElement>(function Manifesto(_, ref) {
  const el = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const root = el.current
    if (!root || reducedMotion()) return
    const ctx = gsap.context(() => {
      root.querySelectorAll<HTMLElement>('[data-line]').forEach(line => {
        gsap.fromTo(line, { opacity: 0.18, x: -10 }, {
          opacity: 1, x: 0, ease: 'none',
          scrollTrigger: { trigger: line, start: 'top 75%', end: 'top 40%', scrub: true },
        })
      })
    }, root)
    return () => ctx.revert()
  }, [])

  return (
    <Band ref={node => { el.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }}
      id="manifesto" tone="ink" index="05" eyebrow="What we hold to">
      <ol className={styles.list}>
        {LINES.map(([a, b], i) => (
          <li key={a} className={styles.line} data-line>
            <span className={styles.n}>{String(i + 1).padStart(2, '0')}</span>
            <p className={styles.text}>{a} <em>{b}</em></p>
          </li>
        ))}
      </ol>
    </Band>
  )
})
