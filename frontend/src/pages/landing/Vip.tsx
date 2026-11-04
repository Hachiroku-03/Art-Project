import { Link } from 'react-router-dom'
import { forwardRef } from 'react'
import { Band, bandStyles } from './Band'
import s from './Vip.module.css'

const MEMBER = ['Hang works, up to eight images each', 'Follow artists, keep works on your wall', 'Twenty-four-hour studio stories', 'Messenger — share a work or a live lot', 'Paddles for open rooms']
const VIP = ['Everything in Member', 'The purple ring on your profile and posts', 'Earlier sight of upcoming rooms', 'Standing in the room — your bids carry the mark', 'Monthly, billed from your Space Wallet', 'Cancel any time; access runs to the close of the paid period']

export const Vip = forwardRef<HTMLElement>(function Vip(_, ref) {
  return (
    <Band ref={ref} id="vip" tone="paper" index="06" eyebrow="Membership"
      title={<>Free to hang. <em>VIP</em> when you want the crown.</>}
      intro="One accent on the whole platform, and it is purple. VIP buys you a seat nearer the rostrum — never a louder feed.">
      <div className={s.tiers}>
        <article className={s.tier} data-reveal="tiers">
          <header className={s.head}>
            <span className={s.name}>Member</span>
            <span className={s.price}>Free</span>
          </header>
          <ul className={s.list}>{MEMBER.map(t => <li key={t}>{t}</li>)}</ul>
          <Link className={`${bandStyles.btnGhost} ${s.cta}`} to="/signup">Create an account</Link>
        </article>

        <article className={`${s.tier} ${s.vip}`} data-reveal="tiers">
          <header className={s.head}>
            <span className={s.name}>VIP</span>
            <span className={s.price}>Monthly<small> · from the wallet</small></span>
          </header>
          <ul className={s.list}>{VIP.map(t => <li key={t}>{t}</li>)}</ul>
          <Link className={`${bandStyles.btnDark} ${s.cta}`} to="/signup">Become a member</Link>
          <p className={s.fine}>Join first — VIP is switched on from inside your wallet. Lapsed or past-due memberships are swept on sign-in, never mid-room.</p>
        </article>
      </div>
    </Band>
  )
})
