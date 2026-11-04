import { Link } from 'react-router-dom'
import { forwardRef } from 'react'
import { Band, bandStyles } from './Band'
import s from './Houses.module.css'

const HOUSES = [
  { n: 'Okonkwo House', c: 'Port Harcourt', k: 'Painting · Works on paper' },
  { n: 'Lagos Salon', c: 'Lagos', k: 'Contemporary · Photography' },
  { n: 'Rele Rooms', c: 'Lagos', k: 'Emerging artists' },
  { n: 'The Annex PH', c: 'Port Harcourt', k: 'Sculpture · Textile' },
  { n: 'Nike Floor', c: 'Lagos · Osogbo', k: 'Adire · Batik · Beadwork' },
  { n: 'Kó Studio', c: 'Lagos', k: 'Modern Nigerian masters' },
  { n: 'Abuja Drawing Room', c: 'Abuja', k: 'Drawing · Print' },
  { n: 'Retro Africa', c: 'Abuja', k: 'Pan-African contemporary' },
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
