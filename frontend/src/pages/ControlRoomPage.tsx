import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchMySales,
  formatMoney,
  normalizeAccessMode,
  type MySale,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import { AccessBadge } from '../components/sales/AccessBadge'
import { SalesTab } from '../components/house/SalesTab'
import { CatalogueTab } from '../components/house/CatalogueTab'
import { EntryTab } from '../components/house/EntryTab'
import { RostrumTab } from '../components/house/RostrumTab'
import { SettlementTab } from '../components/house/SettlementTab'
import { PayoutTab } from '../components/house/PayoutTab'
import styles from '../components/house/control.module.css'
import salesStyles from '../components/sales/sales.module.css'

type TabKey =
  | 'overview'
  | 'sales'
  | 'catalogue'
  | 'entry'
  | 'rostrum'
  | 'settlement'
  | 'payout'

const TABS: { key: TabKey; label: string; note: string }[] = [
  { key: 'overview', label: 'Overview', note: 'Dashboard' },
  { key: 'sales', label: 'Sales / Auctions', note: 'Create and edit sales' },
  { key: 'catalogue', label: 'Catalogue / Lots', note: 'Sealed lots' },
  { key: 'entry', label: 'Entry / Paddles', note: 'Paddle issuance' },
  { key: 'rostrum', label: 'Rostrum / Live', note: 'Reveal, hammer, end' },
  { key: 'settlement', label: 'Settlement', note: 'Close money' },
  { key: 'payout', label: 'Payout / Settings', note: 'House payout details' },
]

function statusLabel(status: string) {
  if (status === 'live') return 'Live'
  if (status === 'upcoming') return 'Upcoming'
  if (status === 'ended') return 'Ended'
  return status
}

function settlementLabel(sale: MySale) {
  if (sale.settled_at) return 'Settled'
  if (sale.status === 'ended') return 'Unsettled'
  return '—'
}

