import { Link } from 'react-router-dom'
import { forwardRef } from 'react'
import { Band, bandStyles } from './Band'
import s from './Closer.module.css'

export const Closer = forwardRef<HTMLElement>(function Closer(_, ref) {
  return (
    <Band ref={ref} id="join" tone="wall" center narrow
      title={<>The wall is <em>open</em>.</>}
      intro="Hang the first work. The room will fill itself.">
      <div className={`${bandStyles.btnRow} ${s.row}`} data-reveal="form">
        <Link className={`${bandStyles.btnDark}`} to="/signup">Create an account</Link>
        <Link className={`${bandStyles.btnGhost}`} to="/login">Log in</Link>
      </div>
      <p className={s.fine} data-reveal="form">Free to post, free to follow. Paddles when you're ready to bid. VIP when you want the ring.</p>
    </Band>
  )
})
