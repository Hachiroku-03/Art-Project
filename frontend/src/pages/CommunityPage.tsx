import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Plus, RefreshCw, Search } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import {
  fetchConversations,
  joinOrRequestGroup,
  cancelGroupJoinRequest,
  approveGroupJoinRequest,
  rejectGroupJoinRequest,
  type Conversation,
} from '../lib/chat'
import { markNotificationRead, type AppNotification } from '../lib/notifications'
import { API } from '../lib/sales'
import {
  fetchCanHostCalls,
  fetchCommunityCalendar,
  fetchCommunityCalls,
  fetchCommunityDiscover,
  fetchCommunityInvites,
  fetchCommunityLive,
  fetchCommunityPeople,
  fetchCommunityRequests,
  fetchCommunityTaxonomy,
  toggleCommunityCallInterest,
  type CommunityCalendar,
  type CommunityCall,
  type CommunityGroup,
  type CommunityInvite,
  type CommunityLive,
  type CommunityPerson,
  type CommunityRequest,
  type Taxonomy,
} from '../lib/community'
import { CallComposerModal } from '../components/CallComposerModal'
import styles from './CommunityPage.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fromNow(raw?: string | null) {
  if (!raw) return ''
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function dayMonth(raw?: string | null) {
  if (!raw) return { day: '—', month: '' }
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(d.getTime())) return { day: '—', month: '' }
  return {
    day: String(d.getDate()).padStart(2, '0'),
    month: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
  }
}

function previewFromConv(c: Conversation, viewer: string) {
  const kind = c.last_kind
  const body = (c.last_body || '').trim()
  let content: string

  if (kind === 'image') content = '📷 Photo'
  else if (kind === 'voice') content = '🎤 Voice note'
  else if (kind === 'video') content = '🎬 Video'
  else if (kind === 'file') content = '📎 File'
  else if (kind === 'location') content = '📍 Location'
  else if (kind === 'contact') content = '👤 Contact'
  else if (kind === 'system') content = body || 'System message'
  else content = body || 'New message'

  const sender = String((c as { last_sender?: string | null }).last_sender || '').trim()
  if (!sender) return content

  const who = sender.toLowerCase() === (viewer || '').toLowerCase() ? 'You' : sender
  return `${who}: ${content}`
}

function Thumb({
  tone,
  image,
  className,
  children,
}: {
  tone?: string
  image?: string | null
  className: string
  children?: React.ReactNode
}) {
  if (image) {
    return (
      <span className={className} style={{ backgroundImage: `url(${image})` }}>
        {children}
      </span>
    )
  }

  return (
    <span className={className} style={{ background: tone }}>
      {children}
    </span>
  )
}

const FALLBACK_TONES = [
  'linear-gradient(135deg,#7e1f24,#c9463f)',
  'linear-gradient(135deg,#16213e,#2a3f6b)',
  'linear-gradient(135deg,#5a3a22,#9c6b3f)',
  'linear-gradient(135deg,#2a4a3f,#4f8a6b)',
]

function toneFor(id: number | string) {
  const n = typeof id === 'string' ? id.length : id
  return FALLBACK_TONES[n % FALLBACK_TONES.length]
}

const KIND_LABEL: Record<string, string> = {
  exhibition: 'Exhibition',
  residency: 'Residency',
  consignment: 'Consignment window',
  open_call: 'Open call',
  award: 'Award / prize',
  talk: 'Talk',
  studio_visit: 'Studio visit',
  deadline: 'Deadline',
}

const KIND_CODE: Record<string, string> = {
  exhibition: 'EXH',
  residency: 'RES',
  consignment: 'CONS',
  open_call: 'CALL',
  award: 'AWARD',
  talk: 'TALK',
  studio_visit: 'VISIT',
  deadline: 'DUE',
}

function kindLabel(k?: string | null) {
  return (k && KIND_LABEL[k]) || 'Opportunity'
}

function kindCode(k?: string | null) {
  return (k && KIND_CODE[k]) || 'CALL'
}

function parseDate(raw?: string | null) {
  if (!raw) return null
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return isNaN(d.getTime()) ? null : d
}

function untilLabel(raw?: string | null, status?: string) {
  if (status && status !== 'open') {
    return { text: status === 'cancelled' ? 'Cancelled' : 'Closed', tone: 'closed' as const }
  }

  const d = parseDate(raw)
  if (!d) return { text: '', tone: 'normal' as const }

  const ms = d.getTime() - Date.now()
  if (ms <= 0) return { text: 'Deadline passed', tone: 'closed' as const }

  const h = ms / 36e5
  if (h < 1) return { text: 'Closes in minutes', tone: 'soon' as const }
  if (h < 24) return { text: `Closes in ${Math.max(1, Math.round(h))}h`, tone: 'soon' as const }
  if (h < 48) return { text: 'Closes tomorrow', tone: 'soon' as const }

  return { text: `Closes in ${Math.round(h / 24)}d`, tone: 'normal' as const }
}

function eligSummary(e: unknown): string {
  if (!e || typeof e !== 'object') return ''

  const obj = e as Record<string, unknown>
  const parts: string[] = []

  if (obj.region) parts.push(String(obj.region))

  if (Array.isArray(obj.medium)) {
    parts.push((obj.medium as unknown[]).slice(0, 3).join(', '))
  } else if (typeof obj.medium === 'string' && obj.medium.trim()) {
    parts.push(obj.medium.trim())
  }

  if (obj.age_max != null) parts.push(`Under ${obj.age_max}`)
  else if (obj.age_min != null) parts.push(`${obj.age_min}+`)

  return parts.slice(0, 3).join(' · ')
}

function callDateParts(c: CommunityCall) {
  const d = parseDate(c.deadline_at) || parseDate(c.starts_at)

  if (d) {
    return {
      top: String(d.getDate()).padStart(2, '0'),
      bottom: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
      code: false,
    }
  }

  return { top: kindCode(c.kind), bottom: '', code: true }
}

// ---------------------------------------------------------------------------
// Module-level slice cache.
//
// This survives component unmount/remount. When the user switches tabs or
// routes and comes back, Community sections can hydrate instantly from memory.
// ---------------------------------------------------------------------------

const COMMUNITY_SLICE_TTL = 90_000
const COMMUNITY_CACHE_MAX = 100

