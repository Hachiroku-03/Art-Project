import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  CheckCircle2,
  Clock,
  CreditCard,
  Gavel,
  RefreshCw,
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
import { WonLotPayButton } from '../components/wins/WonLotPayButton'
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
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  const viewer = getViewer()

  const focusLotId = Number(
    (location.state as { lotId?: number | string } | null)?.lotId || 0,
  )

  const [lots, setLots] = useState<WonLot[]>([])
  const [summary, setSummary] = useState<WonLotsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const mountedRef = useRef(false)
  const loadSeq = useRef(0)
  const inFlight = useRef(false)
  const queuedMode = useRef<'initial' | 'background' | null>(null)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(
    async (mode: 'initial' | 'background' = 'initial') => {
      if (!viewer) return

      if (inFlight.current) {
        if (mode === 'initial' || queuedMode.current === null) {
          queuedMode.current = mode
        }

        return
      }

      inFlight.current = true

      const seq = ++loadSeq.current

      if (mode === 'initial') {
        setLoading(true)
      } else {
        setRefreshing(true)
      }

      setError('')

      try {
        const d = await fetchWonLots(viewer)

        if (!mountedRef.current || seq !== loadSeq.current) return

        if (d.error) {
          setError(d.error)
        } else {
          setLots(d.lots || [])
          setSummary(d.summary || null)
          setError('')
        }
      } catch {
        if (mountedRef.current && seq === loadSeq.current) {
          setError('Could not load your won lots.')
        }
      } finally {
        inFlight.current = false

        if (mountedRef.current && seq === loadSeq.current) {
          setLoading(false)
          setRefreshing(false)
        }

        const next = queuedMode.current
        queuedMode.current = null

        if (next) {
          void load(next)
        }
      }
    },
    [viewer],
  )

  // Auth guard + initial load.
  useEffect(() => {
    if (!viewer || !localStorage.getItem('space_token')) {
      setLoading(false)
      navigate('/login', { replace: true })
      return
    }

    void load('initial')
  }, [viewer, navigate, load])

  // Scroll to focused lot from notification deep link.
  useEffect(() => {
    if (!focusLotId || !lots.length) return

    const el = document.getElementById(`won-lot-${focusLotId}`)

    if (el) {
      window.setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 120)
    }
  }, [focusLotId, lots])

  // Refresh when tab regains focus or becomes visible.
  // This catches the buyer returning from Paystack in another tab.
  useEffect(() => {
    if (!viewer) return

    const onFocus = () => void load('background')

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load('background')
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [viewer, load])

  // Handle Paystack callback: /wins?payment=completed
  useEffect(() => {
    if (searchParams.get('payment') !== 'completed') return

    setNotice('Payment return detected. Refreshing your won lots…')
    void load('initial')

    const next = new URLSearchParams(searchParams)
    next.delete('payment')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, load])

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

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
            }}
          >
            {refreshing ? (
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-faint, #888)',
                  background: 'rgba(20, 18, 15, 0.04)',
                  border: '1px solid var(--line, #e4dfd7)',
                  borderRadius: 999,
                  padding: '0.3rem 0.6rem',
                }}
              >
                updating…
              </span>
            ) : null}

            <button
              className={styles.secondaryBtn}
              onClick={() => void load('initial')}
              disabled={refreshing}
            >
              <RefreshCw size={14} />
              Refresh
            </button>

            <button className={styles.browseBtn} onClick={() => navigate('/auctions')}>
              Browse the floor
            </button>
          </div>
        </header>

        {error ? (
          <div className={styles.error}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <span>{error}</span>

              <button
                className={styles.secondaryBtn}
                onClick={() => void load('initial')}
                disabled={refreshing}
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div
            style={{
              margin: '0 0 1rem',
              padding: '0.65rem 0.8rem',
              borderRadius: 14,
              fontSize: '0.86rem',
              color: '#166534',
              background: 'rgba(22, 101, 52, 0.08)',
              border: '1px solid rgba(22, 101, 52, 0.16)',
            }}
          >
            {notice}
          </div>
        ) : null}

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

            {error ? (
              <>
                <p>Your won lots could not be loaded.</p>

                <button
                  className={styles.primaryBtn}
                  onClick={() => void load('initial')}
                  disabled={refreshing}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <p>You have not won any lots yet.</p>

                <button
                  className={styles.primaryBtn}
                  onClick={() => navigate('/auctions')}
                >
                  Browse live and upcoming rooms
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={styles.list}>
            {lots.map(lot => {
              const status = String(lot.payment_status || 'unpaid').toLowerCase()
              const isPaid = status === 'paid'

              const collectionReady =
                Boolean((lot as any).collection_ready) ||
                (lot.sale_status === 'ended' && !!lot.settled_at)

              return (
                <article
                  key={lot.lot_id}
                  id={`won-lot-${lot.lot_id}`}
                  className={`${styles.card} ${
                    focusLotId === lot.lot_id ? styles.cardFocus : ''
                  }`}
                >
                  <div className={styles.media}>
                    {lot.lot_image_url ? (
                      <img
                        src={lot.lot_image_url}
                        alt={lot.lot_title || `Lot ${lot.position}`}
                        loading="lazy"
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

                        <p className={styles.host}>Hosted by @{lot.host_username}</p>
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

                      {isPaid ? (
                        <span className={styles.paidNote}>Payment received.</span>
                      ) : collectionReady ? (
                        <WonLotPayButton
                          lot={lot}
                          viewer={viewer}
                          onOpened={() => void load('background')}
                        />
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