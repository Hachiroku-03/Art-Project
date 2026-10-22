import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collectSale,
  fetchSettlement,
  formatMoney,
  markCollectionPaid,
  markPayoutPaid,
  settleSale,
  type MySale,
  type SettlementLot,
  type SettlementView,
} from '../../lib/sales'
import styles from './control.module.css'

type BusyKey = '' | 'settle' | 'collect' | 'collection_offline' | 'payout'

type SettlementLotRow = SettlementLot & {
  payment_reference?: string | null
  payment_updated_at?: string | null
}

function payPillClass(status?: string | null) {
  const s = String(status || 'unpaid').toLowerCase()

  if (s === 'paid') return styles.payPaid
  if (s === 'pending' || s === 'processing') return styles.payPending
  if (s === 'failed') return styles.payFailed

  return styles.payUnpaid
}

function payLabel(status?: string | null) {
  const s = String(status || 'unpaid').toLowerCase()

  if (s === 'paid') return 'Paid'
  if (s === 'pending') return 'Pending'
  if (s === 'processing') return 'Processing'
  if (s === 'failed') return 'Failed'

  return 'Unpaid'
}

function payoutLabel(status?: string | null) {
  const s = String(status || 'none').toLowerCase()

  if (s === 'paid') return 'Paid'
  if (s === 'pending') return 'Pending'

  return 'Not paid'
}