type SliceCacheEntry = {
  ts: number
  viewer: string
  data: unknown
}

const sliceCache = new Map<string, SliceCacheEntry>()

function makeSliceKey(viewer: string, name: string, params: Record<string, unknown> = {}) {
  return `${viewer}|${name}|${JSON.stringify(params)}`
}

function trimSliceCache() {
  if (sliceCache.size <= COMMUNITY_CACHE_MAX) return

  const entries = Array.from(sliceCache.entries()).sort((a, b) => a[1].ts - b[1].ts)
  const removeCount = sliceCache.size - COMMUNITY_CACHE_MAX

  for (let i = 0; i < removeCount; i += 1) {
    sliceCache.delete(entries[i][0])
  }
}

function getCachedSlice<T>(key: string, viewer: string): T | null {
  if (!key || !viewer) return null

  const entry = sliceCache.get(key)
  if (!entry || entry.viewer !== viewer) return null

  if (Date.now() - entry.ts > COMMUNITY_SLICE_TTL) {
    sliceCache.delete(key)
    return null
  }

  return entry.data as T
}

function setCachedSlice(key: string, viewer: string, data: unknown) {
  if (!key || !viewer || data === undefined) return

  sliceCache.set(key, {
    ts: Date.now(),
    viewer,
    data,
  })

  trimSliceCache()
}

function invalidateViewerSlices(viewer: string) {
  if (!viewer) return

  const prefix = `${viewer}|`

  for (const key of Array.from(sliceCache.keys())) {
    if (key.startsWith(prefix)) {
      sliceCache.delete(key)
    }
  }
}

async function getOrFetchSlice<T>(
  key: string,
  viewer: string,
  loader: () => Promise<T>,
  force = false,
): Promise<T> {
  if (!force) {
    const cached = getCachedSlice<T>(key, viewer)
    if (cached !== null) return cached
  }

  const data = await loader()
  setCachedSlice(key, viewer, data)
  return data
}

// ---------------------------------------------------------------------------
// Your Groups cache.
//
// Stored in localStorage so it survives full page reloads too.
// ---------------------------------------------------------------------------

const MY_GROUPS_CACHE_KEY = 'space_community_my_groups_v2_'
const MY_GROUPS_CACHE_TTL = 2 * 60_000
const MY_GROUPS_SOFT_TTL = 30_000

type MyGroupsCache = {
  ts: number
  groups: Conversation[]
}

function readMyGroupsCache(viewer: string): MyGroupsCache | null {
  if (!viewer) return null

  try {
    const raw = localStorage.getItem(`${MY_GROUPS_CACHE_KEY}${viewer}`)
    if (!raw) return null

    const parsed = JSON.parse(raw) as MyGroupsCache

    if (!parsed || typeof parsed.ts !== 'number') return null
    if (Date.now() - parsed.ts > MY_GROUPS_CACHE_TTL) return null
    if (!Array.isArray(parsed.groups)) return null

    return parsed
  } catch {
    return null
  }
}

function writeMyGroupsCache(viewer: string, groups: Conversation[]) {
  if (!viewer) return

  try {
    localStorage.setItem(
      `${MY_GROUPS_CACHE_KEY}${viewer}`,
      JSON.stringify({
        ts: Date.now(),
        groups,
      }),
    )
  } catch {
    // ignore quota/private-mode errors
  }
}

function clearMyGroupsCache(viewer: string) {
  if (!viewer) return

  try {
    localStorage.removeItem(`${MY_GROUPS_CACHE_KEY}${viewer}`)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Skeleton / retry UI
// ---------------------------------------------------------------------------

function CommunitySkeleton() {
  return (
    <div className={styles.shell}>
      <div className={styles.hero}>
        <div className={styles.heroText}>
          <div className={styles.skelBar} style={{ width: 220, height: 34 }} />
          <div className={styles.skelBar} style={{ width: 480, height: 14, marginTop: 12 }} />
        </div>

        <div className={styles.heroActions}>
          <div className={styles.skelBar} style={{ width: 280, height: 38, borderRadius: 999 }} />
          <div className={styles.skelBar} style={{ width: 120, height: 38, borderRadius: 999 }} />
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.main}>
          <section className={styles.section}>
            <div className={styles.skelBar} style={{ width: 140, height: 14 }} />
            <div className={styles.skelStrip} style={{ marginTop: 12 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={styles.skelCard} style={{ width: 280, height: 92 }} />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.skelBar} style={{ width: 140, height: 14 }} />
            <div className={styles.skelCards} style={{ marginTop: 12 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={styles.skelCard} style={{ height: 220 }} />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.skelBar} style={{ width: 140, height: 14 }} />
            <div className={styles.skelCards} style={{ marginTop: 12 }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className={styles.skelCard} style={{ height: 120 }} />
              ))}
            </div>
          </section>
        </div>

        <aside className={styles.rail}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={styles.skelCard} style={{ height: 170 }} />
          ))}
        </aside>
      </div>
    </div>
  )
}

