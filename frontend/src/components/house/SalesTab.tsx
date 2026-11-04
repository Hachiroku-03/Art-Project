import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  formatMoney,
  getSaleView,
  normalizeAccessMode,
  type MySale,
  type Sale,
} from '../../lib/sales'
import { AccessBadge } from '../sales/AccessBadge'
import { SaleForm } from './SaleForm'
import styles from './control.module.css'

function statusLabel(status: string) {
  if (status === 'live') return 'Live'
  if (status === 'upcoming') return 'Upcoming'
  if (status === 'ended') return 'Ended'
  return status
}

export function SalesTab({
  sales,
  loading,
  error,
  viewer,
  reload,
}: {
  sales: MySale[]
  loading: boolean
  error: string
  viewer: string
  reload: () => void
}) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Sale | null>(null) // null = create

  // BUG 2 FIX: key the prefill spinner by sale id, not one shared boolean, so
  // loading ONE row can never make every other row's Edit button spin.
  const [prefillBusyId, setPrefillBusyId] = useState<number | null>(null)
  const [prefillErr, setPrefillErr] = useState('')

  // Guards the async prefill against races: a slow Edit-A resolving after the
  // user opened New sale (or clicked Edit-B) must not yank the open form.
  const pendingEditRef = useRef<number | null>(null)

  const openCreate = () => {
    pendingEditRef.current = null // cancel any in-flight edit prefill
    setPrefillErr('')
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = async (saleId: number) => {
    if (prefillBusyId === saleId) return // already loading this exact row
    setPrefillErr('')
    setPrefillBusyId(saleId)
    pendingEditRef.current = saleId

    try {
      const d = await getSaleView(saleId, viewer)

      // Superseded by a newer open/create while we were fetching -> drop it.
      if (pendingEditRef.current !== saleId) return

      if (d.error || !d.sale) {
        setPrefillErr(d.error || 'Could not load this sale for editing.')
        return
      }

      setEditing(d.sale)
      setFormOpen(true)
    } finally {
      // Functional clear: only this row's spinner, never a sibling's.
      setPrefillBusyId(cur => (cur === saleId ? null : cur))
      if (pendingEditRef.current === saleId) pendingEditRef.current = null
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <h2 className={styles.panelTitle} style={{ margin: 0 }}>Sales / Auctions</h2>
        <button className={`${styles.linkButton} ${styles.primaryLink}`} onClick={openCreate}>
          ＋ New sale
        </button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
      {prefillErr ? <div className={styles.error}>{prefillErr}</div> : null}

      {loading ? (
        <p className={styles.muted}>Loading sales…</p>
      ) : !sales.length ? (
        <div className={styles.empty}>
          No sales yet. Click <strong>＋ New sale</strong> to open your first room.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sale</th>
                <th>Access</th>
                <th>Status</th>
                <th>Lots</th>
                <th>Paddles</th>
                <th>Price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sales.map(sale => {
                const ended = sale.status === 'ended'
                const rowBusy = prefillBusyId === sale.id
                return (
                  <tr key={sale.id}>
                    {/* data-label = the column name shown beside each cell when the
                        table stacks into row-cards on phones (see control.module.css) */}
                    <td data-label="Sale">
                      <div>
                        <div className={styles.saleTitle}>{sale.title}</div>
                        <div className={styles.muted}>#{sale.id}</div>
                      </div>
                    </td>
                    <td data-label="Access"><AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} /></td>
                    <td data-label="Status">{statusLabel(sale.status)}</td>
                    <td data-label="Lots">{sale.lot_count ?? 0}</td>
                    <td data-label="Paddles">{sale.tickets_sold ?? 0}</td>
                    <td data-label="Price">{formatMoney(sale.ticket_price, sale.ticket_currency || sale.currency || 'NGN')}</td>
                    <td>
                      <div className={styles.actions}>
                        <button
                          className={styles.linkButton}
                          onClick={() => void openEdit(sale.id)}
                          disabled={ended || rowBusy}
                          title={ended ? 'Ended sales are read-only' : 'Edit sale'}
                        >
                          {rowBusy ? 'Loading…' : 'Edit'}
                        </button>
                        <Link className={styles.linkButton} to={`/sales/${sale.id}`}>Ticket page</Link>
                        <Link className={styles.linkButton} to={`/sales/${sale.id}/control`}>Focus</Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {formOpen ? (
        <SaleForm
          mode={editing ? 'edit' : 'create'}
          initial={editing}
          viewer={viewer}
          onClose={() => setFormOpen(false)}
          onSaved={reload}
        />
      ) : null}
    </div>
  )
}