function collectionLabel(state?: string | null) {
  const s = String(state || '').toLowerCase()

  if (s === 'collected') return 'Collected'
  if (s === 'awaiting_collection') return 'Awaiting collection'
  if (s === 'partial') return 'Partial collection'
  if (s === 'failed') return 'Collection failed'

  return s || '—'
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
  const [view, setView] = useState<SettlementView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<BusyKey>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

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
      setView(null)
      return
    }

    if (!viewer) {
      setError('No signed-in house detected.')
      setView(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await fetchSettlement(saleId, viewer)

    if (d.error) {
      setError(d.error)
      setView(null)
    } else {
      setView(d)
    }

    setLoading(false)
  }, [saleId, viewer])

  useEffect(() => {
    void load()
  }, [load])

  const sale = view?.sale ?? null
  const counts = view?.counts ?? { paid: 0, pending: 0, unpaid: 0, failed: 0 }
  const totals = view?.totals ?? {}
  const rates = view?.rates ?? {}

  const wonLots = useMemo(
    () =>
      ((view?.lots || []) as SettlementLotRow[]).filter(
        l => !!l.winner_username,
      ),
    [view],
  )

  const settled = !!sale?.settled_at
  const payoutStatus = String(sale?.payout_status || 'none').toLowerCase()
  const outstanding = (counts.unpaid || 0) + (counts.failed || 0)
  const pending = counts.pending || 0

  const currency = sale?.currency || totals.currency || 'NGN'

  const canSettle = sale?.status === 'ended' && !settled
  const canCollect = settled && outstanding > 0
  const canMarkCollectionOffline = settled && outstanding > 0
  const canMarkPayoutPaid =
    settled &&
    outstanding === 0 &&
    pending === 0 &&
    payoutStatus !== 'paid'

  // Auto-refresh while collection is still moving.
  useEffect(() => {
    if (!saleId || !viewer || !settled) return
    if (busy !== '') return
    if (outstanding === 0 && pending === 0) return

    const timer = window.setInterval(() => {
      void load()
    }, 15000)

    return () => window.clearInterval(timer)
  }, [saleId, viewer, settled, outstanding, pending, busy, load])

  const act = async (
    key: Exclude<BusyKey, ''>,
    fn: () => Promise<any>,
    success: string | ((d: any) => string),
  ) => {
    if (!saleId || !viewer) return

    setBusy(key)
    setError('')
    setNotice('')

    try {
      const d = await fn()

      if (d?.error) {
        setError(d.error)
        return
      }

      setNotice(typeof success === 'function' ? success(d) : success)
      await load()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy('')
    }
  }

  const onSettle = () => {
    if (!saleId) return

    const ok = window.confirm(
      'Settle this sale? This computes hammer, premium, commission, net-to-house, and prepares buyer collection.',
    )

    if (!ok) return

    void act(
      'settle',
      () => settleSale(saleId, viewer),
      d =>
        `Sale settled. ${d.lots_sold ?? 0} lot(s) sold. Net to house: ${formatMoney(
          d.net_to_house,
          d.outcomes?.[0]?.currency || currency,
        )}.`,
    )
  }

  const onRetryCollection = () => {
    if (!saleId) return

    const ok = window.confirm(
      'Retry collection? This asks Paystack to create payment links for unpaid/failed won lots. Buyers will be notified.',
    )

    if (!ok) return

    void act(
      'collect',
      () => collectSale(saleId, viewer),
      d =>
        `Collection retried. ${d.charges_initiated ?? 0} link(s) initiated, ${
          d.links_available ?? 0
        } already available, ${d.failed ?? 0} failed.`,
    )
  }

  const onMarkCollectionOffline = () => {
    if (!saleId) return

    const reference =
      window.prompt(
        'Offline collection reference. Use a bank transfer reference, cash receipt id, or test reference.',
        `offline_collection_${saleId}_${Date.now()}`,
      ) || ''

    if (!reference.trim()) {
      setError('Reference is required for offline collection marking.')
      return
    }

    const ok = window.confirm(
      'Only use this if buyer payment has been verified outside Paystack, or if you are testing locally without a live payment rail. This records collection as complete without moving money.',
    )

    if (!ok) return

    void act(
      'collection_offline',
      () => markCollectionPaid(saleId, viewer, reference.trim()),
      d =>
        `${d.marked_paid ?? 0} won lot(s) marked collected. Reference: ${
          d.reference || reference
        }.`,
    )
  }

  const onMarkPayoutPaid = () => {
    if (!saleId) return

    const reference =
      window.prompt(
        'House payout reference. Use the bank transfer reference, Paystack transfer reference, or payout receipt id.',
        `house_payout_${saleId}_${Date.now()}`,
      ) || ''

    if (!reference.trim()) {
      setError('Reference is required to mark payout paid.')
      return
    }

    const ok = window.confirm(
      'Confirm that the platform has paid the house. This records the house payout as complete.',
    )

    if (!ok) return

    void act(
      'payout',
      () => markPayoutPaid(saleId, viewer, reference.trim()),
      d =>
        `House payout marked paid. Reference: ${
          d.payout_reference || reference
        }.`,
    )
  }

  if (!sales.length) {
    return (
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Settlement</h2>
        <div className={styles.empty}>
          No sales yet. Create a sale first in the <strong>Sales / Auctions</strong> tab.
        </div>
      </section>
    )
  }

  return (
    <section className={styles.panel}>
      <div className={styles.settleTop}>
        <div>
          <h2 className={styles.panelTitle} style={{ margin: 0 }}>
            Settlement
          </h2>

          {sale ? (
            <>
              <div className={styles.muted}>
                {sale.title} · Sale #{sale.id}
              </div>

              <div className={styles.settleMeta}>
                <span>Status: {sale.status}</span>
                <span>Settled: {settled ? 'yes' : 'no'}</span>
                <span>Collection: {collectionLabel(view?.collection_state)}</span>
                <span>Payout: {payoutLabel(sale.payout_status)}</span>
              </div>
            </>
          ) : (
            <div className={styles.muted}>Select a sale to settle and collect.</div>
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
          No signed-in house detected. Sign in again, or make login call `setViewer(data.username)`.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}
      {notice ? <p className={styles.noticeOk}>{notice}</p> : null}

      {loading ? (
        <p className={styles.muted}>Loading settlement…</p>
      ) : !sale ? (
        <p className={styles.muted}>Select a sale.</p>
      ) : (
        <>
          <div className={styles.settleStats}>
            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Hammer total</div>
              <div className={styles.settleStatValue}>
                {formatMoney(totals.hammer_total, currency)}
              </div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Buyer premium</div>
              <div className={styles.settleStatValue}>
                {formatMoney(totals.premium_total, currency)}
              </div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Collectible</div>
              <div className={styles.settleStatValue}>
                {formatMoney(totals.collected_total, currency)}
              </div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Commission</div>
              <div className={styles.settleStatValue}>
                {formatMoney(totals.commission_total, currency)}
              </div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Net to house</div>
              <div className={styles.settleStatValue}>
                {formatMoney(totals.net_to_house, currency)}
              </div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Rates</div>
              <div className={styles.settleStatValue}>
                Premium {Math.round((rates.buyer_premium_rate ?? 0) * 100)}% ·
                Commission {Math.round((rates.platform_commission_rate ?? 0) * 100)}%
              </div>
            </div>
          </div>

          <div className={styles.settleStats}>
            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Paid</div>
              <div className={styles.settleStatValue}>{counts.paid || 0}</div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Pending</div>
              <div className={styles.settleStatValue}>{counts.pending || 0}</div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Unpaid</div>
              <div className={styles.settleStatValue}>{counts.unpaid || 0}</div>
            </div>

            <div className={styles.settleStat}>
              <div className={styles.settleStatLabel}>Failed</div>
              <div className={styles.settleStatValue}>{counts.failed || 0}</div>
            </div>
          </div>

          <div className={styles.settleActions}>
            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={onSettle}
              disabled={busy !== '' || !canSettle}
              title={
                settled
                  ? 'Already settled.'
                  : sale.status !== 'ended'
                    ? 'End the sale before settling.'
                    : 'Settle this sale.'
              }
            >
              {busy === 'settle' ? 'Settling…' : 'Settle sale'}
            </button>

            <button
              className={styles.linkButton}
              onClick={onRetryCollection}
              disabled={busy !== '' || !canCollect}
              title={
                !settled
                  ? 'Settle the sale first.'
                  : outstanding === 0
                    ? 'No unpaid/failed lots to collect.'
                    : 'Retry Paystack collection for unpaid/failed lots.'
              }
            >
              {busy === 'collect' ? 'Retrying…' : 'Retry collection'}
            </button>

            <button
              className={styles.linkButton}
              onClick={onMarkCollectionOffline}
              disabled={busy !== '' || !canMarkCollectionOffline}
              title={
                !settled
                  ? 'Settle the sale first.'
                  : outstanding === 0
                    ? 'Collection is already complete.'
                    : 'Mark buyer collection paid for offline/test transfers.'
              }
            >
              {busy === 'collection_offline'
                ? 'Marking…'
                : 'Mark collection paid offline'}
            </button>

            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={onMarkPayoutPaid}
              disabled={busy !== '' || !canMarkPayoutPaid}
              title={
                !settled
                  ? 'Settle the sale first.'
                  : outstanding > 0 || pending > 0
                    ? 'House payout cannot be marked paid until collection is complete.'
                    : payoutStatus === 'paid'
                      ? 'Payout already marked paid.'
                      : 'Mark house payout paid.'
              }
            >
              {busy === 'payout' ? 'Marking…' : 'Mark house payout paid'}
            </button>
          </div>

          {!settled ? (
            <p className={styles.settleHint}>
              Settle the sale first. Settlement computes the money split and prepares buyer collection.
            </p>
          ) : outstanding > 0 || pending > 0 ? (
            <p className={styles.settleHint}>
              House payout cannot be marked paid until all won lots are collected. Buyers pay from their Won lots page.
            </p>
          ) : payoutStatus === 'paid' ? (
            <p className={styles.settleHint}>
              House payout is marked paid. Reference: {sale.payout_reference || '—'}
            </p>
          ) : (
            <p className={styles.settleHint}>
              Collection is complete. You can now mark the house payout as paid.
            </p>
          )}

          <div className={styles.outcomePanel}>
            <div className={styles.panelTitleSmall}>Won lots collection</div>

            {wonLots.length === 0 ? (
              <p className={styles.muted}>No won lots in this sale.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Lot</th>
                      <th>Winner</th>
                      <th>Hammer</th>
                      <th>Premium</th>
                      <th>Total payable</th>
                      <th>Status</th>
                      <th>Reference</th>
                      <th>Updated</th>
                    </tr>
                  </thead>

                  <tbody>
                    {wonLots.map(lot => {
                      const lotCurrency = lot.currency || currency

                      const reference = lot.payment_reference || '—'

                      const updated = lot.payment_updated_at
                        ? new Date(
                            String(lot.payment_updated_at).replace(' ', 'T'),
                          ).toLocaleString()
                        : '—'

                      return (
                        <tr key={lot.id}>
                          <td className={styles.nowrap}>
                            #{lot.position}
                            {lot.title ? ` · ${lot.title}` : ''}
                          </td>

                          <td>{lot.winner_username || '—'}</td>

                          <td className={styles.nowrap}>
                            {formatMoney(lot.hammer || lot.sold_price, lotCurrency)}
                          </td>

                          <td className={styles.nowrap}>
                            {formatMoney(lot.premium, lotCurrency)}
                          </td>

                          <td className={styles.nowrap}>
                            {formatMoney(lot.collected, lotCurrency)}
                          </td>

                          <td>
                            <span
                              className={`${styles.payPill} ${payPillClass(
                                lot.payment_status,
                              )}`}
                            >
                              {payLabel(lot.payment_status)}
                            </span>
                          </td>

                          <td className={styles.codeText}>{reference}</td>

                          <td className={styles.nowrap}>{updated}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className={styles.settleHint}>
            Passed and sealed lots are excluded from payout. Only sold lots with a winner are collectible.
          </p>
        </>
      )}
    </section>
  )
}

export default SettlementTab