import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { bandStyles } from './Band'
import s from './Hero.module.css'
import { gsap, ScrollTrigger, hasWebGL, reducedMotion } from '../../lib/motion'
import type { Progress } from '../../scene/HeroScene'
import a0 from '../../art/a0.jpg'

const HeroScene = lazy(() => import('../../scene/HeroScene').then(m => ({ default: m.HeroScene })))

/** Pinned for 1.6 screens: the camera dollies toward the work while the copy settles, then lifts. */
export function Hero() {
  const root = useRef<HTMLElement>(null)
  const copy = useRef<HTMLDivElement>(null)
  const prog = useRef<Progress>({ p: 0, mx: 0, my: 0 })
  const [gl, setGl] = useState<boolean | null>(null)

  useEffect(() => { setGl(hasWebGL()) }, [])

  useLayoutEffect(() => {
    const el = root.current, c = copy.current
    if (!el || !c) return
    const rm = reducedMotion()
    const ctx = gsap.context(() => {
      gsap.fromTo(c.querySelectorAll('[data-line]'),
        { opacity: 0, y: rm ? 0 : 26 },
        { opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: 0.1, delay: 0.2 })

      ScrollTrigger.create({
        trigger: el,
        start: 'top top',
        end: '+=160%',
        pin: true,
        scrub: true,
        onUpdate: self => {
          prog.current.p = self.progress
          const k = Math.max(0, (self.progress - 0.6) / 0.4)
          c.style.opacity = String(1 - k)
          c.style.transform = `translateY(${-k * 30}px)`
        },
      })
    }, el)

    const move = (e: PointerEvent) => {
      prog.current.mx = (e.clientX / window.innerWidth) * 2 - 1
      prog.current.my = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => { ctx.revert(); window.removeEventListener('pointermove', move) }
  }, [])

  return (
    <section id="hero" ref={root} className={s.hero}>
      <div className={s.stage} aria-hidden="true">
        {gl === false ? (
          <div className={s.poster}><img src={a0} alt="" loading="eager" decoding="async" /></div>
        ) : gl ? (
          <Suspense fallback={<div className={s.poster}><img src={a0} alt="" loading="eager" decoding="async" /></div>}><HeroScene prog={prog} /></Suspense>
        ) : null}
        <div className={s.scrim} />
      </div>

      <div ref={copy} className={s.copy}>
        <p className={`${bandStyles.eyebrow} ${s.eyebrow}`} data-line>A social gallery with an auction floor</p>
        <h1 className={s.h1} data-line>
          Where art is <em>shown</em>, <em>sold</em>, and <em>kept</em>.
        </h1>
        <p className={s.lede} data-line>
          Artists hang on the wall. Accredited houses run the room. Every paddle raised is a real bid,
          and every bid settles in a ledger you can read.
        </p>
        <div className={`${bandStyles.btnRow} ${s.ctas}`} data-line>
          <Link className={`${bandStyles.btnLight}`} to="/signup">Create an account</Link>
          <a className={`${bandStyles.btnGhost}`} href="#how">How the floor works</a>
        </div>
      </div>

      <div className={s.label} aria-hidden="true">
        <span>Mara Vance</span>
        <span className={s.work}><em>Untitled (Ochre Field)</em>, 2024</span>
        <span>Oil on linen · 320 × 180 cm</span>
      </div>

      <p className={s.note} data-line>Free to join · every member hangs work · houses apply once inside</p>
      <div className={s.hint} aria-hidden="true"><i /> scroll</div>
    </section>
  )
}