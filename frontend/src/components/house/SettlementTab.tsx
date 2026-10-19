import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collectSale,
  fetchSettlement,
  formatMoney,
  settleSale,
  type MySale,
  type SettleOutcome,
  type SettlementCounts,
  type SettlementView,
} from '../../lib/sales'
import styles from './control.module.css'

function paymentClass(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'paid') return styles.payPaid
  if (s === 'pending') return styles.payPending
  if (s === 'failed') return styles.payFailed

  return styles.payUnpaid
}

function paymentLabel(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'paid') return 'Paid'
  if (s === 'pending') return 'Pending'
  if (s === 'failed') return 'Failed'

  return 'Unpaid'
}

function collectionLabel(state?: string | null) {
  const s = String(state || '').trim().toLowerCase()

  if (s === 'not_settled') return 'Not settled'
  if (s === 'awaiting_collection') return 'Awaiting collection'
  if (s === 'pending') return 'Payment pending'
  if (s === 'collected') return 'Collected'
  if (s === 'none') return 'None'

  return state || '—'
}

function saleStatusLabel(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'live') return 'Live'
  if (s === 'upcoming') return 'Upcoming'
  if (s === 'ended') return 'Ended'

  return status || '—'
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'

  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const d = new Date(normalized)

  if (Number.isNaN(d.getTime())) return value

  return d.toLocaleString()
}

const EMPTY_COUNTS: SettlementCounts = {
  paid: 0,
  pending: 0,
  unpaid: 0,
  failed: 0,
}

