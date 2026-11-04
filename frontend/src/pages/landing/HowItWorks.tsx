import { forwardRef } from 'react'
import { Band } from './Band'
import s from './HowItWorks.module.css'

const STEPS = [
  {
    n: '01', t: 'The house opens a sale',
    d: 'From the Control Room. Lots are hung sealed — the catalogue stays dark until you present a paddle at the door.',
  },
  {
    n: '02', t: 'You claim a paddle',
    d: 'A six-digit code minted per room. Paid rooms debit the wallet in the same breath; no balance, no paddle.',
  },
  {
    n: '03', t: 'The hammer falls',
    d: 'Buyer debit, house credit and commission land as three ledger rows in one transaction — or none at all.',
  },
]

export const HowItWorks = forwardRef<HTMLElement>(function HowItWorks(_, ref) {
  return (
    <Band ref={ref} id="how" tone="paper" index="01" eyebrow="The floor"
      title={<>Three moves. <em>One</em> transaction.</>}
      intro="A live auction room should feel like a room: a sealed catalogue, a paddle in your hand, and a hammer everyone hears.">
      <ol className={s.steps}>
        {STEPS.map((st, i) => (
          <li key={st.n} className={s.step} data-reveal="steps">
            <span className={s.num}>{st.n}</span>
            <h3 className={s.t}>{st.t}</h3>
            <p className={s.d}>{st.d}</p>
            {i < STEPS.length - 1 && <span className={s.arrow} aria-hidden="true">→</span>}
          </li>
        ))}
      </ol>

      <dl className={s.stats}>
        {[['1.5 s', 'ledger refresh in a live room'], ['0', 'mutable balance columns'], ['6-digit', 'paddle, minted per room'], ['Monthly', 'VIP, swept on sign-in']].map(([b, l]) => (
          <div key={l} className={s.stat} data-reveal="stats">
            <dt>{b}</dt><dd>{l}</dd>
          </div>
        ))}
      </dl>
    </Band>
  )
})
