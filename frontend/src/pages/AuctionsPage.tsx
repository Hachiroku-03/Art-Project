import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, SlidersHorizontal } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { SaleCard } from '../components/auctions/SaleCard'
import { FilterRail, type StatusFilter, type TierFilter } from '../components/auctions/FilterRail'
import { API, type Sale } from '../lib/sales'
import styles from './AuctionsPage.module.css'

type SortKey = 'default' | 'soonest' | 'recent'

function ts(raw: string | null) { return raw ? new Date(raw.replace(' ', 'T')).getTime() : Infinity }

export function AuctionsPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [tier, setTier] = useState<TierFilter>('all')
  const [sort, setSort] = useState<SortKey>('default')
  const [railOpen, setRailOpen] = useState(false) // mobile disclosure

  useEffect(() => {
    if (!localStorage.getItem('space_token')) { navigate('/login', { replace: true }); return }
    fetch(`${API}/sales?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => { setSales(d.sales || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [viewer, navigate])

  const counts = useMemo(() => ({
    live: sales.filter(s => s.status === 'live').length,
    upcoming: sales.filter(s => s.status === 'upcoming').length,
    ended: sales.filter(s => s.status === 'ended').length,
  }), [sales])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sales.filter(s => {
      if (status !== 'all' && s.status !== status) return false
      if (tier !== 'all' && s.tier !== tier) return false
      if (q && !(`${s.title} ${s.host_username}`.toLowerCase().includes(q))) return false
      return true
    })
    if (sort === 'default') {
      // a.status is SaleStatus now, so these literal keys are provably valid — no error.
      const rank = { live: 0, upcoming: 1, ended: 2 } as const
      list = [...list].sort((a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.status === 'live' ? ts(a.ends_at) - ts(b.ends_at) : ts(a.starts_at) - ts(b.starts_at)))
    } else if (sort === 'soonest') {
      list = [...list].sort((a, b) =>
        (a.status === 'ended' ? Infinity : ts(a.status === 'live' ? a.ends_at : a.starts_at)) -
        (b.status === 'ended' ? Infinity : ts(b.status === 'live' ? b.ends_at : b.starts_at)))
    }
    // 'recent' keeps the server's created-desc order
    return list
  }, [sales, query, status, tier, sort])

  const filtersActive = status !== 'all' || tier !== 'all' || query.trim() !== ''
  const clearFilters = () => { setStatus('all'); setTier('all'); setQuery('') }

  return (
    <main className={styles.layout}>
      <Preloader done={!loading} />
      <Navbar />
      <div className={styles.shell}>

        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.heading}>The Auction Floor</h1>
            <p className={styles.strap}>Tonight’s rooms, in order of the hammer.</p>
          </div>
          <button className={styles.railToggle} onClick={() => setRailOpen(o => !o)} aria-expanded={railOpen}>
            <SlidersHorizontal size={15} /> Filters
          </button>
        </header>

        <div className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <Search size={15} className={styles.searchIcon} />
            <input
              className={styles.search}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search a room or a house…"
              aria-label="Search the floor"
            />
            {query && <button className={styles.searchClear} onClick={() => setQuery('')} aria-label="Clear search">×</button>}
          </div>
          <div className={styles.toolRight}>
            <span className={styles.showing}>Showing {filtered.length} of {sales.length}</span>
            <select className={styles.sort} value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="Sort">
              <option value="default">On now first</option>
              <option value="soonest">Starting soonest</option>
              <option value="recent">Recently added</option>
            </select>
          </div>
        </div>

        <div className={`${styles.cols} ${railOpen ? styles.colsOpen : ''}`}>
          <div className={styles.railCol}>
            <FilterRail
              status={status} setStatus={setStatus}
              tier={tier} setTier={setTier}
              counts={counts} active={filtersActive} onClear={clearFilters}
            />
          </div>

          <div className={styles.gridCol}>
            {filtered.length === 0 ? (
              <p className={styles.empty}>
                {sales.length === 0 ? 'The floor is quiet. No rooms scheduled.' : 'No rooms match. Loosen the filters.'}
              </p>
            ) : (
              <div className={styles.grid}>
                {filtered.map(s => <SaleCard key={s.id} sale={s} onOpen={() => navigate(`/sales/${s.id}`)} />)}
              </div>
            )}
          </div>
        </div>

      </div>
    </main>
  )
}