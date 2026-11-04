import { forwardRef, useLayoutEffect, useRef, useState } from 'react'
import { Band } from './Band'
import s from './Product.module.css'
import { gsap, ScrollTrigger, reducedMotion } from '../../lib/motion'

/* ---- the three surfaces, in the order a visitor meets them ---- */
const SURFACES = [
  {
    k: 'wall', eyebrow: 'The wall',
    t: 'A feed that reads like a label.',
    d: 'Works at their natural ratio. Artist first, then the title in italic, then medium, size, year. Keep what moves you — your wall remembers.',
  },
  {
    k: 'room', eyebrow: 'The room',
    t: 'A live sale you can hear.',
    d: 'Houses reveal lots one at a time. Your paddle is a six-digit code minted for that room. Every bid is a ledger row, refreshed every second and a half.',
  },
  {
    k: 'control', eyebrow: 'The control room',
    t: 'Run the rostrum from one desk.',
    d: 'Sales, catalogue, entry, rostrum, settlement, payout. Lock the currency once lots exist; hammer, and three ledger rows land in one transaction — or none.',
  },
] as const

const BIDS = [
  ['paddle 0417', '3,600'], ['mara.collects', '3,800'], ['s.balogun', '4,000'],
  ['tobi.draws', '4,200'], ['mara.collects', '4,400'], ['paddle 0417', '4,600'],
]

