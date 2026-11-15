import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, Search, SlidersHorizontal, Landmark } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { SaleCard } from '../components/auctions/SaleCard'
import {
  FilterRail,
  type StatusFilter,
  type TierFilter,
} from '../components/auctions/FilterRail'
import { API, normalizeAccessMode, type Sale } from '../lib/sales'
import styles from './AuctionsPage.module.css'

import { AUTH_API as AUTH } from '../lib/config'

type SortKey = 'default' | 'soonest' | 'recent'
type Standing = 'loading' | 'none' | 'pending' | 'approved' | 'rejected'

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'default', label: 'On now first', hint: 'Live rooms, then by the hammer' },
  { key: 'soonest', label: 'Starting soonest', hint: 'Next to open the doors' },
  { key: 'recent', label: 'Recently added', hint: 'Newest rooms on the floor' },
]

const SALES_CACHE_TTL = 45_000
const STANDING_CACHE_TTL = 5 * 60_000

function ts(raw: string | null | undefined): number {
  if (!raw) return Infinity
  const t = new Date(String(raw).replace(' ', 'T')).getTime()
  return Number.isFinite(t) ? t : Infinity
}

function createdTs(s: Sale): number {
  const raw = (s as any).created_at
  if (!raw) return 0
  const t = new Date(String(raw).replace(' ', 'T')).getTime()
  return Number.isFinite(t) ? t : 0
}

// ---------------------------------------------------------------------------
// Module-level cache.
//
// This survives component unmount/remount. When the user switches tabs or
// routes and comes back, the auction floor can hydrate instantly from memory.
// ---------------------------------------------------------------------------

type SalesCache = {
  ts: number
  viewer: string
  sales: Sale[]
}

let salesCache: SalesCache | null = null

function getCachedSales(viewer: string): Sale[] | null {
  if (!salesCache) return null
  if (salesCache.viewer !== viewer) return null
  if (Date.now() - salesCache.ts > SALES_CACHE_TTL) return null
  return salesCache.sales
}

function setCachedSales(viewer: string, sales: Sale[]) {
  salesCache = {
    ts: Date.now(),
    viewer,
    sales,
  }
}

function invalidateSalesCache() {
  salesCache = null
}

type StandingCache = {
  ts: number
  viewer: string
  standing: Standing
}

let standingCache: StandingCache | null = null

function getCachedStanding(viewer: string): Standing | null {
  if (!standingCache) return null
  if (standingCache.viewer !== viewer) return null
  if (Date.now() - standingCache.ts > STANDING_CACHE_TTL) return null
  return standingCache.standing
}

function setCachedStanding(viewer: string, standing: Standing) {
  standingCache = {
    ts: Date.now(),
    viewer,
    standing,
  }
}

// ---------------------------------------------------------------------------
// Auction-specific skeleton.
// ---------------------------------------------------------------------------

