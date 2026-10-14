import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  fetchLotBids,
  getSaleView,
  formatMoney,
  placeLotBid,
  type Lot,
  type LotBid,
  type Sale,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import styles from '../components/sales/sales.module.css'

export function LiveRoomPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const id = Number(saleId)
  const viewer = getViewer()

  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [bids, setBids] = useState<LotBid[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [amount, setAmount] = useState('')

  const lastBidIdRef = useRef(0)

  const currentLot = lots.find(l => l.status === 'on_block') || null
  const lotId = currentLot?.id

  const load = useCallback(async () => {
    if (!Number.isFinite(id)) {
      setError('Invalid sale id.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await getSaleView(id, viewer)

    if (d.error) {
      setError(d.error)
      setSale(null)
      setLots([])
    } else {
      setSale(d.sale || null)
      setLots(d.lots || [])
    }

    setLoading(false)
  }, [id, viewer])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!lotId) {
      setBids([])
      lastBidIdRef.current = 0
      return
    }

    let alive = true
    lastBidIdRef.current = 0
    setBids([])

    const loadBids = async () => {
      const rows = await fetchLotBids(lotId, lastBidIdRef.current)
      if (!alive || !rows.length) return

      setBids(prev => [...prev, ...rows])
      lastBidIdRef.current = Math.max(lastBidIdRef.current, ...rows.map(r => r.id))
    }

    void loadBids()
    const t = setInterval(() => void loadBids(), 3000)

    return () => {
      alive = false
      clearInterval(t)
    }
  }, [lotId])

  const submitBid = async () => {
    if (!currentLot) return

    const n = Number(amount)

    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a valid bid amount.')
      return
    }

    setBusy(true)
    setError('')

    const r = await placeLotBid(currentLot.id, viewer, n)

    if (r.error) {
      setError(r.error)
      setBusy(false)
      return
    }

    setAmount('')
    await load()
    setBusy(false)
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <p className={styles.loading}>Loading room…</p>
        </div>
      </main>
    )
  }

  if (!sale) {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <div className={styles.error}>{error || 'Sale not found.'}</div>
          <Link className={styles.back} to="/auctions">
            Back to auctions
          </Link>
        </div>
      </main>
    )
  }

  if (!sale.has_ticket && !sale.is_host) {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <div className={styles.error}>You need a paddle to enter this room.</div>
          <Link className={styles.back} to={`/sales/${sale.id}`}>
            Back to sale
          </Link>
        </div>
      </main>
    )
  }

  if (sale.status !== 'live') {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <div className={styles.panel}>
            <h1 className={styles.title}>{sale.title}</h1>
            <p className={styles.muted}>This sale is not live right now.</p>
            <Link className={styles.back} to={`/sales/${sale.id}`}>
              Back to sale
            </Link>
          </div>
        </div>
      </main>
    )
  }

  const currency = currentLot?.currency || sale.currency || 'NGN'

  return (
    <main className={styles.page}>
      <div className={styles.narrow}>
        <Link className={styles.back} to={`/sales/${sale.id}`}>
          ← Back to sale
        </Link>

        <div className={styles.roomGrid}>
          <section className={styles.panel}>
            <div className={styles.between}>
              <h1 className={styles.panelTitle}>{sale.title}</h1>
              <span className={`${styles.badge} ${styles.badgeLive}`}>Live</span>
            </div>

            {!currentLot ? (
              <p className={styles.muted}>No lot is currently on the block. Wait for the house to reveal the next lot.</p>
            ) : (
              <>
                <div className={styles.lotTitle}>
                  Lot {currentLot.position} — {currentLot.title || 'Untitled'}
                </div>

                {currentLot.image_url ? (
                  <img className={styles.lotImage} src={currentLot.image_url} alt={currentLot.title || 'Lot'} />
                ) : null}

                {currentLot.description ? <p className={styles.small}>{currentLot.description}</p> : null}

                <div className={styles.meta}>
                  <span>Starting: {formatMoney(currentLot.starting_price, currency)}</span>
                  <span>Current bid: {formatMoney(currentLot.current_bid, currency)}</span>
                  <span>Bids: {currentLot.bid_count ?? 0}</span>
                </div>

                {(currentLot.estimate_low || currentLot.estimate_high) && (
                  <div className={styles.small}>
                    Estimate: {formatMoney(currentLot.estimate_low, currency)} –{' '}
                    {formatMoney(currentLot.estimate_high, currency)}
                  </div>
                )}

                {error ? <div className={styles.error}>{error}</div> : null}

                <div className={styles.row}>
                  <input
                    className={styles.input}
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="Bid amount"
                    inputMode="decimal"
                  />

                  <button className={styles.button} onClick={() => void submitBid()} disabled={busy}>
                    {busy ? 'Placing…' : 'Place bid'}
                  </button>
                </div>
              </>
            )}
          </section>

          <aside className={`${styles.panel} ${styles.sticky}`}>
            <h2 className={styles.panelTitle}>Bid feed</h2>

            {!currentLot ? (
              <p className={styles.muted}>Waiting for the next lot…</p>
            ) : !bids.length ? (
              <p className={styles.muted}>No bids yet.</p>
            ) : (
              <div className={styles.bidList}>
                {bids
                  .slice()
                  .reverse()
                  .map(b => (
                    <div key={b.id} className={styles.bidRow}>
                      <span>{b.user_name}</span>
                      <strong>{formatMoney(b.amount, currency)}</strong>
                    </div>
                  ))}
              </div>
            )}

            {sale.stream_url ? (
              <>
                <h2 className={styles.panelTitle}>Stream</h2>
                <a className={styles.button} href={sale.stream_url} target="_blank" rel="noreferrer">
                  Open stream
                </a>
              </>
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  )
}