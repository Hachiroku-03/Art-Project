import { useEffect, useState } from 'react'
import { Crown, Lock, Gavel, Ticket } from 'lucide-react'
import { type Sale, formatRemaining, normalizeAccessMode } from '../../lib/sales'
import styles from './SaleCard.module.css'

type Props = { sale: Sale; onOpen: () => void }

function parse(raw: string | null | undefined) {
  return raw ? new Date(raw.replace(' ', 'T')).getTime() : null
}

function accessMode(sale: Sale) {
  return normalizeAccessMode((sale as any).access_mode ?? sale.tier)
}

export function SaleCard({ sale, onOpen }: Props) {
  const [now, setNow] = useState(Date.now())

  const target =
    sale.status === 'live'
      ? parse(sale.ends_at)
      : sale.status === 'upcoming'
        ? parse(sale.starts_at)
        : null

  useEffect(() => {
    if (target == null) return

    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [target])

  const mode = accessMode(sale)

  const statusPill =
    sale.status === 'live' ? (
      <span className={`${styles.pill} ${styles.pillLive}`}>
        <i /> Live
      </span>
    ) : sale.status === 'ended' ? (
      <span className={`${styles.pill} ${styles.pillEnded}`}>Ended</span>
    ) : (
      <span className={`${styles.pill} ${styles.pillUpcoming}`}>Upcoming</span>
    )

  const tierTag =
    mode === 'vip' ? (
      <span className={`${styles.tier} ${styles.tierVip}`}>
        <Crown size={10} /> VIP
      </span>
    ) : mode === 'invite' ? (
      <span className={`${styles.tier} ${styles.tierInvite}`}>
        <Lock size={10} /> Invite
      </span>
    ) : (
      <span className={styles.tier}>Open</span>
    )

  const remaining = target != null ? formatRemaining(Math.max(0, target - now)) : ''
  const scrimLabel = sale.status === 'live' ? 'hammer in' : sale.status === 'upcoming' ? 'opens in' : ''

  const isPrivate =
    mode !== 'open' ||
    Boolean((sale as any).locked) ||
    Boolean((sale as any).needs_ticket)

  const ticketsRemaining = (sale as any).tickets_remaining as number | null | undefined
  const ticketsSold = (sale as any).tickets_sold as number | null | undefined
  const capacity = (sale as any).ticket_capacity as number | null | undefined

  let paddleText = ''

  if (capacity != null) {
    if (ticketsRemaining === 0) {
      paddleText = 'Sold out'
    } else if (typeof ticketsRemaining === 'number') {
      paddleText = `${ticketsRemaining} paddles left`
    } else if (typeof ticketsSold === 'number') {
      paddleText = `${ticketsSold}/${capacity} paddles`
    }
  }

  return (
    <article
      className={styles.card}
      onClick={onOpen}
      role="link"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className={styles.media}>
        {sale.image_url ? (
          <img className={styles.img} src={sale.image_url} alt={sale.title} />
        ) : (
          <div className={styles.imgBlank} />
        )}

        <div className={styles.pillRow}>{statusPill}</div>

        {remaining && (
          <div className={styles.scrim}>
            <span className={styles.scrimLabel}>{scrimLabel}</span>
            <span className={styles.scrimTime}>{remaining}</span>
          </div>
        )}
      </div>

      <div className={styles.body}>
        <h3 className={styles.title}>{sale.title}</h3>

        <div className={styles.metaRow}>
          <span className={styles.host}>@{sale.host_username}</span>
          {tierTag}
        </div>

        <div className={styles.foot}>
          <span className={styles.lots}>
            <Gavel size={11} /> {sale.lot_count ?? 0} lots
          </span>

          {paddleText ? (
            <span className={styles.lots}>
              <Ticket size={11} /> {paddleText}
            </span>
          ) : null}

          {isPrivate ? <span className={styles.rope}>private</span> : null}
        </div>
      </div>
    </article>
  )
}