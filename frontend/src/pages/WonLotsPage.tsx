import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Gavel,
  XCircle,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import {
  fetchWonLots,
  formatMoney,
  type WonLot,
  type WonLotsSummary,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import styles from './WonLotsPage.module.css'

function paymentIcon(status: string) {
  if (status === 'paid') return <CheckCircle2 size={14} />
  if (status === 'pending') return <Clock size={14} />
  if (status === 'failed') return <XCircle size={14} />
  return <CreditCard size={14} />
}

function paymentLabel(status: string) {
  if (status === 'paid') return 'Paid'
  if (status === 'pending') return 'Payment pending'
  if (status === 'failed') return 'Payment failed'
  return 'Unpaid'
}

function paymentClass(status: string) {
  if (status === 'paid') return styles.paid
  if (status === 'pending') return styles.pending
  if (status === 'failed') return styles.failed
  return styles.unpaid
}

export function WonLotsPage() {
  const navigate = useNavigate()
  const viewer = getViewer()

  const [lots, setLots] = useState<WonLot[]>([])
  const [summary, setSummary] = useState<WonLotsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!viewer) {
      navigate('/login', { replace: true })
      return
    }

    let alive = true

    fetchWonLots(viewer).then(d => {
      if (!alive) return

      if (d.error) {
        setError(d.error)
      } else {
        setLots(d.lots || [])
        setSummary(d.summary || null)
        setError('')
      }

      setLoading(false)
    })

    return () => {
      alive = false
    }
  }, [viewer, navigate])

  if (loading) {
    return (
      <main className={styles.page}>
        <Navbar />
        <div className={styles.loading}>Loading your won lots…</div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <Navbar />

      <div className={styles.shell}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>Won lots</h1>
            <p className={styles.sub}>
              Lots you have won, the amount payable, and payment status.
            </p>
          </div>

          <button className={styles.browseBtn} onClick={() => navigate('/auctions')}>
            Browse the floor
          </button>
        </header>

        {error ? <div className={styles.error}>{error}</div> : null}

        {summary ? (
          <section className={styles.summary}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Won lots</span>
              <strong className={styles.statValue}>{summary.count}</strong>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>Hammer total</span>
              <strong className={styles.statValue}>
                {formatMoney(summary.total_hammer, summary.currency)}
              </strong>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>Buyer premium</span>
              <strong className={styles.statValue}>
                {formatMoney(summary.total_premium, summary.currency)}
              </strong>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>Total payable</span>
              <strong className={styles.statValue}>
                {formatMoney(summary.total_collected, summary.currency)}
              </strong>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>Paid</span>
              <strong className={`${styles.statValue} ${styles.paidText}`}>
                {formatMoney(summary.total_paid, summary.currency)}
              </strong>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>Outstanding</span>
              <strong className={`${styles.statValue} ${styles.outstanding}`}>
                {formatMoney(summary.total_outstanding, summary.currency)}
              </strong>
            </div>
          </section>
        ) : null}

        {lots.length === 0 ? (
          <div className={styles.empty}>
            <Gavel size={30} />
            <p>You have not won any lots yet.</p>
            <button className={styles.primaryBtn} onClick={() => navigate('/auctions')}>
              Browse live and upcoming rooms
            </button>
          </div>
        ) : (
          <div className={styles.list}>
            {lots.map(lot => {
              const status = String(lot.payment_status || 'unpaid').toLowerCase()
              const canPay = status !== 'paid' && Boolean(lot.checkout_url)

              return (
                <article key={lot.lot_id} className={styles.card}>
                  <div className={styles.media}>
                    {lot.lot_image_url ? (
                      <img
                        src={lot.lot_image_url}
                        alt={lot.lot_title || `Lot ${lot.position}`}
                      />
                    ) : (
                      <div className={styles.mediaBlank}>
                        <Gavel size={24} />
                      </div>
                    )}
                  </div>

                  <div className={styles.body}>
                    <div className={styles.top}>
                      <div className={styles.identity}>
                        <p className={styles.sale}>{lot.sale_title}</p>
                        <h2 className={styles.lotTitle}>
                          Lot {lot.position} · {lot.lot_title || 'Untitled'}
                        </h2>
                        <p className={styles.host}>
                          Hosted by @{lot.host_username}
                        </p>
                      </div>

                      <span className={`${styles.status} ${paymentClass(status)}`}>
                        {paymentIcon(status)}
                        {paymentLabel(status)}
                      </span>
                    </div>

                    {lot.lot_description ? (
                      <p className={styles.desc}>{lot.lot_description}</p>
                    ) : null}

                    <div className={styles.moneyGrid}>
                      <div className={styles.moneyBox}>
                        <span>Hammer</span>
                        <strong>{formatMoney(lot.hammer, lot.currency)}</strong>
                      </div>

                      <div className={styles.moneyBox}>
                        <span>Buyer premium</span>
                        <strong>{formatMoney(lot.premium, lot.currency)}</strong>
                      </div>

                      <div className={styles.moneyBox}>
                        <span>Total payable</span>
                        <strong>{formatMoney(lot.collected, lot.currency)}</strong>
                      </div>
                    </div>

                    <div className={styles.actions}>
                      <button
                        className={styles.secondaryBtn}
                        onClick={() => navigate(`/sales/${lot.sale_id}`)}
                      >
                        View sale
                      </button>

                      {canPay ? (
                        <a
                          className={styles.primaryBtn}
                          href={lot.checkout_url || '#'}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Pay now
                          <ExternalLink size={14} />
                        </a>
                      ) : status === 'paid' ? (
                        <span className={styles.paidNote}>Payment received.</span>
                      ) : status === 'pending' ? (
                        <span className={styles.waitNote}>
                          Payment is being processed.
                        </span>
                      ) : status === 'failed' ? (
                        <span className={styles.failNote}>
                          Payment failed. The house can retry collection.
                        </span>
                      ) : (
                        <span className={styles.waitNote}>
                          Payment link will be issued after settlement.
                        </span>
                      )}
                    </div>

                    {lot.payment_reference ? (
                      <p className={styles.reference}>
                        Payment reference: <code>{lot.payment_reference}</code>
                      </p>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}