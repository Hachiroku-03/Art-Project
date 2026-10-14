import { useState } from 'react'
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
  const [prefillBusy, setPrefillBusy] = useState(false)
  const [prefillErr, setPrefillErr] = useState('')

  const openCreate = () => {
    setPrefillErr('')
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = async (saleId: number) => {
    setPrefillErr('')
    setPrefillBusy(true)
    const d = await getSaleView(saleId, viewer)
    setPrefillBusy(false)
    if (d.error || !d.sale) {
      setPrefillErr(d.error || 'Could not load this sale for editing.')
      return
    }
    setEditing(d.sale)
    setFormOpen(true)
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
                return (
                  <tr key={sale.id}>
                    <td>
                      <div className={styles.saleTitle}>{sale.title}</div>
                      <div className={styles.muted}>#{sale.id}</div>
                    </td>
                    <td><AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} /></td>
                    <td>{statusLabel(sale.status)}</td>
                    <td>{sale.lot_count ?? 0}</td>
                    <td>{sale.tickets_sold ?? 0}</td>
                    <td>{formatMoney(sale.ticket_price, sale.ticket_currency || sale.currency || 'NGN')}</td>
                    <td>
                      <div className={styles.actions}>
                        <button
                          className={styles.linkButton}
                          onClick={() => void openEdit(sale.id)}
                          disabled={ended || prefillBusy}
                          title={ended ? 'Ended sales are read-only' : 'Edit sale'}
                        >
                          {prefillBusy ? 'Loading…' : 'Edit'}
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