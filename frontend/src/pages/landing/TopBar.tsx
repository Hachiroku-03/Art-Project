import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import s from './TopBar.module.css'
import { ScrollTrigger } from '../../lib/motion'

const LINKS = [
  ['#how', 'The floor'],
  ['#product', 'Product'],
  ['#gallery', 'The wall'],
  ['#houses', 'Houses'],
  ['#vip', 'VIP'],
]

/** Transparent over the room; turns to paper once the hero has scrolled out. */
export function TopBar() {
  const ref = useRef<HTMLElement>(null)
  const [paper, setPaper] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const st = ScrollTrigger.create({
      trigger: '#how',
      start: 'top top+=64',
      refreshPriority: -1,   // measure after the pinned sections above have added their spacing
      onEnter: () => setPaper(true),
      onLeaveBack: () => setPaper(false),
    })
    ScrollTrigger.sort()
    const t = window.setTimeout(() => ScrollTrigger.refresh(), 300)
    return () => { st.kill(); window.clearTimeout(t) }
  }, [])

  return (
    <header ref={ref} className={`${s.bar} ${paper ? s.paper : ''} ${open ? s.open : ''}`}>
      <a className={s.wordmark} href="#top" aria-label="The Space — top">THE SPACE</a>

      <nav className={s.links} aria-label="Sections">
        {LINKS.map(([href, label]) => (
          <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
        ))}
      </nav>

      <div className={s.actions}>
        <Link className={s.signin} to="/login">Log in</Link>
        <Link className={s.cta} to="/signup">Create account</Link>
        <button className={s.burger} onClick={() => setOpen(o => !o)} aria-label="Menu" aria-expanded={open}>
          <i /><i />
        </button>
      </div>
    </header>
  )
}