export function SettlementTab({
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
  const [data, setData] = useState<SettlementView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'' | 'settle' | 'collect'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [outcomes, setOutcomes] = useState<SettleOutcome[]>([])

  useEffect(() => {
    if (selectedSaleId) setSaleId(selectedSaleId)
  }, [selectedSaleId])

  useEffect(() => {
    if (!saleId && sales.length) {
      setSaleId(sales[0].id)
    }
  }, [saleId, sales])

  useEffect(() => {
    setOutcomes([])
    setNotice('')
    setError('')
  }, [saleId])

  const selectedSale = useMemo(
    () => sales.find(s => s.id === saleId) || null,
    [sales, saleId],
  )

  const load = useCallback(
    async (clearOutcomes = false) => {
      if (!saleId) {
        setData(null)
        if (clearOutcomes) setOutcomes([])
        return
      }

      if (!viewer) {
        setError('No signed-in house detected.')
        setData(null)
        setLoading(false)
        return
      }

      setLoading(true)
      setError('')

      const d = await fetchSettlement(saleId, viewer)

      if (d.error) {
        setError(d.error)
        setData(null)
      } else {
        setData(d)
        if (clearOutcomes) setOutcomes([])
      }

      setLoading(false)
    },
    [saleId, viewer],
  )

  useEffect(() => {
    void load(true)
  }, [load])

  const saleStatus = data?.sale?.status || selectedSale?.status || ''
  const settled = !!data?.sale?.settled_at
  const counts = data?.counts || EMPTY_COUNTS
  const currency = data?.totals?.currency || data?.sale?.currency || selectedSale?.currency || 'NGN'

  const dueCount = counts.unpaid + counts.failed
  const canSettle = saleStatus === 'ended' && !settled && !!viewer && !loading && !busy
  const canCollect = settled && dueCount > 0 && !!viewer && !loading && !busy

  const handleSettle = async () => {
    if (!saleId) return

    const ok = window.confirm(
      'Settle this sale? This computes buyer premium, platform commission, net to house, sends notices, and attempts payment collection where configured.',
    )
    if (!ok) return

    setBusy('settle')
    setError('')
    setNotice('')

    const res = await settleSale(saleId, viewer)

    setBusy('')

    if (res.error) {
      setError(res.error)
      return
    }

    setOutcomes(res.outcomes || [])

    setNotice(
      `${res.message || 'Settled.'} ` +
        `${res.lots_sold ?? 0} won lot(s). ` +
        `Collected ${formatMoney(res.collected_total, currency)}. ` +
        `Commission ${formatMoney(res.commission_total, currency)}. ` +
        `Net to house ${formatMoney(res.net_to_house, currency)}. ` +
        (res.charges_initiated
          ? `${res.charges_initiated} payment link(s) initiated.`
          : 'No payment links initiated — set Paystack keys server-side, then retry collection.'),
    )

    await load(false)
    reload()
  }

  const handleCollect = async () => {
    if (!saleId) return

    const ok = window.confirm(
      'Retry collection for unpaid/failed lots? This does not recompute the settlement or resend winner notices.',
    )
    if (!ok) return

    setBusy('collect')
    setError('')
    setNotice('')

    const res = await collectSale(saleId, viewer)

    setBusy('')

    if (res.error) {
      setError(res.error)
      return
    }

    setOutcomes(res.outcomes || [])

    setNotice(
      `${res.message || 'Collection retried.'} ` +
        `${res.charges_initiated ?? 0} payment link(s) initiated. ` +
        `${res.awaiting_collection ?? 0} still awaiting collection.`,
    )

    await load(false)
    reload()
  }

  return (
    <div className={styles.panel}>
      <div className={styles.settleTop}>
        <div>
          <h2 className={styles.panelTitle} style={{ margin: 0 }}>
            Settlement
          </h2>

          {data?.sale || selectedSale ? (
            <>
              <div className={styles.muted}>
                {data?.sale?.title || selectedSale?.title} · Sale #{saleId}
              </div>

              <div className={styles.settleMeta}>
                <span>Status: {saleStatusLabel(saleStatus)}</span>
                <span>Settled: {settled ? 'Yes' : 'No'}</span>
                <span>Collection: {collectionLabel(data?.collection_state)}</span>
                <span>Payout: {data?.sale?.payout_status || selectedSale?.payout_status || 'none'}</span>
              </div>
            </>
          ) : (
            <div className={styles.muted}>Select a sale to review settlement.</div>
          )}
        </div>

        <div className={styles.actions}>
          <select
            className={`${styles.select} ${styles.salePicker}`}
            value={saleId ?? ''}
            onChange={e => {
              const value = e.target.value
              setSaleId(value ? Number(value) : null)
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
          No sales yet. Create and run a sale first.
        </div>
      ) : loading ? (
        <p className={styles.muted}>Loading settlement…</p>
      ) : !saleId ? (
        <p className={styles.muted}>Select a sale.</p>
      ) : (
        <>
          <div className={styles.settleActions}>
            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void handleSettle()}
              disabled={!canSettle}
            >
              {busy === 'settle' ? 'Settling…' : 'Settle sale'}
            </button>

            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void handleCollect()}
              disabled={!canCollect}
            >
              {busy === 'collect' ? 'Retrying…' : 'Retry collection'}
            </button>
          </div>

          {!settled && saleStatus === 'ended' ? (
            <p className={styles.settleHint}>
              This sale is ended but not settled. Click <strong>Settle sale</strong> to compute the
              money split and notify winners.
            </p>
          ) : null}

          {saleStatus !== 'ended' ? (
            <p className={styles.settleHint}>
              Settlement becomes available after the sale is ended from the Rostrum / Live tab.
            </p>
          ) : null}

          <div className={styles.settleStats}>
            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Won lots</span>
              <span className={styles.settleStatValue}>{data?.lots?.length ?? 0}</span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Hammer total</span>
              <span className={styles.settleStatValue}>
                {formatMoney(data?.totals?.hammer_total ?? '0', currency)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Buyer premium</span>
              <span className={styles.settleStatValue}>
                {formatMoney(data?.totals?.premium_total ?? '0', currency)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Collected total</span>
              <span className={styles.settleStatValue}>
                {formatMoney(data?.totals?.collected_total ?? '0', currency)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Platform commission</span>
              <span className={styles.settleStatValue}>
                {formatMoney(data?.totals?.commission_total ?? '0', currency)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Net to house</span>
              <span className={styles.settleStatValue}>
                {formatMoney(data?.totals?.net_to_house ?? '0', currency)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Paid</span>
              <span className={styles.settleStatValue}>{counts.paid}</span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Pending</span>
              <span className={styles.settleStatValue}>{counts.pending}</span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Unpaid / failed</span>
              <span className={styles.settleStatValue}>{dueCount}</span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Settled at</span>
              <span className={styles.settleStatValue}>
                {formatDateTime(data?.sale?.settled_at)}
              </span>
            </div>

            <div className={styles.settleStat}>
              <span className={styles.settleStatLabel}>Payout reference</span>
              <span className={styles.settleStatValue}>
                {data?.sale?.payout_reference || '—'}
              </span>
            </div>
          </div>

          {outcomes.length > 0 ? (
            <div className={styles.outcomePanel}>
              <div className={styles.panelTitleSmall}>Latest settlement / collection result</div>

              <div className={styles.outcomeList}>
                {outcomes.map(o => (
                  <div key={`${o.lot_id}-${o.status}`} className={styles.outcomeRow}>
                    <div style={{ minWidth: 0 }}>
                      <div className={styles.outcomeTitle}>
                        Lot {o.position} · @{o.winner}
                      </div>
                      <div className={styles.outcomeMeta}>
                        {o.status}
                        {o.reason ? ` — ${o.reason}` : ''}
                      </div>
                    </div>

                    <div className={styles.outcomeMoney}>
                      <div>{formatMoney(o.collected, o.currency)}</div>

                      {o.checkout ? (
                        <a
                          className={styles.checkoutLink}
                          href={o.checkout}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open payment link
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Lot</th>
                  <th>Winner</th>
                  <th>Hammer</th>
                  <th>Premium</th>
                  <th>Collected</th>
                  <th>Commission</th>
                  <th>Net to house</th>
                  <th>Payment</th>
                  <th>Hammered</th>
                </tr>
              </thead>

              <tbody>
                {data?.lots?.length ? (
                  data.lots.map(lot => (
                    <tr key={lot.id}>
                      <td className={styles.nowrap}>{lot.position}</td>
                      <td>{lot.title || `Lot ${lot.position}`}</td>
                      <td>{lot.winner_username || '—'}</td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.hammer || lot.sold_price, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.premium, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.collected, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.commission, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.net_to_house, lot.currency || currency)}
                      </td>

                      <td>
                        <span className={`${styles.payPill} ${paymentClass(lot.payment_status)}`}>
                          {paymentLabel(lot.payment_status)}
                        </span>
                      </td>

                      <td className={styles.nowrap}>{formatDateTime(lot.hammer_at)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10}>
                      <div className={styles.empty}>
                        No won lots yet. Hammer lots during the live sale to create settlement items.
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