function SectionRetry({
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
        <RefreshCw size={12} className={retrying ? styles.skelSpin : undefined} />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function CommunityPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- local UI state ----
  const [myGroups, setMyGroups] = useState<Conversation[]>([])

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [scene, setScene] = useState<string | null>(null)

  const [taxonomy, setTaxonomy] = useState<Taxonomy>({ categories: [], scenes: [] })
  const [taxonomyLoading, setTaxonomyLoading] = useState(true)

  const [discover, setDiscover] = useState<CommunityGroup[]>([])
  const [discoverLoading, setDiscoverLoading] = useState(true)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [discoverRetrying, setDiscoverRetrying] = useState(false)

  const [calls, setCalls] = useState<CommunityCall[]>([])
  const [callsLoading, setCallsLoading] = useState(true)
  const [callsError, setCallsError] = useState<string | null>(null)
  const [callsRetrying, setCallsRetrying] = useState(false)

  const [requests, setRequests] = useState<CommunityRequest[]>([])
  const [invites, setInvites] = useState<CommunityInvite[]>([])
  const [people, setPeople] = useState<CommunityPerson[]>([])
  const [live, setLive] = useState<CommunityLive[]>([])
  const [calendar, setCalendar] = useState<CommunityCalendar[]>([])
  const [sidebarsLoading, setSidebarsLoading] = useState(true)

  const [canHost, setCanHost] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerInitial, setComposerInitial] = useState<CommunityCall | null>(null)

  const [followed, setFollowed] = useState<Record<string, boolean>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [recentlyJoinedId, setRecentlyJoinedId] = useState<number | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)

  const joinTimerRef = useRef<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // ---- cache keys ----
  const taxonomyKey = useMemo(() => (viewer ? makeSliceKey(viewer, 'taxonomy') : ''), [viewer])

  const discoverParams = useMemo(
    () => ({
      q: search.trim(),
      category: category ?? null,
      scene: scene ?? null,
    }),
    [search, category, scene],
  )

  const discoverKey = useMemo(
    () => (viewer ? makeSliceKey(viewer, 'discover', discoverParams) : ''),
    [viewer, discoverParams],
  )

  const callsParams = useMemo(
    () => ({
      scene: scene ?? null,
      status: 'open',
      limit: 6,
    }),
    [scene],
  )

  const callsKey = useMemo(
    () => (viewer ? makeSliceKey(viewer, 'calls', callsParams) : ''),
    [viewer, callsParams],
  )

  const canHostKey = useMemo(() => (viewer ? makeSliceKey(viewer, 'can-host') : ''), [viewer])

  const sidebarKeys = useMemo(
    () => ({
      requests: viewer ? makeSliceKey(viewer, 'requests') : '',
      invites: viewer ? makeSliceKey(viewer, 'invites') : '',
      people: viewer ? makeSliceKey(viewer, 'people') : '',
      live: viewer ? makeSliceKey(viewer, 'live') : '',
      calendar: viewer ? makeSliceKey(viewer, 'calendar') : '',
    }),
    [viewer],
  )

  // ---- bootstrapped / skeleton control ----
  useEffect(() => {
    if (!viewer) {
      setBootstrapped(true)
      return
    }

    if (!taxonomyLoading && !discoverLoading && !callsLoading) {
      setBootstrapped(true)
    }
  }, [viewer, taxonomyLoading, discoverLoading, callsLoading])

  // ---- open group chat ----
  const openGroupChat = useCallback(
    (id: number) => {
      window.dispatchEvent(new CustomEvent('open-chat', { detail: id }))
      navigate('/messenger')
    },
    [navigate],
  )

  // ---- taxonomy ----
  useEffect(() => {
    if (!viewer || !taxonomyKey) {
      setTaxonomy({ categories: [], scenes: [] })
      setTaxonomyLoading(false)
      return
    }

    const cached = getCachedSlice<Taxonomy>(taxonomyKey, viewer)
    if (cached) {
      setTaxonomy(cached)
      setTaxonomyLoading(false)
      return
    }

    let alive = true
    setTaxonomyLoading(true)

    fetchCommunityTaxonomy(viewer)
      .then(t => {
        if (!alive || !mounted.current) return

        setTaxonomy(t)
        setCachedSlice(taxonomyKey, viewer, t)
        setTaxonomyLoading(false)
      })
      .catch(() => {
        if (alive && mounted.current) setTaxonomyLoading(false)
      })

    return () => {
      alive = false
    }
  }, [viewer, taxonomyKey, refreshTick])

  // ---- discover ----
  const loadDiscover = useCallback(
    async (force = false) => {
      if (!viewer || !discoverKey) {
        setDiscover([])
        setDiscoverLoading(false)
        setDiscoverError(null)
        return
      }

      if (!force) {
        const cached = getCachedSlice<CommunityGroup[]>(discoverKey, viewer)
        if (cached) {
          setDiscover(cached)
          setDiscoverLoading(false)
          setDiscoverError(null)
          return
        }
      }

      setDiscoverLoading(true)
      setDiscoverError(null)

      try {
        const rows = await fetchCommunityDiscover(viewer, discoverParams)
        if (!mounted.current) return

        setDiscover(rows)
        setCachedSlice(discoverKey, viewer, rows)
      } catch (e: any) {
        if (mounted.current) {
          setDiscoverError(e?.message || 'Could not load groups.')
        }
      } finally {
        if (mounted.current) setDiscoverLoading(false)
      }
    },
    [viewer, discoverKey, discoverParams],
  )

  useEffect(() => {
    if (!viewer) {
      setDiscover([])
      setDiscoverLoading(false)
      setDiscoverError(null)
      return
    }

    const cached = getCachedSlice<CommunityGroup[]>(discoverKey, viewer)
    if (cached) {
      setDiscover(cached)
      setDiscoverLoading(false)
      setDiscoverError(null)
      return
    }

    let alive = true
    setDiscoverLoading(true)
    setDiscoverError(null)

    const timer = window.setTimeout(() => {
      fetchCommunityDiscover(viewer, discoverParams)
        .then(rows => {
          if (!alive || !mounted.current) return

          setDiscover(rows)
          setCachedSlice(discoverKey, viewer, rows)
          setDiscoverLoading(false)
        })
        .catch(e => {
          if (!alive || !mounted.current) return

          setDiscoverError(e?.message || 'Could not load groups.')
          setDiscoverLoading(false)
        })
    }, 220)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [viewer, discoverKey, discoverParams, refreshTick])

  const retryDiscover = useCallback(async () => {
    setDiscoverRetrying(true)
    await loadDiscover(true)
    setDiscoverRetrying(false)
  }, [loadDiscover])

  // ---- calls ----
  const loadCalls = useCallback(
    async (force = false) => {
      if (!viewer || !callsKey) {
        setCalls([])
        setCallsLoading(false)
        setCallsError(null)
        return
      }

      if (!force) {
        const cached = getCachedSlice<CommunityCall[]>(callsKey, viewer)
        if (cached) {
          setCalls(cached)
          setCallsLoading(false)
          setCallsError(null)
          return
        }
      }

      setCallsLoading(true)
      setCallsError(null)

      try {
        const rows = await fetchCommunityCalls(viewer, {
          scene: callsParams.scene,
          status: 'open',
          limit: 6,
        })

        if (!mounted.current) return

        setCalls(rows)
        setCachedSlice(callsKey, viewer, rows)
      } catch (e: any) {
        if (mounted.current) {
          setCallsError(e?.message || 'Could not load opportunities.')
        }
      } finally {
        if (mounted.current) setCallsLoading(false)
      }
    },
    [viewer, callsKey, callsParams],
  )

  useEffect(() => {
    if (!viewer) {
      setCalls([])
      setCallsLoading(false)
      setCallsError(null)
      return
    }

    const cached = getCachedSlice<CommunityCall[]>(callsKey, viewer)
    if (cached) {
      setCalls(cached)
      setCallsLoading(false)
      setCallsError(null)
      return
    }

    let alive = true
    setCallsLoading(true)
    setCallsError(null)

    fetchCommunityCalls(viewer, {
      scene: callsParams.scene,
      status: 'open',
      limit: 6,
    })
      .then(rows => {
        if (!alive || !mounted.current) return

        setCalls(rows)
        setCachedSlice(callsKey, viewer, rows)
        setCallsLoading(false)
      })
      .catch(e => {
        if (!alive || !mounted.current) return

        setCallsError(e?.message || 'Could not load opportunities.')
        setCallsLoading(false)
      })

    return () => {
      alive = false
    }
  }, [viewer, callsKey, callsParams, refreshTick])

  const retryCalls = useCallback(async () => {
    setCallsRetrying(true)
    await loadCalls(true)
    setCallsRetrying(false)
  }, [loadCalls])

  // ---- sidebars ----
  const loadSidebars = useCallback(async () => {
    if (!viewer) {
      setRequests([])
      setInvites([])
      setPeople([])
      setLive([])
      setCalendar([])
      setSidebarsLoading(false)
      return
    }

    const cachedRequests = getCachedSlice<CommunityRequest[]>(sidebarKeys.requests, viewer)
    const cachedInvites = getCachedSlice<CommunityInvite[]>(sidebarKeys.invites, viewer)
    const cachedPeople = getCachedSlice<CommunityPerson[]>(sidebarKeys.people, viewer)
    const cachedLive = getCachedSlice<CommunityLive[]>(sidebarKeys.live, viewer)
    const cachedCalendar = getCachedSlice<CommunityCalendar[]>(sidebarKeys.calendar, viewer)

    if (
      cachedRequests !== null &&
      cachedInvites !== null &&
      cachedPeople !== null &&
      cachedLive !== null &&
      cachedCalendar !== null
    ) {
      setRequests(cachedRequests)
      setInvites(cachedInvites)
      setPeople(cachedPeople)
      setLive(cachedLive)
      setCalendar(cachedCalendar)
      setSidebarsLoading(false)
      return
    }

    setSidebarsLoading(true)

    const [rq, iv, pp] = await Promise.all([
      cachedRequests !== null
        ? Promise.resolve(cachedRequests)
        : getOrFetchSlice(sidebarKeys.requests, viewer, () =>
            fetchCommunityRequests(viewer).catch(() => [] as CommunityRequest[]),
          ),
      cachedInvites !== null
        ? Promise.resolve(cachedInvites)
        : getOrFetchSlice(sidebarKeys.invites, viewer, () =>
            fetchCommunityInvites(viewer).catch(() => [] as CommunityInvite[]),
          ),
      cachedPeople !== null
        ? Promise.resolve(cachedPeople)
        : getOrFetchSlice(sidebarKeys.people, viewer, () =>
            fetchCommunityPeople(viewer).catch(() => [] as CommunityPerson[]),
          ),
    ])

    if (!mounted.current) return

    setRequests(rq)
    setInvites(iv)
    setPeople(pp)

    const [lv, cal] = await Promise.all([
      cachedLive !== null
        ? Promise.resolve(cachedLive)
        : getOrFetchSlice(sidebarKeys.live, viewer, () =>
            fetchCommunityLive(viewer).catch(() => [] as CommunityLive[]),
          ),
      cachedCalendar !== null
        ? Promise.resolve(cachedCalendar)
        : getOrFetchSlice(sidebarKeys.calendar, viewer, () =>
            fetchCommunityCalendar(viewer).catch(() => [] as CommunityCalendar[]),
          ),
    ])

    if (!mounted.current) return

    setLive(lv)
    setCalendar(cal)
    setSidebarsLoading(false)
  }, [viewer, sidebarKeys])

  useEffect(() => {
    if (!viewer) return

    const timer = window.setTimeout(() => {
      void loadSidebars()
    }, 350)

    return () => window.clearTimeout(timer)
  }, [viewer, loadSidebars, refreshTick])

  // ---- can host ----
  useEffect(() => {
    if (!viewer || !canHostKey) {
      setCanHost(false)
      return
    }

    const cached = getCachedSlice<boolean>(canHostKey, viewer)
    if (cached !== null) {
      setCanHost(cached)
      return
    }

    let alive = true

    const timer = window.setTimeout(() => {
      fetchCanHostCalls(viewer)
        .then(ok => {
          if (!alive || !mounted.current) return

          setCanHost(ok)
          setCachedSlice(canHostKey, viewer, ok)
        })
        .catch(() => {
          if (alive && mounted.current) setCanHost(false)
        })
    }, 550)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [viewer, canHostKey, refreshTick])

  // ---- your groups ----
  useEffect(() => {
    if (!viewer) {
      setMyGroups([])
      return
    }

    const cached = readMyGroupsCache(viewer)

    if (cached) {
      setMyGroups(cached.groups)

      // If cache is recently fresh, do not refetch on simple tab switch.
      if (Date.now() - cached.ts < MY_GROUPS_SOFT_TTL) {
        return
      }
    }

    let alive = true
    const delay = cached ? 1200 : 250

    const timer = window.setTimeout(() => {
      fetchConversations(viewer, false)
        .then(rows => {
          if (!alive || !mounted.current) return

          const groups = rows.filter(c => c.kind === 'group')
          setMyGroups(groups)
          writeMyGroupsCache(viewer, groups)
        })
        .catch(() => {
          if (alive && mounted.current && !cached) {
            setMyGroups([])
          }
        })
    }, delay)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [viewer, refreshTick])

  // ---- group notification refresh ----
  useEffect(() => {
    if (!viewer) return

    const onNotif = (event: Event) => {
      const n = (event as CustomEvent<AppNotification>).detail
      if (!n || n.category !== 'groups') return

      invalidateViewerSlices(viewer)
      clearMyGroupsCache(viewer)
      setRefreshTick(t => t + 1)

      const joined = n.type === 'group_request_approved' || n.type === 'group_invite'
      const gid = typeof n.source_id === 'number' ? n.source_id : null

      if (joined && gid != null) {
        setRecentlyJoinedId(gid)

        if (joinTimerRef.current != null) {
          window.clearTimeout(joinTimerRef.current)
        }

        joinTimerRef.current = window.setTimeout(() => {
          joinTimerRef.current = null
          setRecentlyJoinedId(null)
        }, 6000)
      }
    }

    window.addEventListener('space:notification', onNotif as EventListener)

    return () => {
      window.removeEventListener('space:notification', onNotif as EventListener)
    }
  }, [viewer])

  useEffect(() => {
    return () => {
      if (joinTimerRef.current != null) {
        window.clearTimeout(joinTimerRef.current)
      }
    }
  }, [])

  // ---- actions ----
  const onJoinRequest = useCallback(
    async (g: CommunityGroup) => {
      if (!viewer) return

      setBusyId(g.id)

      try {
        if (g.request_status === 'pending') {
          const d = await cancelGroupJoinRequest(viewer, g.id)

          if (!d.error) {
            const next = discover.map(x =>
              x.id === g.id ? { ...x, request_status: 'none' } : x,
            )

            setDiscover(next)
            setCachedSlice(discoverKey, viewer, next)
          }

          return
        }

        const d = await joinOrRequestGroup(viewer, g.id)

        if (d.status === 'joined') {
          const next = discover.filter(x => x.id !== g.id)
          setDiscover(next)
          setCachedSlice(discoverKey, viewer, next)

          invalidateViewerSlices(viewer)
          clearMyGroupsCache(viewer)
          setRefreshTick(t => t + 1)

          openGroupChat(g.id)
          return
        }

        const next = discover.map(x =>
          x.id === g.id ? { ...x, request_status: 'pending' } : x,
        )

        setDiscover(next)
        setCachedSlice(discoverKey, viewer, next)
      } finally {
        setBusyId(null)
      }
    },
    [discover, discoverKey, openGroupChat, viewer],
  )

  const onApprove = useCallback(
    async (r: CommunityRequest) => {
      if (!viewer) return

      setBusyId(r.id)

      try {
        const d = await approveGroupJoinRequest(viewer, r.group_id, r.id)

        if (!d.error) {
          const nextRequests = requests.filter(x => x.id !== r.id)
          const nextDiscover = discover.filter(x => x.id !== r.group_id)

          setRequests(nextRequests)
          setDiscover(nextDiscover)

          setCachedSlice(sidebarKeys.requests, viewer, nextRequests)
          setCachedSlice(discoverKey, viewer, nextDiscover)

          invalidateViewerSlices(viewer)
          clearMyGroupsCache(viewer)
          setRefreshTick(t => t + 1)
        }
      } finally {
        setBusyId(null)
      }
    },
    [discover, discoverKey, requests, sidebarKeys.requests, viewer],
  )

  const onDecline = useCallback(
    async (r: CommunityRequest) => {
      if (!viewer) return

      setBusyId(r.id)

      try {
        const d = await rejectGroupJoinRequest(viewer, r.group_id, r.id)

        if (!d.error) {
          const next = requests.filter(x => x.id !== r.id)
          setRequests(next)
          setCachedSlice(sidebarKeys.requests, viewer, next)
        }
      } finally {
        setBusyId(null)
      }
    },
    [requests, sidebarKeys.requests, viewer],
  )

  const onInvite = useCallback(
    async (iv: CommunityInvite, accept: boolean) => {
      if (!viewer) return

      void markNotificationRead(viewer, iv.notification_id)

      const next = invites.filter(x => x.notification_id !== iv.notification_id)
      setInvites(next)
      setCachedSlice(sidebarKeys.invites, viewer, next)

      if (accept) {
        openGroupChat(iv.conversation_id)
      }
    },
    [invites, openGroupChat, sidebarKeys.invites, viewer],
  )

  const onFollow = useCallback(
    async (username: string) => {
      if (!viewer) return

      setFollowed(prev => ({ ...prev, [username]: !prev[username] }))

      try {
        await fetch(`${API}/follow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewer, target: username }),
        })
      } catch {
        setFollowed(prev => ({ ...prev, [username]: !prev[username] }))
      }
    },
    [viewer],
  )

  const onToggleCallInterest = useCallback(
    async (c: CommunityCall) => {
      if (!viewer) return

      const nextInterested = !c.interested_by_viewer

      setBusyId(c.id)

      const optimisticCalls = calls.map(x =>
        x.id === c.id
          ? {
              ...x,
              interested_by_viewer: nextInterested,
              interest_count: Math.max(0, x.interest_count + (nextInterested ? 1 : -1)),
            }
          : x,
      )

      setCalls(optimisticCalls)

      try {
        const d = await toggleCommunityCallInterest(viewer, c.id)

        if (d.error) {
          const reverted = calls.map(x =>
            x.id === c.id
              ? {
                  ...x,
                  interested_by_viewer: !nextInterested,
                  interest_count: Math.max(0, x.interest_count + (nextInterested ? -1 : 1)),
                }
              : x,
          )

          setCalls(reverted)
          setCachedSlice(callsKey, viewer, reverted)
        } else if (typeof d.count === 'number') {
          const confirmed = calls.map(x =>
            x.id === c.id ? { ...x, interest_count: d.count! } : x,
          )

          setCalls(confirmed)
          setCachedSlice(callsKey, viewer, confirmed)
        }
      } finally {
        setBusyId(null)
      }
    },
    [calls, callsKey, viewer],
  )

  const openComposer = useCallback((call?: CommunityCall | null) => {
    setComposerInitial(call ?? null)
    setComposerOpen(true)
  }, [])

  const handleCallSaved = useCallback(
    (call: CommunityCall) => {
      setCalls(prev => {
        const i = prev.findIndex(x => x.id === call.id)

        if (i >= 0) {
          const cp = [...prev]
          cp[i] = call
          setCachedSlice(callsKey, viewer, cp)
          return cp
        }

        const cp = [call, ...prev]
        setCachedSlice(callsKey, viewer, cp)
        return cp
      })

      setComposerOpen(false)
      setComposerInitial(null)
    },
    [callsKey, viewer],
  )

  const sceneCount = useMemo(() => {
    const m: Record<string, number> = {}

    for (const s of taxonomy.scenes) {
      m[s.name] = s.count
    }

    return m
  }, [taxonomy])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!bootstrapped) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <CommunitySkeleton />
      </main>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />

      <div className={styles.shell}>
        <header className={styles.hero}>
          <div className={styles.heroText}>
            <h1 className={styles.heroTitle}>Community</h1>
            <p className={styles.heroSub}>
              Rooms, groups and collectors gathered around the work. Join a circle,
              open a critique, or start your own.
            </p>
          </div>

          <div className={styles.heroActions}>
            <div className={styles.searchWrap}>
              <Search size={15} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search groups, scenes, people…"
                aria-label="Search community"
              />
            </div>

            <button
              className={styles.startBtn}
              onClick={() => navigate('/messenger', { state: { openCreateGroup: true } })}
            >
              <Plus size={15} />
              <span>Start a group</span>
            </button>
          </div>
        </header>

        <div className={styles.grid}>
          <div className={styles.main}>
            {/* YOUR GROUPS */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <span className={styles.secLabel}>
                  Your groups{myGroups.length > 0 ? ` · ${myGroups.length}` : ''}
                </span>

                <button className={styles.secLink} onClick={() => navigate('/messenger')}>
                  Manage
                </button>
              </div>

              {myGroups.length === 0 ? (
                <p className={styles.emptyInline}>
                  You’re not in any groups yet. Discover one below.
                </p>
              ) : (
                <div className={styles.filmstrip}>
                  {myGroups.map(g => {
                    const cat = [g.category, g.scene].filter(Boolean).join(' · ')

                    return (
                      <button
                        key={g.id}
                        className={styles.myGroupCard}
                        onClick={() => openGroupChat(g.id)}
                      >
                        <span className={styles.myGroupTop}>
                          <Thumb
                            tone={toneFor(g.id)}
                            image={g.image_url}
                            className={styles.myGroupAvatar}
                          />

                          <span className={styles.myGroupMid}>
                            <span className={styles.myGroupName}>{g.name || 'Group'}</span>
                            {cat && <span className={styles.myGroupCat}>{cat}</span>}
                          </span>
                        </span>

                        <span className={styles.myGroupPreview}>
                          {previewFromConv(g, viewer)}
                        </span>

                        {(g.unread || 0) > 0 && (
                          <span className={styles.myGroupBadge}>{g.unread}</span>
                        )}

                        {recentlyJoinedId === g.id && (
                          <span className={styles.myGroupNew}>New</span>
                        )}
                      </button>
                    )
                  })}

                  <button
                    className={styles.newGroupTile}
                    onClick={() => navigate('/messenger', { state: { openCreateGroup: true } })}
                  >
                    <span className={styles.newGroupIcon}>
                      <Plus size={15} />
                    </span>
                    <span className={styles.newGroupLabel}>New group</span>
                  </button>
                </div>
              )}
            </section>

            {/* DISCOVER */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <span className={styles.secLabel}>Discover groups</span>

                <button
                  className={styles.secLink}
                  onClick={() => {
                    setCategory(null)
                    setScene(null)
                    setSearch('')
                  }}
                >
                  Reset filters
                </button>
              </div>

              <div className={styles.chipRow}>
                <button
                  className={`${styles.chip} ${category === null ? styles.chipOn : ''}`}
                  onClick={() => setCategory(null)}
                >
                  All
                </button>

                {taxonomy.categories.map(c => (
                  <button
                    key={c}
                    className={`${styles.chip} ${category === c ? styles.chipOn : ''}`}
                    onClick={() => setCategory(prev => (prev === c ? null : c))}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {discoverError ? (
                <SectionRetry
                  message={discoverError}
                  onRetry={retryDiscover}
                  retrying={discoverRetrying}
                />
              ) : discoverLoading ? (
                <div className={styles.skelCards}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={styles.skelCard} style={{ height: 220 }} />
                  ))}
                </div>
              ) : discover.length === 0 ? (
                <p className={styles.emptyInline}>
                  No discoverable groups match yet. Owners can open a group’s info to set its
                  category and scene.
                </p>
              ) : (
                <div className={styles.discoverGrid}>
                  {discover.map(g => {
                    const busy = busyId === g.id
                    const pending = g.request_status === 'pending'
                    const isInvite = g.join_mode === 'invite' || g.join_mode === 'private'

                    return (
                      <article key={g.id} className={styles.discoverCard}>
                        <Thumb
                          tone={toneFor(g.id)}
                          image={g.image_url}
                          className={styles.discoverImage}
                        >
                          <span
                            className={`${styles.modeBadge} ${
                              g.join_mode === 'open' ? styles.modePublic : styles.modeLock
                            }`}
                          >
                            {g.join_mode === 'open' ? (
                              <span className={styles.modeDot} />
                            ) : (
                              <Lock size={10} />
                            )}

                            {g.join_mode === 'open'
                              ? 'Public'
                              : g.join_mode === 'request'
                                ? 'Request'
                                : 'Invite only'}
                          </span>

                          {g.category && <span className={styles.catTag}>{g.category}</span>}
                        </Thumb>

                        <div className={styles.discoverBody}>
                          <h3 className={styles.discoverName}>{g.name || 'Untitled group'}</h3>
                          <p className={styles.discoverDesc}>
                            {g.description || 'No description.'}
                          </p>

                          {g.tags && g.tags.length > 0 && (
                            <div className={styles.tagRow}>
                              {g.tags.slice(0, 4).map(t => (
                                <span key={t} className={styles.tagPill}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}

                          <div className={styles.discoverMeta}>
                            <span className={styles.initials}>
                              {(g.initials || []).map((ini, i) => (
                                <span key={i} className={styles.initialDot}>
                                  {ini}
                                </span>
                              ))}
                            </span>

                            <span className={styles.metaText}>{g.member_count} members</span>
                          </div>
                        </div>

                        <div className={styles.discoverFoot}>
                          <span className={styles.activeLine}>
                            <span className={styles.activeDot} />
                            {g.updated_at ? `Active ${fromNow(g.updated_at)}` : 'New'}
                          </span>

                          {isInvite ? (
                            <span className={styles.inviteTag}>Invite only</span>
                          ) : pending ? (
                            <button
                              className={`${styles.actBtn} ${styles.actRequested}`}
                              onClick={() => void onJoinRequest(g)}
                              disabled={busy}
                            >
                              Cancel request
                            </button>
                          ) : g.join_mode === 'open' ? (
                            <button
                              className={`${styles.actBtn} ${styles.actJoin}`}
                              onClick={() => void onJoinRequest(g)}
                              disabled={busy}
                            >
                              Join
                            </button>
                          ) : (
                            <button
                              className={`${styles.actBtn} ${styles.actRequest}`}
                              onClick={() => void onJoinRequest(g)}
                              disabled={busy}
                            >
                              Request
                            </button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>

            {/* OPEN CALLS */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <span className={styles.secLabel}>
                  Open calls{calls.length > 0 ? ` · ${calls.length}` : ''}
                </span>

                {canHost && (
                  <button className={styles.postCallBtn} onClick={() => openComposer(null)}>
                    <Plus size={13} /> Post an opportunity
                  </button>
                )}
              </div>

              {callsError ? (
                <SectionRetry
                  message={callsError}
                  onRetry={retryCalls}
                  retrying={callsRetrying}
                />
              ) : callsLoading ? (
                <div className={styles.skelCards}>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className={styles.skelCard} style={{ height: 120 }} />
                  ))}
                </div>
              ) : calls.length === 0 ? (
                <p className={styles.emptyInline}>
                  No open calls right now. Accredited houses and curators post opportunities here.
                </p>
              ) : (
                <div className={styles.callGrid}>
                  {calls.map(c => {
                    const dp = callDateParts(c)
                    const ul = untilLabel(c.deadline_at, c.status)
                    const closed = c.status !== 'open'
                    const elig = eligSummary(c.eligibility)

                    const subBits = [c.host_display || c.host_user_name || 'House']
                    if (c.online) subBits.push('Online')
                    else if (c.location) subBits.push(c.location)

                    return (
                      <article
                        key={c.id}
                        className={`${styles.callCard} ${closed ? styles.callCardClosed : ''}`}
                        onClick={() => navigate(`/calls/${c.id}`)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            navigate(`/calls/${c.id}`)
                          }
                        }}
                      >
                        <div className={`${styles.callDate} ${dp.code ? styles.callDateCode : ''}`}>
                          <strong>{dp.top}</strong>
                          {dp.bottom && <span>{dp.bottom}</span>}
                        </div>

                        <div className={styles.callBody}>
                          <span className={styles.callType}>
                            {kindLabel(c.kind)}
                            {c.scene ? ` · ${c.scene}` : ''}
                          </span>

                          <h4 className={styles.callTitle}>{c.title}</h4>
                          <p className={styles.callSub}>{subBits.join(' · ')}</p>

                          {c.description && <p className={styles.callDesc}>{c.description}</p>}
                          {elig && <p className={styles.callElig}>{elig}</p>}

                          {ul.text && (
                            <span
                              className={`${styles.callDeadline} ${
                                ul.tone === 'soon' ? styles.callDeadlineSoon : ''
                              } ${ul.tone === 'closed' ? styles.callDeadlineClosed : ''}`}
                            >
                              {ul.text}
                            </span>
                          )}

                          <div className={styles.callActions} onClick={e => e.stopPropagation()}>
                            <button
                              className={`${styles.callSaveBtn} ${
                                c.interested_by_viewer ? styles.callSaveBtnOn : ''
                              }`}
                              onClick={() => void onToggleCallInterest(c)}
                              disabled={busyId === c.id}
                            >
                              {c.interested_by_viewer ? 'Saved' : 'Save'}
                              {c.interest_count > 0 ? ` · ${c.interest_count}` : ''}
                            </button>

                            {closed ? (
                              <span className={styles.callClosedTag}>Closed</span>
                            ) : c.apply_url ? (
                              <a
                                className={styles.callApplyBtn}
                                href={c.apply_url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Apply
                              </a>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>

            {/* AUCTION CALENDAR */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <span className={styles.secLabel}>Auction calendar</span>

                <button className={styles.secLink} onClick={() => navigate('/auctions')}>
                  Full floor
                </button>
              </div>

              {sidebarsLoading && calendar.length === 0 ? (
                <p className={styles.emptyInline}>Checking the calendar…</p>
              ) : calendar.length === 0 ? (
                <p className={styles.emptyInline}>No upcoming sales on the calendar yet.</p>
              ) : (
                <div className={styles.callGrid}>
                  {calendar.map(c => {
                    const dm = dayMonth(c.ends_at)

                    return (
                      <article
                        key={c.id}
                        className={styles.callCard}
                        onClick={() => navigate(`/sales/${c.id}`)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className={styles.callDate}>
                          <strong>{dm.day}</strong>
                          <span>{dm.month}</span>
                        </div>

                        <div className={styles.callBody}>
                          <span className={styles.callType}>
                            {c.status === 'live' ? 'Live now' : 'Upcoming sale'}
                          </span>

                          <h4 className={styles.callTitle}>{c.title}</h4>

                          <p className={styles.callSub}>
                            {c.host_display || c.host_username || 'House'} · {c.lot_count} lots
                          </p>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>

            {/* SCENES */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <span className={styles.secLabel}>Scenes</span>
              </div>

              {taxonomy.scenes.length === 0 ? (
                <p className={styles.emptyInline}>
                  No scenes tagged yet. Set a group’s scene from its info panel to see it here.
                </p>
              ) : (
                <div className={styles.sceneRow}>
                  {taxonomy.scenes.map(s => (
                    <button
                      key={s.name}
                      className={`${styles.sceneChip} ${scene === s.name ? styles.sceneChipOn : ''}`}
                      onClick={() => setScene(prev => (prev === s.name ? null : s.name))}
                    >
                      <span>{s.name}</span>
                      <em>{(sceneCount[s.name] ?? s.count).toLocaleString()}</em>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* RIGHT RAIL */}
          <aside className={styles.rail}>
            {/* LIVE NOW */}
            <div className={styles.railCard}>
              <div className={styles.railHead}>
                <span className={styles.secLabel}>Live now</span>

                {live.length > 0 && (
                  <span className={styles.liveCount}>
                    <span className={styles.liveDot} /> {live.length}
                  </span>
                )}
              </div>

              {sidebarsLoading && live.length === 0 ? (
                <p className={styles.emptyInline}>Checking the floor…</p>
              ) : live.length === 0 ? (
                <p className={styles.emptyInline}>No rooms on the block right now.</p>
              ) : (
                <div className={styles.liveList}>
                  {live.map(l => (
                    <button
                      key={l.id}
                      className={styles.liveRow}
                      onClick={() => navigate(`/sales/${l.id}`)}
                    >
                      <Thumb tone={toneFor(l.id)} className={styles.liveThumb}>
                        <span className={styles.liveBadge}>LOT</span>
                      </Thumb>

                      <span className={styles.liveMid}>
                        <strong>{l.title}</strong>
                        <span>
                          {l.host_display || l.host_username || 'House'} · {l.lots_on_block} on block
                          {l.top_amount ? ` · top ₦${l.top_amount}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* REQUESTS & INVITES */}
            <div className={styles.railCard}>
              <div className={styles.railHead}>
                <span className={styles.secLabel}>Requests &amp; invites</span>
                <span className={styles.railCount}>{requests.length + invites.length}</span>
              </div>

              {sidebarsLoading && requests.length + invites.length === 0 ? (
                <p className={styles.emptyInline}>Loading requests…</p>
              ) : requests.length + invites.length === 0 ? (
                <p className={styles.emptyInline}>Nothing waiting.</p>
              ) : (
                <div className={styles.reqList}>
                  {requests.map(r => (
                    <div key={`rq-${r.id}`} className={styles.reqItem}>
                      <Thumb
                        tone={toneFor(r.id)}
                        image={r.avatar_url}
                        className={styles.reqAvatar}
                      >
                        {!r.avatar_url && (
                          <span>{(r.display_name || r.user_name || '?')[0]?.toUpperCase()}</span>
                        )}
                      </Thumb>

                      <p className={styles.reqText}>
                        <strong>{r.display_name || r.user_name}</strong> asked to join{' '}
                        <strong>{r.group_name || 'a group'}</strong>
                      </p>

                      <div className={styles.reqActions}>
                        <button
                          className={`${styles.reqBtn} ${styles.reqApprove}`}
                          onClick={() => void onApprove(r)}
                          disabled={busyId === r.id}
                        >
                          Approve
                        </button>

                        <button
                          className={`${styles.reqBtn} ${styles.reqDecline}`}
                          onClick={() => void onDecline(r)}
                          disabled={busyId === r.id}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}

                  {invites.map(iv => (
                    <div key={`iv-${iv.notification_id}`} className={styles.reqItem}>
                      <Thumb
                        tone={toneFor(iv.conversation_id)}
                        className={styles.reqAvatar}
                      >
                        <span>{(iv.group_name || 'G')[0]?.toUpperCase()}</span>
                      </Thumb>

                      <p className={styles.reqText}>
                        <strong>{iv.actor_display || 'A member'}</strong> added you to{' '}
                        <strong>{iv.group_name || 'a group'}</strong>
                      </p>

                      <div className={styles.reqActions}>
                        <button
                          className={`${styles.reqBtn} ${styles.reqAccept}`}
                          onClick={() => void onInvite(iv, true)}
                        >
                          Open
                        </button>

                        <button
                          className={`${styles.reqBtn} ${styles.reqLater}`}
                          onClick={() => void onInvite(iv, false)}
                        >
                          Later
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* AROUND THE WORK */}
            <div className={styles.railCard}>
              <div className={styles.railHead}>
                <span className={styles.secLabel}>Around the work</span>
              </div>

              {sidebarsLoading && people.length === 0 ? (
                <p className={styles.emptyInline}>Loading suggestions…</p>
              ) : people.length === 0 ? (
                <p className={styles.emptyInline}>No suggestions yet.</p>
              ) : (
                <div className={styles.peopleList}>
                  {people.map(p => (
                    <div key={p.username} className={styles.personRow}>
                      <Thumb
                        tone={toneFor(p.username.length)}
                        image={p.avatar_url}
                        className={styles.personAvatar}
                      >
                        {!p.avatar_url && (
                          <span>{(p.display_name || p.username || '?')[0]?.toUpperCase()}</span>
                        )}
                      </Thumb>

                      <button
                        className={styles.personMid}
                        onClick={() => navigate(`/profile/${p.username}`)}
                      >
                        <strong>{p.display_name || p.username}</strong>
                        <span>{p.reason}</span>
                      </button>

                      <button
                        className={`${styles.followBtn} ${
                          followed[p.username] ? styles.followBtnOn : ''
                        }`}
                        onClick={() => void onFollow(p.username)}
                      >
                        {followed[p.username] ? 'Following' : 'Follow'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* HOUSE RULES */}
            <div className={styles.railCard}>
              <div className={styles.railHead}>
                <span className={styles.secLabel}>House rules</span>
              </div>

              <ol className={styles.rulesList}>
                <li className={styles.ruleItem}>
                  <span className={styles.ruleNum}>01</span>
                  <span className={styles.ruleText}>
                    <strong>Critique the work, not the person.</strong> Say what you see, then what you’d try.
                  </span>
                </li>

                <li className={styles.ruleItem}>
                  <span className={styles.ruleNum}>02</span>
                  <span className={styles.ruleText}>
                    <strong>No off-platform sales.</strong> Deals in a group are deals outside the ledger — and outside protection.
                  </span>
                </li>

                <li className={styles.ruleItem}>
                  <span className={styles.ruleNum}>03</span>
                  <span className={styles.ruleText}>
                    <strong>Credit the hand.</strong> Post only work you made or own, and say which.
                  </span>
                </li>

                <li className={styles.ruleItem}>
                  <span className={styles.ruleNum}>04</span>
                  <span className={styles.ruleText}>
                    <strong>Houses disclose.</strong> Condition, provenance, and commission, before the hammer.
                  </span>
                </li>
              </ol>
            </div>
          </aside>
        </div>
      </div>

      <CallComposerModal
        open={composerOpen}
        viewer={viewer}
        initial={composerInitial}
        onClose={() => {
          setComposerOpen(false)
          setComposerInitial(null)
        }}
        onSaved={handleCallSaved}
      />
    </main>
  )
}