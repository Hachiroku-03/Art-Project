import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, SlidersHorizontal, Landmark } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { SaleCard } from '../components/auctions/SaleCard'
import { FilterRail, type StatusFilter, type TierFilter } from '../components/auctions/FilterRail'
import { API, normalizeAccessMode, type Sale } from '../lib/sales'
import styles from './AuctionsPage.module.css'

const AUTH = 'http://localhost:8000'

type SortKey = 'default' | 'soonest' | 'recent'
type Standing = 'loading' | 'none' | 'pending' | 'approved' | 'rejected'

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'default', label: 'On now first', hint: 'Live rooms, then by the hammer' },
  { key: 'soonest', label: 'Starting soonest', hint: 'Next to open the doors' },
  { key: 'recent', label: 'Recently added', hint: 'Newest rooms on the floor' },
]

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

export function AuctionsPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [tier, setTier] = useState<TierFilter>('all')
  const [sort, setSort] = useState<SortKey>('default')
  const [railOpen, setRailOpen] = useState(false)
  const [standing, setStanding] = useState<Standing>('loading')

  // sort dropdown state
  const [sortOpen, setSortOpen] = useState(false)
  const [sortCursor, setSortCursor] = useState(0)
  const sortRef = useRef<HTMLDivElement>(null)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const sortListRef = useRef<HTMLUListElement>(null)
  const sortId = useId()
  const railId = useId()

  const loadSales = useRef<() => void>(() => {})

  loadSales.current = () => {
    if (!localStorage.getItem('space_token')) return

    fetch(`${API}/sales?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        if (d?.error) {
          setError(d.error)
          setSales([])
        } else {
          setError('')
          setSales(d.sales || [])
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Could not reach the auction floor.')
        setLoading(false)
      })
  }

  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      setLoading(false)
      navigate('/login', { replace: true })
      return
    }

    loadSales.current()
  }, [viewer, navigate])

  // House standing — drives the rostrum button. role==='house' is the fast path.
  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      setStanding('none')
      return
    }

    if (localStorage.getItem('space_role') === 'house') {
      setStanding('approved')
      return
    }

    fetch(`${AUTH}/house/application?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d =>
        setStanding(
          d.status === 'approved' || d.status === 'pending' || d.status === 'rejected'
            ? d.status
            : 'none',
        ),
      )
      .catch(() => setStanding('none'))
  }, [viewer])

  // Gentle auto-refresh while there are upcoming/live rooms on the floor.
  const hasActiveRooms = useMemo(
    () => sales.some(s => s.status === 'live' || s.status === 'upcoming'),
    [sales],
  )

  useEffect(() => {
    if (!localStorage.getItem('space_token')) return
    if (!hasActiveRooms) return

    const timer = window.setInterval(() => {
      loadSales.current()
    }, 20000)

    return () => window.clearInterval(timer)
  }, [hasActiveRooms, viewer])

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
      const rank = { live: 0, upcoming: 1, ended: 2 } as const
      list = [...list].sort(
        (a, b) =>
          rank[a.status] - rank[b.status] ||
          (a.status === 'live' ? ts(a.ends_at) - ts(b.ends_at) : ts(a.starts_at) - ts(b.starts_at)),
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
            {error ? (
              <p className={styles.empty}>{error}</p>
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
                  <SaleCard key={s.id} sale={s} onOpen={() => navigate(`/sales/${s.id}`)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}