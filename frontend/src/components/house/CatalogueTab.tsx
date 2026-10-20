import { useCallback, useEffect, useState } from 'react'
import {
  deleteLot,
  formatMoney,
  getSaleView,
  normalizeAccessMode,
  type Lot,
  type MySale,
  type Sale,
} from '../../lib/sales'
import { AccessBadge } from '../sales/AccessBadge'
import { LotForm } from './LotForm'
import styles from './control.module.css'
import salesStyles from '../sales/sales.module.css'

function lotStatusClass(status: Lot['status']) {
  if (status === 'sealed') return salesStyles.statusSealed
  if (status === 'on_block') return salesStyles.statusOnBlock
  if (status === 'sold') return salesStyles.statusSold
  return salesStyles.statusPassed
}

function lotStatusLabel(status: Lot['status']) {
  if (status === 'sealed') return 'Sealed'
  if (status === 'on_block') return 'On block'
  if (status === 'sold') return 'Sold'
  return 'Passed'
}

function saleStatusLabel(status: string) {
  if (status === 'live') return 'Live'
  if (status === 'upcoming') return 'Upcoming'
  if (status === 'ended') return 'Ended'
  return status
}

export function CatalogueTab({
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
  const [error, setError] = useState('')

  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null)
  const [editingLotId, setEditingLotId] = useState<number | null>(null)

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

  const currency = sale?.currency || 'NGN'
  const ended = sale?.status === 'ended'
  const canDelete = sale?.status === 'upcoming'

  const closeForm = () => {
    setFormMode(null)
    setEditingLotId(null)
  }

  const afterSave = () => {
    void load()
    reload()
    closeForm()
  }

  const onDelete = async (lot: Lot) => {
    if (!viewer) return

    const ok = window.confirm(
      `Delete Lot ${lot.position} (“${lot.title || 'untitled'}”)? This cannot be undone.`,
    )
    if (!ok) return

    const r = await deleteLot(lot.id, viewer)
    if (r.error) {
      setError(r.error)
      return
    }

    void load()
    reload()
  }

  const editingLot =
    editingLotId != null
      ? lots.find(l => Number(l.id) === editingLotId) ?? null
      : null

  return (
    <div className={styles.panel}>
      <div className={styles.catalogueTop}>
        <div>
          <h2 className={styles.panelTitle} style={{ margin: 0 }}>
            Catalogue / Lots
          </h2>

          {sale ? (
            <>
              <div className={styles.muted}>
                {sale.title} · Sale #{sale.id}
              </div>

              <div className={styles.catalogueMeta}>
                <span>{saleStatusLabel(sale.status)}</span>
                <AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} />
                <span>{lots.length} lots</span>
                <span>Currency {currency}</span>
              </div>
            </>
          ) : (
            <div className={styles.muted}>Select a sale to manage its sealed catalogue.</div>
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

          <button
            className={`${styles.linkButton} ${styles.primaryLink}`}
            onClick={() => {
              setEditingLotId(null)
              setFormMode('create')
            }}
            disabled={!sale || ended || !viewer}
          >
            ＋ Add lot
          </button>
        </div>
      </div>

      {!viewer ? (
        <div className={styles.error}>
          No signed-in house detected. Sign in again, or make login call `setViewer(data.username)`.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {!sales.length ? (
        <div className={styles.empty}>
          No sales yet. Create a sale first in the <strong>Sales / Auctions</strong> tab.
        </div>
      ) : loading ? (
        <p className={styles.muted}>Loading catalogue…</p>
      ) : !sale ? (
        <p className={styles.muted}>Select a sale.</p>
      ) : !sale.is_host ? (
        <div className={styles.error}>You are not the host of this sale.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pos</th>
                <th>Status</th>
                <th>Lot</th>
                <th>Starting</th>
                <th>Reserve</th>
                <th>Estimate</th>
                <th>Current</th>
                <th>Sold</th>
                <th>Winner</th>
                <th>Payment</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {lots.length ? (
                lots.map(lot => {
                  const finalized = lot.status === 'sold' || lot.status === 'passed'
                  const deletable = lot.status === 'sealed' && canDelete && !!viewer

                  return (
                    <tr key={lot.id}>
                      <td className={styles.nowrap}>{lot.position}</td>

                      <td>
                        <span className={`${styles.statusPill} ${lotStatusClass(lot.status)}`}>
                          {lotStatusLabel(lot.status)}
                        </span>
                      </td>

                      <td>
                        <div className={styles.lotCell}>
                          {lot.image_url ? (
                            <img className={styles.thumb} src={lot.image_url} alt="" />
                          ) : (
                            <div className={styles.thumb} />
                          )}

                          <div className={styles.lotCellText}>
                            <div className={styles.lotName}>
                              {lot.title || `Lot ${lot.position}`}
                            </div>

                            {lot.description ? (
                              <div className={styles.smallMuted}>
                                {lot.description.length > 90
                                  ? `${lot.description.slice(0, 90)}…`
                                  : lot.description}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.starting_price, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.reserve, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {lot.estimate_low || lot.estimate_high
                          ? `${formatMoney(lot.estimate_low, lot.currency || currency)} – ${formatMoney(
                              lot.estimate_high,
                              lot.currency || currency,
                            )}`
                          : '—'}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.current_bid, lot.currency || currency)}
                      </td>

                      <td className={styles.nowrap}>
                        {formatMoney(lot.sold_price, lot.currency || currency)}
                      </td>

                      <td>{lot.winner_username || '—'}</td>
                      <td>{lot.payment_status || '—'}</td>

                      <td>
                        <div className={styles.actions}>
                          <button
                            className={styles.linkButton}
                            disabled={finalized || !viewer}
                            title={finalized ? 'Finalized lots cannot be edited.' : 'Edit lot'}
                            onClick={() => {
                              setEditingLotId(Number(lot.id))
                              setFormMode('edit')
                            }}
                          >
                            Edit
                          </button>

                          <button
                            className={styles.linkButton}
                            disabled={!deletable}
                            title={
                              lot.status !== 'sealed'
                                ? 'Only sealed lots can be deleted.'
                                : !canDelete
                                  ? 'Lots can only be deleted before the sale goes live.'
                                  : 'Delete lot'
                            }
                            onClick={() => void onDelete(lot)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={11}>
                    <div className={styles.empty}>
                      No lots yet. Click <strong>＋ Add lot</strong> to create the first sealed lot.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {formMode === 'create' && saleId ? (
        <LotForm
          mode="create"
          saleId={saleId}
          viewer={viewer}
          initial={null}
          onClose={closeForm}
          onSaved={afterSave}
        />
      ) : null}

      {formMode === 'edit' && saleId && editingLotId != null ? (
        <LotForm
          mode="edit"
          saleId={saleId}
          viewer={viewer}
          lotId={editingLotId}
          initial={editingLot}
          onClose={closeForm}
          onSaved={afterSave}
        />
      ) : null}
    </div>
  )
}

export default CatalogueTab