export const Product = forwardRef<HTMLElement>(function Product(_, ref) {
  const root = useRef<HTMLElement>(null)
  const [active, setActive] = useState(0)
  const [rows, setRows] = useState(0)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const rm = reducedMotion()
    const mm = gsap.matchMedia()

    mm.add('(min-width: 900px)', () => {
      ScrollTrigger.create({
        trigger: el,
        start: 'top top',
        end: `+=${SURFACES.length * 90}%`,
        pin: true,
        scrub: true,
        onUpdate: self => {
          const i = Math.min(SURFACES.length - 1, Math.floor(self.progress * SURFACES.length))
          setActive(i)
          // the ledger ticks while the room is the subject
          const seg = self.progress * SURFACES.length - 1
          setRows(Math.max(0, Math.min(BIDS.length, Math.round(seg * (BIDS.length + 1)))))
        },
      })
    })

    mm.add('(max-width: 899px)', () => {
      // stacked: reveal each vignette, tick the ledger once it is in view
      setActive(-1)
      ScrollTrigger.create({
        trigger: el.querySelector(`[data-vig="room"]`),
        start: 'top 70%',
        once: true,
        onEnter: () => {
          if (rm) { setRows(BIDS.length); return }
          let n = 0
          const id = window.setInterval(() => { n++; setRows(n); if (n >= BIDS.length) window.clearInterval(id) }, 420)
        },
      })
    })

    return () => mm.revert()
  }, [])

  return (
    <Band ref={node => { root.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }}
      id="product" tone="paper" className={s.product}>
      <div className={s.grid}>
        {/* ---- left: copy ---- */}
        <div className={s.copy}>
          <p className={s.eyebrow}><b>02</b>The product</p>
          {SURFACES.map((x, i) => (
            <div key={x.k} className={`${s.item} ${active === i || active === -1 ? s.on : ''}`} data-reveal={active === -1 ? 'copy' : undefined}>
              <span className={s.idx}>{String(i + 1).padStart(2, '0')}</span>
              <h3 className={s.t}>{x.t}</h3>
              <p className={s.d}>{x.d}</p>
            </div>
          ))}
        </div>

        {/* ---- right: vignettes ---- */}
        <div className={s.stage}>
          {/* the wall */}
          <figure className={`${s.vig} ${active === 0 || active === -1 ? s.show : ''}`} data-vig="wall">
            <div className={s.post}>
              <div className={s.postFrame}><img src="/art/a1.jpg" alt="" /></div>
              <div className={s.postLabel}>
                <div>
                  <span className={s.pArtist}>Kelechi Mba</span>
                  <em className={s.pTitle}>Indigo Vespers <small>2023</small></em>
                  <span className={s.pSpec}><i>Acrylic on canvas</i> · 170 × 210 cm · Lagos</span>
                </div>
                <span className={s.pFollow}>Follow</span>
              </div>
              <div className={s.postActs}><span className={s.pOn}>♥ 48</span><span>◯ 6</span><span>↗</span><span className={s.pKeep}>Keep</span></div>
            </div>
            <figcaption className={s.cap}>Post card · the feed</figcaption>
          </figure>

          {/* the room */}
          <figure className={`${s.vig} ${s.dark} ${active === 1 || active === -1 ? s.show : ''}`} data-vig="room">
            <div className={s.room}>
              <div className={s.roomHead}>
                <span>Harmattan Sale · Evening</span>
                <span className={s.live}><i />{rows >= BIDS.length ? 'Hammer' : 'Live'}</span>
              </div>
              <div className={s.roomBody}>
                <div className={s.lot}>
                  <img src="/art/a6.jpg" alt="" />
                  <div className={s.lotLabel}>
                    <b>Lot 7</b><em>Harmattan, Lagoon</em><span>Kelechi Mba · Oil on linen</span>
                  </div>
                </div>
                <ol className={s.ledger}>
                  {BIDS.slice(0, rows).reverse().map(([u, a], i) => (
                    <li key={u + a} className={i === 0 ? s.lead : ''}><span>{u}</span><b>₦{a},000</b></li>
                  ))}
                  {rows === 0 && <li className={s.empty}>The lot is on the block.</li>}
                </ol>
              </div>
              <div className={s.roomFoot}>
                <span>Your paddle · <b>0417</b></span>
                <span className={s.bidBtn}>Bid ₦4,800,000</span>
              </div>
            </div>
            <figcaption className={s.cap}>Auction room · bid panel</figcaption>
          </figure>

          {/* the control room */}
          <figure className={`${s.vig} ${active === 2 || active === -1 ? s.show : ''}`} data-vig="control">
            <div className={s.ctrl}>
              <aside className={s.ctrlRail}>
                {['Sales', 'Catalogue', 'Entry', 'Rostrum', 'Settlement', 'Payout'].map((x, i) => (
                  <span key={x} className={i === 3 ? s.railOn : ''}>{x}</span>
                ))}
              </aside>
              <div className={s.ctrlMain}>
                <div className={s.ctrlHead}><span>Rostrum</span><span className={s.ctrlSale}>Harmattan Sale · NGN · locked</span></div>
                <div className={s.ctrlNums}>
                  <div><small>On the block</small><b>Lot 7</b></div>
                  <div><small>Current</small><b>₦4,600,000</b></div>
                  <div><small>Bidders</small><b>14</b></div>
                </div>
                <table className={s.ctrlTable}>
                  <tbody>
                    {[['6', 'Adire Grid', 'Sold', '₦1,400,000'], ['7', 'Harmattan, Lagoon', 'On block', '₦4,600,000'], ['8', 'Two Seated', 'Sealed', '—']].map(r => (
                      <tr key={r[0]} className={r[2] === 'On block' ? s.trOn : ''}>
                        <td>{r[0]}</td><td><em>{r[1]}</em></td><td>{r[2]}</td><td>{r[3]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className={s.ctrlActs}><span className={s.hammer}>Hammer</span><span>Pass</span><span>Withdraw</span></div>
              </div>
            </div>
            <figcaption className={s.cap}>House control room · rostrum</figcaption>
          </figure>

          {/* step dots (desktop) */}
          <div className={s.dots} aria-hidden="true">
            {SURFACES.map((x, i) => <i key={x.k} className={active === i ? s.dotOn : ''} />)}
          </div>
        </div>
      </div>
    </Band>
  )
})
