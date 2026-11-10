import { Link } from 'react-router-dom'
import { forwardRef } from 'react'
import { Band, bandStyles } from './Band'
import s from './Houses.module.css'

const HOUSES = [
  { n: 'Meridian House',    c: 'Lisbon',     k: 'Painting · Works on paper' },
  { n: 'Harbour Salon',     c: 'Berlin',     k: 'Contemporary · Photography' },
  { n: 'Atelier Rooms',     c: 'New York',   k: 'Emerging artists' },
  { n: 'The Annex',         c: 'London',     k: 'Sculpture · Textile' },
  { n: 'Northlight Floor',  c: 'Copenhagen', k: 'Fibre · Print · Beadwork' },
  { n: 'Kestrel Studio',    c: 'Seoul',      k: 'Modern & Contemporary' },
  { n: 'Drawing Room',      c: 'Melbourne',  k: 'Drawing · Print' },
  { n: 'Retro Modern',      c: 'Toronto',    k: 'International contemporary' },
]

export const Houses = forwardRef<HTMLElement>(function Houses(_, ref) {
  return (
    <Band ref={ref} id="houses" tone="wall" index="04" eyebrow="Houses"
      title={<>Galleries already <em>on the floor</em>.</>}
      intro="Accredited houses host the live sales — set access, open the broadcast, call the lots, settle the wins. You don't sign up as a house: join as a member, then put your house name forward for review.">
      <div className={s.marquee} aria-hidden="true">
        <div className={s.track}>
          {[...HOUSES, ...HOUSES].map((h, i) => <span key={i}>{h.n}</span>)}
        </div>
      </div>

      <ul className={s.grid}>
        {HOUSES.map(h => (
          <li key={h.n} className={s.cell} data-reveal="houses">
            <span className={s.name}>{h.n}</span>
            <span className={s.city}>{h.c}</span>
            <span className={s.kind}>{h.k}</span>
          </li>
        ))}
      </ul>

      <div className={`${bandStyles.btnRow} ${s.ctaRow}`} data-reveal="houses">
        <Link className={`${bandStyles.btnDark}`} to="/signup">Join, then apply</Link>
        <Link className={`${bandStyles.btnGhost}`} to="/login">Already accredited? Log in</Link>
      </div>
    </Band>
  )
})