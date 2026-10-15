import { formatMoney, normalizeAccessMode, type Sale } from '../../lib/sales'
import { AccessBadge } from './AccessBadge'
import { CountdownTimer } from './CountdownTimer'
import styles from './sales.module.css'

export function SaleHero({ sale }: { sale: Sale }) {
  const remaining =
    sale.ticket_capacity != null && sale.tickets_sold != null
      ? Math.max(0, sale.ticket_capacity - sale.tickets_sold)
      : null

  const statusClass =
    sale.status === 'live'
      ? styles.badgeLive
      : sale.status === 'upcoming'
        ? styles.badgeUpcoming
        : styles.badgeEnded

  return (
    <section className={styles.hero}>
      {sale.image_url ? (
        <img className={styles.heroImage} src={sale.image_url} alt={sale.title} />
      ) : (
        <div className={styles.heroImage} />
      )}

      <div className={styles.heroBody}>
        <div className={styles.row}>
          <AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} />
          <span className={`${styles.badge} ${statusClass}`}>{sale.status}</span>
        </div>

        <h1 className={styles.title}>{sale.title}</h1>

        <p className={styles.subtitle}>
          Hosted by <strong>{sale.host_username}</strong>
        </p>

        {sale.description ? <p className={styles.small}>{sale.description}</p> : null}

        <div className={styles.meta}>
          <span>
            Paddle:{' '}
            {formatMoney(
              sale.ticket_price,
              sale.ticket_currency || sale.currency || 'NGN',
            )}
          </span>

          <span>Lots: {sale.lot_count ?? 0}</span>

          {remaining != null ? <span>Remaining: {remaining}</span> : null}

          {sale.status === 'upcoming' ? (
            <CountdownTimer
              target={sale.starts_at}
              label="Starts in"
              status={sale.status}
            />
          ) : sale.status === 'live' ? (
            <CountdownTimer
              target={sale.ends_at}
              label="Ends in"
              status={sale.status}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}