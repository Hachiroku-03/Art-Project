import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { bandStyles } from './Band'
import s from './GalleryMotif.module.css'
import { gsap, ScrollTrigger, hasWebGL } from '../../lib/motion'
import { WORKS, X, LAST_X } from '../../scene/works'
import a3 from '../../art/a3.jpg'

const CorridorScene = lazy(() => import('../../scene/CorridorScene').then(m => ({ default: m.CorridorScene })))

/** Pinned corridor: scroll walks the camera along seven works; the wall label swaps as each one passes.
 *  The WebGL corridor is gated behind an IntersectionObserver so its 7 textures load only when the
 *  section approaches the viewport — the poster carries the first paint. */
export function GalleryMotif() {
  const root = useRef<HTMLElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const prog = useRef({ p: 0 })
  const [gl, setGl] = useState<boolean | null>(null)
  const [near, setNear] = useState(false)
  const [cur, setCur] = useState(0)
  const [count, setCount] = useState(0)

  useEffect(() => { setGl(hasWebGL()) }, [])

  // Mount the corridor only when #gallery is about to enter view.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: el,
        start: 'top top',
        end: `+=${WORKS.length * 70}%`,
        pin: true,
        scrub: true,
        onUpdate: self => {
          prog.current.p = self.progress
          if (head.current) {
            const k = Math.min(1, self.progress / 0.12)
            head.current.style.opacity = String(1 - k)
            head.current.style.transform = `translateY(${-k * 20}px)`
          }
          const camX = self.progress * LAST_X
          let best = 0, d = Infinity
          X.forEach((x, i) => { const dd = Math.abs(x - camX); if (dd < d) { d = dd; best = i } })
          setCur(best)
          setCount(Math.round(self.progress * 100))
        },
      })
    }, el)
    return () => ctx.revert()
  }, [])

  const w = WORKS[cur]
  const showCanvas = gl && near

  return (
    <section id="gallery" ref={root} className={s.motif}>
      <div className={s.stage} aria-hidden="true">
        {showCanvas ? (
          <Suspense fallback={<div className={s.poster}><img src={a3} alt="" loading="lazy" decoding="async" /></div>}>
            <CorridorScene prog={prog} />
          </Suspense>
        ) : (
          <div className={s.poster}><img src={a3} alt="" loading="lazy" decoding="async" /></div>
        )}
        <div className={s.scrim} />
      </div>

      <div ref={head} className={s.head}>
        <p className={`${bandStyles.eyebrow} ${s.eyebrow}`}><b>03</b>The wall</p>
        <h2 className={s.h2}>A feed that hangs like a <em>wall</em>.</h2>
        <p className={s.lede}>Works at their real proportions. An artist's name before a handle. A label under every piece — medium, size, year — the way a gallery would do it.</p>
      </div>

      <div className={s.label} key={cur}>
        <span className={s.idx}>{String(cur + 1).padStart(2, '0')} / {String(WORKS.length).padStart(2, '0')}</span>
        <span className={s.artist}>{w.artist}</span>
        <em className={s.title}>{w.title}</em>
        <span className={s.spec}>{w.medium} · {Math.round(w.w * 100)} × {Math.round(w.h * 100)} cm · {w.year}</span>
      </div>

      <div className={s.rail} aria-hidden="true">
        <i style={{ width: `${count}%` }} />
      </div>
    </section>
  )
}