export function ControlRoomPage() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const viewer = getViewer()

  const [sales, setSales] = useState<MySale[]>([])
  const [loading, setLoading] = useState(true)     // first fetch only
  const [refreshing, setRefreshing] = useState(false) // background reloads
  const [error, setError] = useState('')
  const [tab, setTab] = useState<TabKey>('overview')

  const didLoad = useRef(false)

  // Background-safe reload: never blanks the dashboard after the first paint.
  const reload = useCallback(async () => {
    if (!didLoad.current) setLoading(true)
    else setRefreshing(true)
    setError('')

    const d = await fetchMySales(viewer)
    if (d.error) {
      setError(d.error)
      setSales([])
    } else {
      setSales(d.sales || [])
    }

    didLoad.current = true
    setLoading(false)
    setRefreshing(false)
  }, [viewer])

  // Auth guard + first load in one effect (matches every other page).
  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      setLoading(false)
      navigate('/login', { replace: true })
      return
    }
    void reload()
  }, [reload, navigate])

  const selectedSale = useMemo(() => {
    if (!id) return null
    return sales.find(s => String(s.id) === id) || null
  }, [id, sales])

  const stats = useMemo(() => {
    const total = sales.length
    const live = sales.filter(s => s.status === 'live').length
    const upcoming = sales.filter(s => s.status === 'upcoming').length
    const ended = sales.filter(s => s.status === 'ended').length
    const unsettled = sales.filter(s => s.status === 'ended' && !s.settled_at).length
    const lots = sales.reduce((sum, s) => sum + Number(s.lot_count || 0), 0)
    const paddles = sales.reduce((sum, s) => sum + Number(s.tickets_sold || 0), 0)
    return { total, live, upcoming, ended, unsettled, lots, paddles }
  }, [sales])

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div>
            <div className={styles.brand}>Control Room</div>
            <div className={styles.brandSub}>
              {selectedSale ? selectedSale.title : 'House operations'}
            </div>
          </div>

          <nav className={styles.nav}>
            {TABS.map(item => (
              <button
                key={item.key}
                className={`${styles.navButton} ${tab === item.key ? styles.navActive : ''}`}
                onClick={() => setTab(item.key)}
                title={item.note}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className={styles.sidebarFoot}>
            <Link className={salesStyles.back} to="/auctions">
              ← Back to floor
            </Link>
          </div>
        </aside>

        <section className={styles.main}>
          <header className={styles.header}>
            <div>
              <h1 className={styles.headerTitle}>
                {selectedSale ? selectedSale.title : 'Auction house studio'}
              </h1>
              <p className={styles.headerSub}>
                {selectedSale
                  ? `Sale #${selectedSale.id} · ${statusLabel(selectedSale.status)}`
                  : 'Overview of your sales, lots, paddles, live control, and settlement.'}
              </p>
            </div>

            <div className={styles.headerActions}>
              {refreshing ? (
                <span className={styles.refreshTag}>updating…</span>
              ) : null}

              {selectedSale ? (
                <>
                  <Link className={styles.linkButton} to="/sales/control">
                    All sales
                  </Link>
                  <Link className={styles.linkButton} to={`/sales/${selectedSale.id}`}>
                    Open ticket page
                  </Link>
                </>
              ) : null}
            </div>
          </header>

          {tab === 'overview' ? (
            <>
              {error ? <div className={styles.error}>{error}</div> : null}

              <div className={styles.stats}>
                <div className={styles.stat}><div className={styles.statLabel}>Total sales</div><div className={styles.statValue}>{stats.total}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Live</div><div className={styles.statValue}>{stats.live}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Upcoming</div><div className={styles.statValue}>{stats.upcoming}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Ended</div><div className={styles.statValue}>{stats.ended}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Unsettled</div><div className={styles.statValue}>{stats.unsettled}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Lots</div><div className={styles.statValue}>{stats.lots}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Paddles</div><div className={styles.statValue}>{stats.paddles}</div></div>
              </div>

              <div className={styles.panel}>
                <h2 className={styles.panelTitle}>Your sales</h2>
                {loading ? (
                  <p className={styles.muted}>Loading control room…</p>
                ) : !sales.length ? (
                  <div className={styles.empty}>
                    No sales yet. Use the <strong>Sales / Auctions</strong> tab to create your first room.
                  </div>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Sale</th><th>Access</th><th>Status</th><th>Lots</th><th>Paddles</th><th>Paddle price</th><th>Settlement</th><th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sales.map(sale => (
                          <tr key={sale.id}>
                            <td><div className={styles.saleTitle}>{sale.title}</div><div className={styles.muted}>#{sale.id}</div></td>
                            <td><AccessBadge mode={normalizeAccessMode(sale.access_mode ?? sale.tier)} /></td>
                            <td>{statusLabel(sale.status)}</td>
                            <td>{sale.lot_count ?? 0}</td>
                            <td>{sale.tickets_sold ?? 0}</td>
                            <td>{formatMoney(sale.ticket_price, sale.ticket_currency || sale.currency || 'NGN')}</td>
                            <td>{settlementLabel(sale)}</td>
                            <td>
                              <div className={styles.actions}>
                                <Link className={`${styles.linkButton} ${styles.primaryLink}`} to={`/sales/${sale.id}`}>Ticket page</Link>
                                <Link className={styles.linkButton} to={`/sales/${sale.id}/control`}>Focus</Link>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : tab === 'sales' ? (
            <SalesTab sales={sales} loading={loading} error={error} viewer={viewer} reload={reload} />
          ) : tab === 'catalogue' ? (
            <CatalogueTab
              sales={sales}
              selectedSaleId={id ? Number(id) : null}
              viewer={viewer}
              reload={reload}
            />
          ) : tab === 'entry' ? (
            <EntryTab
              sales={sales}
              selectedSaleId={id ? Number(id) : null}
              viewer={viewer}
              reload={reload}
            />
          ) : tab === 'rostrum' ? (
            <RostrumTab
              sales={sales}
              selectedSaleId={id ? Number(id) : null}
              viewer={viewer}
              reload={reload}
            />
          ) : tab === 'settlement' ? (
            <SettlementTab
              sales={sales}
              selectedSaleId={id ? Number(id) : null}
              viewer={viewer}
              reload={reload}
            />
          ) : tab === 'payout' ? (
            <PayoutTab
              sales={sales}
              selectedSaleId={id ? Number(id) : null}
              viewer={viewer}
              reload={reload}
            />
          ) : (
            <div className={styles.placeholder}>
              <h2 className={styles.panelTitle}>{TABS.find(t => t.key === tab)?.label}</h2>
              <p className={styles.muted}>
                Core control-room sections are complete: Sales, Catalogue, Entry, Rostrum,
                Settlement, and Payout / Settings.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}