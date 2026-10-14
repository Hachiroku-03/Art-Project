import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchSales, formatMoney, normalizeAccessMode, type Sale } from '../lib/sales'
import { getViewer } from '../lib/session'
import { AccessBadge } from '../components/sales/AccessBadge'
import { CountdownTimer } from '../components/sales/CountDownTimer'
import styles from '../components/sales/sales.module.css'

export function AuctionFloorPage() {
  const viewer = getViewer()
  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true

    async function load() {
      setLoading(true)
      setError('')

      const d = await fetchSales(viewer)

      if (!alive) return

      if (d.error) setError(d.error)
      else setSales(d.sales || [])

      setLoading(false)
    }

    void load()

    return () => {
      alive = false
    }
  }, [viewer])

  return (
    <main className={styles.page}>
      <div className={styles.narrow}>
        <div className={styles.between}>
          <h1 className={styles.title}>Auction floor</h1>
          <span className={styles.muted}>{sales.length} visible sales</span>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        {loading ? (
          <p className={styles.loading}>Loading auctions…</p>
        ) : !sales.length ? (
          <p className={styles.muted}>No auctions are visible right now.</p>
        ) : (
          <div className={styles.grid}>
            {sales.map(sale => {
              const remaining =
                sale.ticket_capacity != null && sale.tickets_sold != null
                  ? Math.max(0, sale.ticket_capacity - sale.tickets_sold)
                  : null

              const soldOut = remaining === 0

              return (
                <Link key={sale.id} className={styles.card} to={`/sales/${sale.id}`}>
                  {sale.image_url ? (
                    <img className={styles.cardImage} src={sale.image_url} alt={sale.title} />
                  ) : (
                    <div className={styles.cardImage} />
                  )}

                  <div className={styles.cardBody}>
                    <div className={styles.row}>
                      <AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} />

                      <span
                        className={`${styles.badge} ${
                          sale.status === 'live'
                            ? styles.badgeLive
                            : sale.status === 'upcoming'
                              ? styles.badgeUpcoming
                              : styles.badgeEnded
                        }`}
                      >
                        {sale.status}
                      </span>
                    </div>

                    <div className={styles.cardTitle}>{sale.title}</div>

                    <div className={styles.cardMeta}>
                      {sale.host_username} · {sale.lot_count ?? 0} lots
                    </div>

                    <div className={styles.cardMeta}>
                      Paddle: {formatMoney(sale.ticket_price, sale.ticket_currency || sale.currency || 'NGN')}
                    </div>

                    {soldOut ? (
                      <div className={styles.cardMeta}>Sold out</div>
                    ) : remaining != null ? (
                      <div className={styles.cardMeta}>{remaining} remaining</div>
                    ) : null}

                    {sale.status === 'upcoming' ? (
                      <CountdownTimer target={sale.starts_at} label="Starts in" status={sale.status} />
                    ) : sale.status === 'live' ? (
                      <CountdownTimer target={sale.ends_at} label="Ends in" status={sale.status} />
                    ) : null}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}