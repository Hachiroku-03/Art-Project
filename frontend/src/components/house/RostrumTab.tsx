import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  endSale,
  fetchLotBids,
  formatMoney,
  getSaleView,
  goLive,
  hammerLot,
  passLot,
  revealNext,
  type Lot,
  type LotBid,
  type MySale,
  type Sale,
} from '../../lib/sales'
import styles from './control.module.css'

function saleStatusLabel(status: string) {
  if (status === 'live') return 'Live'
  if (status === 'upcoming') return 'Upcoming'
  if (status === 'ended') return 'Ended'
  return status
}

function formatClock(value?: string | null) {
  if (!value) return ''
  const d = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function RostrumTab({
  sales,
  selectedSaleId,
  viewer,
  reload,
}: {
  sales: MySale[]
  selectedSaleId: number | null
  viewer: string
  reload: () => void
}) {
  const [saleId, setSaleId] = useState<number | null>(selectedSaleId)
  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [bids, setBids] = useState<LotBid[]>([])
  const lastBidIdRef = useRef(0)

  useEffect(() => {
    if (selectedSaleId) setSaleId(selectedSaleId)
  }, [selectedSaleId])

  useEffect(() => {
    if (!saleId && sales.length) {
      setSaleId(sales[0].id)
    }
  }, [saleId, sales])

  const load = useCallback(async () => {
    if (!saleId) {
      setSale(null)
      setLots([])
      return
    }

    if (!viewer) {
      setError('No signed-in house detected.')
      setSale(null)
      setLots([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await getSaleView(saleId, viewer)

    if (d.error) {
      setError(d.error)
      setSale(null)
      setLots([])
    } else {
      setSale(d.sale || null)
      setLots(d.lots || [])
    }

    setLoading(false)
  }, [saleId, viewer])

  useEffect(() => {
    void load()
  }, [load])

  const currentLot = useMemo(
    () => lots.find(l => l.status === 'on_block') || null,
    [lots],
  )

  const nextSealedLot = useMemo(
    () => lots.find(l => l.status === 'sealed') || null,
    [lots],
  )

  const sealedCount = useMemo(
    () => lots.filter(l => l.status === 'sealed').length,
    [lots],
  )

  const soldCount = useMemo(
    () => lots.filter(l => l.status === 'sold').length,
    [lots],
  )

  const passedCount = useMemo(
    () => lots.filter(l => l.status === 'passed').length,
    [lots],
  )

  const currency = sale?.currency || 'NGN'

  // Poll live bids for the current lot.
  useEffect(() => {
    const lotId = currentLot?.id

    if (!lotId) {
      setBids([])
      lastBidIdRef.current = 0
      return
    }

    let alive = true
    lastBidIdRef.current = 0
    setBids([])

    async function tick() {
      if (!lotId) return

      const fresh = await fetchLotBids(lotId, lastBidIdRef.current)

      if (!alive) return

      if (fresh.length) {
        setBids(prev => [...prev, ...fresh])
        lastBidIdRef.current = Math.max(
          lastBidIdRef.current,
          ...fresh.map(b => b.id),
        )
      }
    }

    void tick()

    const timer = window.setInterval(() => {
      void tick()
    }, 2000)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [currentLot?.id])

  const topBid = useMemo(() => {
    if (!bids.length) return currentLot?.current_bid || null

    return bids.reduce(
      (max, b) => (Number(b.amount) > Number(max) ? b.amount : max),
      bids[0].amount,
    )
  }, [bids, currentLot?.current_bid])

  const bidCount = bids.length || Number(currentLot?.bid_count || 0)

  const run = async (
    fn: () => Promise<any>,
    success: string | ((res: any) => string),
  ) => {
    if (!viewer || !saleId) return

    setBusy(true)
    setError('')
    setNotice('')

    try {
      const res = await fn()

      if (res?.error) {
        setError(res.error)
        return
      }

      setNotice(typeof success === 'function' ? success(res) : success)

      await load()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleGoLive = async () => {
    if (!saleId) return
    await run(() => goLive(saleId, viewer), 'Sale is now live.')
  }

  const handleRevealNext = async () => {
    if (!saleId) return
    await run(
      () => revealNext(saleId, viewer),
      res => `Lot ${res.lot?.position ?? '?'} is now on the block.`,
    )
  }

  const handleHammer = async () => {
    if (!currentLot) return

    const ok = window.confirm(
      `Hammer Lot ${currentLot.position}? This will sell it to the top bidder if reserve is met, otherwise pass it.`,
    )
    if (!ok) return

    await run(
      () => hammerLot(currentLot.id, viewer),
      res => {
        if (res.message === 'sold') {
          return `Sold Lot ${currentLot.position} to ${res.winner || 'winner'} at ${formatMoney(
            res.sold_price,
            currency,
          )}.`
        }

        return `Lot ${currentLot.position} passed. ${res.reason || ''}`.trim()
      },
    )
  }

  const handlePass = async () => {
    if (!currentLot) return

    const ok = window.confirm(`Pass Lot ${currentLot.position} without selling?`)
    if (!ok) return

    await run(() => passLot(currentLot.id, viewer), `Lot ${currentLot.position} passed.`)
  }

  const handleEnd = async () => {
    if (!saleId) return

    const msg =
      sealedCount > 0
        ? `There are still ${sealedCount} sealed lots. Ending now will leave them unsold. End sale anyway?`
        : 'End this sale?'

    const ok = window.confirm(msg)
    if (!ok) return

    await run(() => endSale(saleId, viewer), 'Sale ended.')
  }

  const canGoLive = sale?.status === 'upcoming'
  const canReveal = sale?.status === 'live' && !currentLot && sealedCount > 0
  const canHammer = sale?.status === 'live' && !!currentLot
  const canPass = canHammer
  const canEnd = sale?.status === 'live' && !currentLot

  return (
    <div className={styles.panel}>
      <div className={styles.rostrumTop}>
        <div>
          <h2 className={styles.panelTitle} style={{ margin: 0 }}>
            Rostrum / Live
          </h2>

          {sale ? (
            <>
              <div className={styles.muted}>
                {sale.title} · Sale #{sale.id}
              </div>

              <div className={styles.rostrumMeta}>
                <span>Status: {saleStatusLabel(sale.status)}</span>
                <span>Lots: {lots.length}</span>
                <span>Sealed: {sealedCount}</span>
                <span>Sold: {soldCount}</span>
                <span>Passed: {passedCount}</span>
              </div>
            </>
          ) : (
            <div className={styles.muted}>Select a sale to control the rostrum.</div>
          )}
        </div>

        <div className={styles.actions}>
          <select
            className={`${styles.select} ${styles.salePicker}`}
            value={saleId ?? ''}
            onChange={e => {
              const value = e.target.value
              setSaleId(value ? Number(value) : null)
              setNotice('')
              setError('')
            }}
          >
            <option value="">Select a sale…</option>
            {sales.map(s => (
              <option key={s.id} value={s.id}>
                {s.title} · #{s.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!viewer ? (
        <div className={styles.error}>
          No signed-in house detected. Sign in again, or make login call `setSession(...)`.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}
      {notice ? <p className={styles.noticeOk}>{notice}</p> : null}

      {!sales.length ? (
        <div className={styles.empty}>
          No sales yet. Create a sale first in the <strong>Sales / Auctions</strong> tab.
        </div>
      ) : loading ? (
        <p className={styles.muted}>Loading rostrum…</p>
      ) : !sale ? (
        <p className={styles.muted}>Select a sale.</p>
      ) : !sale.is_host ? (
        <div className={styles.error}>You are not the host of this sale.</div>
      ) : (
        <>
          <div className={styles.actionRow}>
            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void handleGoLive()}
              disabled={busy || !canGoLive}
            >
              Go live
            </button>

            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void handleRevealNext()}
              disabled={busy || !canReveal}
            >
              Reveal next lot
            </button>

            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void handleHammer()}
              disabled={busy || !canHammer}
            >
              Hammer
            </button>

            <button
              className={styles.linkButton}
              onClick={() => void handlePass()}
              disabled={busy || !canPass}
            >
              Pass
            </button>

            <button
              className={`${styles.linkButton} ${styles.dangerLink}`}
              onClick={() => void handleEnd()}
              disabled={busy || !canEnd}
            >
              End sale
            </button>
          </div>

          <div className={styles.statRow}>
            <div className={styles.statBox}>
              <span className={styles.statLabel}>Room</span>
              <span className={styles.statValue}>
                {sale.status === 'live' ? 'Live' : saleStatusLabel(sale.status)}
              </span>
            </div>

            <div className={styles.statBox}>
              <span className={styles.statLabel}>On block</span>
              <span className={styles.statValue}>
                {currentLot ? `Lot ${currentLot.position}` : '—'}
              </span>
            </div>

            <div className={styles.statBox}>
              <span className={styles.statLabel}>Next sealed</span>
              <span className={styles.statValue}>
                {nextSealedLot ? `Lot ${nextSealedLot.position}` : 'None'}
              </span>
            </div>

            <div className={styles.statBox}>
              <span className={styles.statLabel}>Current bid</span>
              <span className={styles.statValue}>{formatMoney(topBid, currency)}</span>
            </div>

            <div className={styles.statBox}>
              <span className={styles.statLabel}>Bids</span>
              <span className={styles.statValue}>{bidCount}</span>
            </div>
          </div>

          {currentLot ? (
            <div className={styles.rostrumGrid}>
              <section className={styles.currentLotPanel}>
                <div className={styles.panelTitleSmall}>Current lot</div>

                <div className={styles.lotMediaRow}>
                  {currentLot.image_url ? (
                    <img
                      className={styles.lotHeroImage}
                      src={currentLot.image_url}
                      alt={currentLot.title || `Lot ${currentLot.position}`}
                    />
                  ) : (
                    <div className={styles.lotHeroBlank} />
                  )}

                  <div className={styles.lotHeroBody}>
                    <div className={styles.lotHeroTitle}>
                      Lot {currentLot.position} · {currentLot.title || 'Untitled'}
                    </div>

                    {currentLot.description ? (
                      <div className={styles.lotHeroDesc}>{currentLot.description}</div>
                    ) : (
                      <div className={styles.lotHeroDesc}>No description supplied.</div>
                    )}
                  </div>
                </div>

                <div className={styles.lotMoneyGrid}>
                  <div className={styles.lotMoneyBox}>
                    <span className={styles.lotMoneyLabel}>Starting</span>
                    <span className={styles.lotMoneyValue}>
                      {formatMoney(currentLot.starting_price, currentLot.currency || currency)}
                    </span>
                  </div>

                  <div className={styles.lotMoneyBox}>
                    <span className={styles.lotMoneyLabel}>Reserve</span>
                    <span className={styles.lotMoneyValue}>
                      {formatMoney(currentLot.reserve, currentLot.currency || currency)}
                    </span>
                  </div>

                  <div className={styles.lotMoneyBox}>
                    <span className={styles.lotMoneyLabel}>Estimate</span>
                    <span className={styles.lotMoneyValue}>
                      {currentLot.estimate_low || currentLot.estimate_high
                        ? `${formatMoney(
                            currentLot.estimate_low,
                            currentLot.currency || currency,
                          )} – ${formatMoney(
                            currentLot.estimate_high,
                            currentLot.currency || currency,
                          )}`
                        : '—'}
                    </span>
                  </div>

                  <div className={styles.lotMoneyBox}>
                    <span className={styles.lotMoneyLabel}>Current bid</span>
                    <span className={styles.lotMoneyValue}>
                      {formatMoney(topBid, currentLot.currency || currency)}
                    </span>
                  </div>
                </div>
              </section>

              <aside className={styles.bidFeedPanel}>
                <div className={styles.panelTitleSmall}>Live bids</div>

                {bids.length ? (
                  <div className={styles.bidFeed}>
                    {[...bids]
                      .reverse()
                      .slice(0, 30)
                      .map(b => (
                        <div key={b.id} className={styles.bidRow}>
                          <div style={{ minWidth: 0 }}>
                            <div className={styles.bidUser}>@{b.user_name}</div>
                            <div className={styles.bidTime}>{formatClock(b.created_at)}</div>
                          </div>

                          <div className={styles.bidAmount}>
                            {formatMoney(b.amount, currentLot.currency || currency)}
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    No bids yet. Bidders with paddles can bid once this lot is on the block.
                  </div>
                )}
              </aside>
            </div>
          ) : (
            <div className={styles.emptyState}>
              No lot is currently on the block.
              {sealedCount > 0
                ? ' Click “Reveal next lot” to bring the next sealed lot to the rostrum.'
                : ' All lots have been dealt. You can end the sale.'}
            </div>
          )}

          <div className={styles.tableWrap} style={{ marginTop: '1rem' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Status</th>
                  <th>Lot</th>
                  <th>Starting</th>
                  <th>Reserve</th>
                  <th>Current</th>
                  <th>Sold</th>
                  <th>Winner</th>
                  <th>Payment</th>
                </tr>
              </thead>

              <tbody>
                {lots.length ? (
                  lots.map(lot => (
                    <tr key={lot.id}>
                      <td className={styles.nowrap}>{lot.position}</td>
                      <td className={styles.nowrap}>{lot.status}</td>
                      <td>{lot.title || `Lot ${lot.position}`}</td>
                      <td className={styles.nowrap}>
                        {formatMoney(lot.starting_price, lot.currency || currency)}
                      </td>
                      <td className={styles.nowrap}>
                        {formatMoney(lot.reserve, lot.currency || currency)}
                      </td>
                      <td className={styles.nowrap}>
                        {formatMoney(lot.current_bid, lot.currency || currency)}
                      </td>
                      <td className={styles.nowrap}>
                        {formatMoney(lot.sold_price, lot.currency || currency)}
                      </td>
                      <td>{lot.winner_username || '—'}</td>
                      <td>{lot.payment_status || '—'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9}>
                      <div className={styles.empty}>
                        No lots yet. Add lots in the <strong>Catalogue / Lots</strong> tab first.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}