function AuctionsSkeleton() {
  return (
    <div className={styles.shell}>
      <div className={styles.pageHead}>
        <div>
          <div className={styles.skelBar} style={{ width: 260, height: 34 }} />
          <div className={styles.skelBar} style={{ width: 360, height: 16, marginTop: 12 }} />
        </div>

        <div className={styles.skelBar} style={{ width: 110, height: 38, borderRadius: 999 }} />
      </div>

      <div className={styles.hostStrip}>
        <div className={styles.skelBar} style={{ width: 280, height: 18 }} />
        <div className={styles.skelBar} style={{ width: 190, height: 38, borderRadius: 999 }} />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.skelBar} style={{ flex: 1, height: 40, borderRadius: 999 }} />
        <div className={styles.skelBar} style={{ width: 170, height: 40, borderRadius: 999 }} />
      </div>

      <div className={styles.cols}>
        <div className={styles.railCol}>
          <div className={styles.skelRail}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={styles.skelBar} style={{ height: 34, borderRadius: 12 }} />
            ))}
          </div>
        </div>

        <div className={styles.gridCol}>
          <div className={styles.skelGrid}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={styles.skelCard} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function AuctionRetryPanel({
  message,
  onRetry,
  retrying,
}: {
  message: string
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className={styles.retryPanel}>
      <span>{message}</span>

      <button onClick={onRetry} disabled={retrying}>
        <RefreshCw size={13} className={retrying ? styles.skelSpin : undefined} />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

export function AuctionsPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [sales, setSales] = useState<Sale[]>(() => getCachedSales(viewer) || [])
  const [loading, setLoading] = useState(() => !getCachedSales(viewer))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [tier, setTier] = useState<TierFilter>('all')
  const [sort, setSort] = useState<SortKey>('default')
  const [railOpen, setRailOpen] = useState(false)

  const [standing, setStanding] = useState<Standing>(() => {
    if (!localStorage.getItem('space_token')) return 'none'
    if (localStorage.getItem('space_role') === 'house') return 'approved'
    return getCachedStanding(viewer) || 'loading'
  })

  // sort dropdown state
  const [sortOpen, setSortOpen] = useState(false)
  const [sortCursor, setSortCursor] = useState(0)
  const sortRef = useRef<HTMLDivElement>(null)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const sortListRef = useRef<HTMLUListElement>(null)
  const sortId = useId()
  const railId = useId()

  const salesRef = useRef(sales)
  const mounted = useRef(true)

  useEffect(() => {
    salesRef.current = sales
  }, [sales])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fetchSales = useCallback(
    async (force = false) => {
      if (!viewer) return
      if (!localStorage.getItem('space_token')) return

      const cached = getCachedSales(viewer)

      if (!force && cached) {
        setSales(cached)
        setLoading(false)
        setRefreshing(false)
        setError('')
        return
      }

      const hasExisting = salesRef.current.length > 0

      if (!hasExisting) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }

      setError('')

      try {
        const res = await fetch(`${API}/sales?viewer=${encodeURIComponent(viewer)}`)
        const d = await res.json()

        if (!mounted.current) return

        if (d?.error) {
          throw new Error(d.error)
        }

        const nextSales: Sale[] = d.sales || []

        setSales(nextSales)
        setCachedSales(viewer, nextSales)
      } catch (e: any) {
        if (!mounted.current) return

        const message = e?.message || 'Could not reach the auction floor.'

        // If we already have cached sales, keep showing them and surface a soft error.
        setError(message)
      } finally {
        if (mounted.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [viewer],
  )

  const fetchStanding = useCallback(async () => {
    if (!viewer) return
    if (!localStorage.getItem('space_token')) {
      setStanding('none')
      return
    }

    if (localStorage.getItem('space_role') === 'house') {
      setStanding('approved')
      setCachedStanding(viewer, 'approved')
      return
    }

    const cached = getCachedStanding(viewer)

    if (cached) {
      setStanding(cached)
      return
    }

    setStanding('loading')

    try {
      const res = await fetch(
        `${AUTH}/house/application?viewer=${encodeURIComponent(viewer)}`,
      )

      const d = await res.json()

      if (!mounted.current) return

      const nextStanding: Standing =
        d.status === 'approved' ||
        d.status === 'pending' ||
        d.status === 'rejected'
          ? d.status
          : 'none'

      setStanding(nextStanding)
      setCachedStanding(viewer, nextStanding)
    } catch {
      if (mounted.current) {
        setStanding('none')
        setCachedStanding(viewer, 'none')
      }
    }
  }, [viewer])

  // Initial load.
  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      setLoading(false)
      navigate('/login', { replace: true })
      return
    }

    void fetchSales(false)
    void fetchStanding()
  }, [viewer, navigate, fetchSales, fetchStanding])

  // Gentle auto-refresh while there are upcoming/live rooms on the floor.
  const hasActiveRooms = useMemo(
    () => sales.some(s => s.status === 'live' || s.status === 'upcoming'),
    [sales],
  )

  useEffect(() => {
    if (!localStorage.getItem('space_token')) return
    if (!hasActiveRooms) return

    const timer = window.setInterval(() => {
      // Do not refresh while tab is hidden.
      if (document.hidden) return

      void fetchSales(true)
    }, 20000)

    return () => window.clearInterval(timer)
  }, [hasActiveRooms, fetchSales])

  // close the sort menu on outside click / Escape; focus the list when it opens
  useEffect(() => {
    if (!sortOpen) return

    setSortCursor(Math.max(0, SORTS.findIndex(o => o.key === sort)))
    sortListRef.current?.focus()

    const onDown = (e: MouseEvent) => {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSortOpen(false)
        sortTriggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [sortOpen, sort])

  const counts = useMemo(
    () => ({
      live: sales.filter(s => s.status === 'live').length,
      upcoming: sales.filter(s => s.status === 'upcoming').length,
      ended: sales.filter(s => s.status === 'ended').length,
    }),
    [sales],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    let list = sales.filter(s => {
      if (status !== 'all' && s.status !== status) return false

      if (tier !== 'all') {
        const saleMode = normalizeAccessMode((s as any).access_mode ?? s.tier)
        const filterMode = normalizeAccessMode(tier)
        if (saleMode !== filterMode) return false
      }

      if (q) {
        const haystack = `${s.title} ${s.description || ''} ${s.host_username}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }

      return true
    })

    if (sort === 'default') {
      const rank: Record<string, number> = {
        live: 0,
        upcoming: 1,
        ended: 2,
      }

      list = [...list].sort(
        (a, b) =>
          (rank[a.status] ?? 3) - (rank[b.status] ?? 3) ||
          (a.status === 'live'
            ? ts(a.ends_at) - ts(b.ends_at)
            : ts(a.starts_at) - ts(b.starts_at)),
      )
    } else if (sort === 'soonest') {
      list = [...list].sort(
        (a, b) =>
          (a.status === 'ended' ? Infinity : ts(a.status === 'live' ? a.ends_at : a.starts_at)) -
          (b.status === 'ended' ? Infinity : ts(b.status === 'live' ? b.ends_at : b.starts_at)),
      )
    } else if (sort === 'recent') {
      list = [...list].sort((a, b) => createdTs(b) - createdTs(a))
    }

    return list
  }, [sales, query, status, tier, sort])

  const filtersActive = status !== 'all' || tier !== 'all' || query.trim() !== ''

  const clearFilters = () => {
    setStatus('all')
    setTier('all')
    setQuery('')
  }

  const retrySales = useCallback(() => {
    invalidateSalesCache()
    void fetchSales(true)
  }, [fetchSales])

  const hostCta =
    standing === 'loading'
      ? { label: 'Checking access…', to: '', disabled: true }
      : standing === 'approved'
        ? { label: 'Enter the control room', to: '/sales/control', disabled: false }
        : standing === 'pending'
          ? { label: 'Rostrum under review', to: '', disabled: true }
          : standing === 'rejected'
            ? { label: 'Reapply for the rostrum', to: '/house/apply', disabled: false }
            : { label: 'Request the rostrum', to: '/house/apply', disabled: false }

  const currentSort = SORTS.find(o => o.key === sort) ?? SORTS[0]

  const pickSort = (k: SortKey) => {
    setSort(k)
    setSortOpen(false)
    sortTriggerRef.current?.focus()
  }

  const onSortListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSortCursor(c => Math.min(SORTS.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSortCursor(c => Math.max(0, c - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pickSort(SORTS[sortCursor].key)
    } else if (e.key === 'Tab') {
      setSortOpen(false)
    }
  }

  const showInitialSkeleton = loading && sales.length === 0

  return (
    <main className={styles.layout}>
      <Navbar />

      {showInitialSkeleton ? (
        <AuctionsSkeleton />
      ) : (
        <div className={styles.shell}>
          <header className={styles.pageHead}>
            <div>
              <h1 className={styles.heading}>The Auction Floor</h1>
              <p className={styles.strap}>Tonight’s rooms, in order of the hammer.</p>
            </div>

            <button
              className={styles.railToggle}
              onClick={() => setRailOpen(o => !o)}
              aria-expanded={railOpen}
              aria-controls={railId}
            >
              <SlidersHorizontal size={15} /> Filters
            </button>
          </header>

          {/* THE ROSTRUM STRIP — earned, not bought */}
          <div className={styles.hostStrip}>
            <p className={styles.hostStrap}>The rostrum is earned, not bought.</p>

            <button
              className={`${styles.hostBtn} ${hostCta.disabled ? styles.hostBtnQuiet : ''}`}
              disabled={hostCta.disabled}
              onClick={() => hostCta.to && navigate(hostCta.to)}
            >
              <Landmark size={14} /> {hostCta.label}
            </button>
          </div>

          {(refreshing || (error && sales.length > 0)) && (
            <div className={styles.statusRow}>
              {refreshing && (
                <span className={styles.refreshPill}>
                  <RefreshCw size={12} className={styles.skelSpin} />
                  Updating floor…
                </span>
              )}

              {error && sales.length > 0 && (
                <span className={styles.errorPill}>
                  {error}
                  <button onClick={retrySales}>Retry</button>
                </span>
              )}
            </div>
          )}

          <div className={styles.toolbar}>
            <div className={styles.searchWrap}>
              <Search size={15} className={styles.searchIcon} />

              <input
                className={styles.search}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search a room, a house, or a work…"
                aria-label="Search the floor"
              />

              {query && (
                <button
                  className={styles.searchClear}
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            <div className={styles.toolRight}>
              <span className={styles.showing}>
                Showing {filtered.length} of {sales.length}
              </span>

              {/* sort dropdown */}
              <div className={styles.sortWrap} ref={sortRef}>
                <button
                  ref={sortTriggerRef}
                  type="button"
                  className={`${styles.sort} ${sortOpen ? styles.sortOpen : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={sortOpen}
                  aria-controls={sortId}
                  onClick={() => setSortOpen(o => !o)}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSortOpen(true)
                    }
                  }}
                >
                  <span className={styles.sortPrefix}>Sort</span>
                  <span className={styles.sortValue}>{currentSort.label}</span>

                  <svg
                    className={styles.sortChev}
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <path
                      d="M1.5 3.5 5 7l3.5-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                {sortOpen && (
                  <ul
                    id={sortId}
                    ref={sortListRef}
                    className={styles.sortMenu}
                    role="listbox"
                    tabIndex={-1}
                    aria-activedescendant={`${sortId}-${sortCursor}`}
                    onKeyDown={onSortListKey}
                  >
                    {SORTS.map((o, i) => (
                      <li
                        key={o.key}
                        id={`${sortId}-${i}`}
                        role="option"
                        aria-selected={o.key === sort}
                        className={`${styles.sortItem} ${
                          o.key === sort ? styles.sortItemOn : ''
                        } ${i === sortCursor ? styles.sortItemHot : ''}`}
                        onMouseEnter={() => setSortCursor(i)}
                        onClick={() => pickSort(o.key)}
                      >
                        <span className={styles.sortMark} aria-hidden="true" />
                        <span className={styles.sortText}>
                          <span className={styles.sortLabel}>{o.label}</span>
                          <span className={styles.sortHint}>{o.hint}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          <div className={`${styles.cols} ${railOpen ? styles.colsOpen : ''}`}>
            <div className={styles.railCol} id={railId}>
              <FilterRail
                status={status}
                setStatus={setStatus}
                tier={tier}
                setTier={setTier}
                counts={counts}
                active={filtersActive}
                onClear={clearFilters}
              />
            </div>

            <div className={styles.gridCol}>
              {error && sales.length === 0 ? (
                <AuctionRetryPanel
                  message={error}
                  onRetry={retrySales}
                  retrying={refreshing}
                />
              ) : filtered.length === 0 ? (
                <div className={styles.emptyBlock}>
                  <p className={styles.empty}>
                    {sales.length === 0
                      ? 'The floor is quiet. No rooms scheduled.'
                      : 'No rooms match. Loosen the filters.'}
                  </p>

                  {sales.length > 0 && filtersActive ? (
                    <button className={styles.clearInline} onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className={styles.grid}>
                  {filtered.map(s => (
                    <SaleCard
                      key={s.id}
                      sale={s}
                      onOpen={() => navigate(`/sales/${s.id}`)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}