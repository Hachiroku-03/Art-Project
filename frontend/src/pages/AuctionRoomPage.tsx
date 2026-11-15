import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Eye,
  Gavel,
  Loader2,
  Lock,
  Play,
  Radio,
  RotateCcw,
  SkipForward,
  Square,
  Trophy,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { AuctionHeader } from '../components/auctions/AuctionHeader'
import { TicketGate } from '../components/auctions/TicketGate'
import { BidPanel } from '../components/auctions/BidPanel'
import {
  endSale,
  fetchLotBids,
  fetchSale,
  formatMoney,
  goLive,
  hammerLot,
  passLot,
  reopenLot,
  revealNext,
  type Lot,
  type LotBid,
  type Sale,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import styles from './AuctionRoomPage.module.css'

type HostActionKey = 'live' | 'reveal' | 'hammer' | 'pass' | 'end' | 'reopen'

// A rail row is a real LotBid, optionally an optimistic (not-yet-committed) echo
// tagged with a negative temp id and the time it was placed, so the sweeper can
// drop it if the backend never confirms it.
type LedgerRow = LotBid & { __temp?: boolean; __at?: number }

// Hard ceilings for in-flight GET requests. The Neon pool can hold a queued
// query up to query_wait_timeout (default 120s); we refuse to let a single
// poll hang that long. If a GET outlives its timeout, we abort it, the guard
// resets in the finally block, and the next tick retries with a fresh socket.
// This is the fix for "host rail frozen until refresh": without a timeout, a
// single hung fetchLotBids permanently pins pollBusy=true and every subsequent
// 1000ms tick is skipped. Same for fetchSale pinning saleInFlightRef.
const SALE_POLL_TIMEOUT_MS = 8000
const BID_POLL_TIMEOUT_MS = 5000

function pad(n: number) {
  return n.toString().padStart(2, '0')
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null

  const raw = String(value).trim()
  if (!raw) return null

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const time = new Date(normalized).getTime()

  return Number.isFinite(time) ? time : null
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * YouTube embed handling.
 *
 * Do NOT scrape https://youtu.be — it is just YouTube's normal watch/share page.
 * Only ever iframe a real https://www.youtube.com/embed/<VIDEO_ID> URL.
 *
 * A bare /embed with no id, or a private / embedding-disabled video, can show
 * YouTube's own error frame:
 *
 *   "An error occurred. Unable to execute JavaScript."
 *   "出现错误。无法执行 JavaScript。"
 *
 * That is YouTube refusing the frame, not your app crashing.
 * The external fallback link covers that case.
 */
function normalizeHost(host: string) {
  return host.replace(/^www\./, '').replace(/^m\./, '').toLowerCase()
}

function stripTrailingSlash(path: string) {
  return path.replace(/\/+$/, '')
}

function buildYouTubeEmbed(videoId: string, nocookie = false) {
  const base = nocookie
    ? 'https://www.youtube-nocookie.com/embed'
    : 'https://www.youtube.com/embed'

  const params = new URLSearchParams({
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
  })

  return `${base}/${videoId}?${params.toString()}`
}

function buildYouTubeChannelLiveEmbed(channelId: string, nocookie = false) {
  const base = nocookie
    ? 'https://www.youtube-nocookie.com/embed'
    : 'https://www.youtube.com/embed'

  const params = new URLSearchParams({
    channel: channelId,
    rel: '0',
    modestbranding: '1',
  })

  return `${base}/live_stream?${params.toString()}`
}

function toEmbedUrl(raw?: string | null): string {
  const value = (raw || '').trim()
  if (!value) return ''

  let u: URL

  try {
    u = new URL(value.startsWith('http') ? value : `https://${value}`)
  } catch {
    return ''
  }

  if (!/^https?:$/.test(u.protocol)) return ''

  const host = normalizeHost(u.hostname)
  const path = stripTrailingSlash(u.pathname)
  const nocookie = host === 'youtube-nocookie.com'
  const isYouTubeHost = host === 'youtube.com' || host === 'youtu.be' || nocookie

  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0]
    if (id) return buildYouTubeEmbed(id, nocookie)
    return ''
  }

  if (host === 'youtube.com' || nocookie) {
    if (path === '/watch') {
      const id = u.searchParams.get('v')
      if (id) return buildYouTubeEmbed(id, nocookie)
    }

    const idMatch = path.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)
    if (idMatch?.[1]) {
      return buildYouTubeEmbed(idMatch[1], nocookie)
    }

    if (path === '/embed/live_stream') {
      const channel = u.searchParams.get('channel')
      if (channel) return buildYouTubeChannelLiveEmbed(channel, nocookie)
    }

    const ch = path.match(/^\/channel\/([\w-]+)/)
    if (ch?.[1]) return buildYouTubeChannelLiveEmbed(ch[1], nocookie)

    if (/^\/(?:@|c\/|user\/)/.test(path)) return ''
  }

  if (isYouTubeHost) return ''

  if (/^https?:\/\//.test(value)) return value

  return ''
}

function toExternalStreamUrl(raw?: string | null): string {
  const value = (raw || '').trim()
  if (!value) return ''

  let u: URL

  try {
    u = new URL(value.startsWith('http') ? value : `https://${value}`)
  } catch {
    return ''
  }

  const host = normalizeHost(u.hostname)
  const path = stripTrailingSlash(u.pathname)

  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0]
    if (id) return `https://www.youtube.com/watch?v=${id}`
    return value
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (path === '/watch') return value

    const idMatch = path.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)
    if (idMatch?.[1]) {
      const kind = path.split('/')[1]

      if (kind === 'shorts') return `https://www.youtube.com/shorts/${idMatch[1]}`
      if (kind === 'live') return `https://www.youtube.com/live/${idMatch[1]}`
      return `https://www.youtube.com/watch?v=${idMatch[1]}`
    }

    if (path === '/embed/live_stream') {
      const channel = u.searchParams.get('channel')
      if (channel) return `https://www.youtube.com/channel/${channel}/live`
    }
  }

  return value
}

export function AuctionRoomPage() {
  const { id } = useParams<{ id: string }>()
  const saleId = Number(id)
  const navigate = useNavigate()
  const viewer = getViewer() || localStorage.getItem('space_user') || ''

  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [bids, setBids] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [startCountdown, setStartCountdown] = useState('')
  const [endCountdown, setEndCountdown] = useState('')

  const [actionBusy, setActionBusy] = useState<HostActionKey | ''>('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')

  const lastBidId = useRef(0)
  const tempSeqRef = useRef(0)

  // In-flight guard for the sale poll. Without a timeout, a single hung
  // fetchSale permanently pins this to true and every subsequent 2500ms tick
  // is skipped — the host's lots/current_bid freeze until a refresh remounts
  // the component. The AbortController + SALE_POLL_TIMEOUT_MS below converts
  // that permanent freeze into a retryable 8s blip.
  const saleInFlightRef = useRef(false)

  const currency = sale?.currency || 'NGN'

  const activeLot = useMemo(
    () => lots.find(l => l.status === 'on_block') ?? null,
    [lots],
  )

  const sealedCount = useMemo(
    () => lots.filter(l => l.status === 'sealed').length,
    [lots],
  )

  const soldCount = useMemo(
    () => lots.filter(l => l.status === 'sold').length,
    [lots],
  )

  const passedCount = useMemo(
    () => lots.filter(l => l.status === 'passed').length,
    [lots],
  )

  const lastPassedLot = useMemo(() => {
    return lots.reduce<Lot | null>((latest, lot) => {
      if (lot.status !== 'passed') return latest
      if (!latest) return lot

      const latestTime = String(latest.hammer_at || '')
      const currentTime = String(lot.hammer_at || '')

      if (currentTime > latestTime) return lot
      if (currentTime === latestTime && lot.position > latest.position) return lot

      return latest
    }, null)
  }, [lots])

  const stream = useMemo(() => {
    const embed = toEmbedUrl(sale?.stream_url)
    const external = toExternalStreamUrl(sale?.stream_url)

    const isYouTube =
      !!embed &&
      (/youtube\.com\/embed\//.test(embed) ||
        /youtube-nocookie\.com\/embed\//.test(embed))

    return { embed, external, isYouTube }
  }, [sale?.stream_url])

  const canGoLive = Boolean(sale?.is_host && sale?.status === 'upcoming')

  const canReveal = Boolean(
    sale?.is_host && sale?.status === 'live' && !activeLot && sealedCount > 0,
  )

  const canHammer = Boolean(sale?.is_host && sale?.status === 'live' && activeLot)
  const canPass = canHammer

  const canEnd = Boolean(sale?.is_host && sale?.status === 'live' && !activeLot)

  const canReopenLast = Boolean(
    sale?.is_host && sale?.status === 'live' && !activeLot && lastPassedLot,
  )

  const wonLots = useMemo(
    () => (viewer ? lots.filter(l => l.winner_username === viewer).length : 0),
    [lots, viewer],
  )

  // -----------------------------------------------------------------------
  // loadSale — guarded, one at a time, with a hard timeout.
  //
  // THE HOST-FREEZE FIX: the old version had saleInFlightRef but NO timeout
  // on fetchSale. If the Neon pool starves (query_wait_timeout, "Remaining
  // connection slots are reserved…"), fetchSale hangs indefinitely,
  // saleInFlightRef stays true forever, every 2500ms tick is skipped, lots
  // never update, current_bid freezes, and the host must refresh.
  //
  // Now: AbortController + SALE_POLL_TIMEOUT_MS (8s). If the request outlives
  // 8s it is aborted, the finally block resets the guard, and the next tick
  // retries with a fresh socket. The keep-prev guard (rows.length ? rows : prev)
  // ensures a failed/aborted poll never blanks the board.
  // -----------------------------------------------------------------------
  const loadSale = useCallback(async () => {
    if (!Number.isFinite(saleId)) {
      setError('Invalid sale id.')
      setLoading(false)
      return
    }

    if (saleInFlightRef.current) return
    saleInFlightRef.current = true

    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), SALE_POLL_TIMEOUT_MS)

    try {
      const data = await fetchSale(String(saleId), viewer, controller.signal)

      if (data.sale) {
        setSale(data.sale)

        const rows = Array.isArray(data.lots) ? data.lots : []

        // Transient-failure guard: an empty/aborted poll must NOT blank the
        // board. Keep the last good lots so the house strip and activeLot
        // never vanish mid-poll.
        setLots(prev => (rows.length ? rows : prev))

        setError('')
      } else {
        setError(data.error || 'This room is private.')
      }
    } catch {
      // Network/abort: keep whatever we had. Do not blank lots or sale.
      setError(prev => prev || 'network error - is the feed server running?')
    } finally {
      window.clearTimeout(timer)
      saleInFlightRef.current = false
      setLoading(false)
    }
  }, [saleId, viewer])

  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      setLoading(false)
      navigate('/login', { replace: true })
      return
    }

    void loadSale()
  }, [loadSale, navigate])

  // Upcoming start countdown — stops hard at zero.
  useEffect(() => {
    if (!sale || sale.status !== 'upcoming' || !sale.starts_at) {
      setStartCountdown('')
      return
    }

    const target = parseTimestamp(sale.starts_at)
    if (!target) { setStartCountdown(''); return }

    let cancelled = false
    let done = false
    let timer: number | undefined

    const tick = () => {
      if (cancelled) return
      const diff = target - Date.now()
      if (diff <= 0) {
        done = true
        setStartCountdown('00:00:00')
        if (timer) window.clearInterval(timer)
        timer = undefined
        void loadSale()
        return
      }
      setStartCountdown(formatDuration(diff))
    }

    tick()
    if (!done && !cancelled) timer = window.setInterval(tick, 1000)

    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [sale?.status, sale?.starts_at, loadSale])

  // Live end countdown — stops hard at zero.
  useEffect(() => {
    if (!sale || sale.status !== 'live' || !sale.ends_at) {
      setEndCountdown('')
      return
    }

    const target = parseTimestamp(sale.ends_at)
    if (!target) { setEndCountdown(''); return }

    let cancelled = false
    let done = false
    let timer: number | undefined

    const tick = () => {
      if (cancelled) return
      const diff = target - Date.now()
      if (diff <= 0) {
        done = true
        setEndCountdown('00:00:00')
        if (timer) window.clearInterval(timer)
        timer = undefined
        void loadSale()
        return
      }
      setEndCountdown(formatDuration(diff))
    }

    tick()
    if (!done && !cancelled) timer = window.setInterval(tick, 1000)

    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [sale?.status, sale?.ends_at, loadSale])

  // Poll sale status while not ended.
  //
  // 2500ms is a deliberate load/latency trade-off on a SHARED Neon pool.
  // saleInFlightRef + the 8s AbortController inside loadSale guarantee at
  // most ONE poll runs at a time and a hung poll cannot permanently disable
  // the cycle. Do not crank this down.
  useEffect(() => {
    if (!sale || sale.status === 'ended') return

    const timer = window.setInterval(() => {
      void loadSale()
    }, 2500)

    return () => window.clearInterval(timer)
  }, [sale?.status, loadSale])

  /**
   * Single source of truth for the ledger (the rail).
   *
   * THE HOST-FREEZE FIX (the primary bug you reported):
   *
   * The old bid poll had `pollBusy` but NO timeout on fetchLotBids. When the
   * Neon pool starves, a single GET /lots/{id}/bids?since=X hangs for up to
   * query_wait_timeout (120s default). pollBusy stays true for those 120s,
   * every 1000ms tick is skipped, and the host's rail shows ZERO new bids
   * for two minutes. The bidder doesn't notice because their OWN bid appears
   * via optimistic echo (bypasses the poll). The host has no echo — a stuck
   * poll = a completely frozen rail until refresh remounts the component.
   *
   * Now: AbortController + BID_POLL_TIMEOUT_MS (5s) on BOTH the initial fetch
   * and every interval tick. If a GET outlives 5s it is aborted, pollBusy
   * resets in the finally block, and the next 1000ms tick retries with a
   * fresh socket. A 120s freeze becomes a 5s blip.
   *
   * The merge() + sweeper + onBidError logic is unchanged.
   */
  useEffect(() => {
    const lotId = activeLot?.id

    if (!lotId) {
      setBids([])
      lastBidId.current = 0
      return
    }

    let alive = true

    setBids([])
    lastBidId.current = 0

    const merge = (incoming: LotBid[]) => {
      setBids(prev => {
        let next = prev
        let mutated = false

        for (const r of incoming) {
          if (!(r.id > 0)) continue

          const ti = next.findIndex(
            x =>
              x.__temp &&
              x.user_name === r.user_name &&
              Number(x.amount) === Number(r.amount),
          )

          if (ti >= 0) {
            if (!mutated) { next = next.slice(); mutated = true }
            next[ti] = r
            if (r.id > lastBidId.current) lastBidId.current = r.id
            continue
          }

          if (r.id > lastBidId.current && !next.some(x => x.id === r.id)) {
            if (!mutated) { next = next.slice(); mutated = true }
            next = [r, ...next]
            if (r.id > lastBidId.current) lastBidId.current = r.id
          }
        }

        return mutated ? next : prev
      })
    }

    // Initial load: abortable with timeout.
    const initController = new AbortController()
    const initTimer = window.setTimeout(() => initController.abort(), BID_POLL_TIMEOUT_MS)

    fetchLotBids(lotId, 0, initController.signal)
      .then(list => {
        if (!alive) return

        const real = list.filter(b => b.id > 0)

        if (real.length) {
          lastBidId.current = real[real.length - 1].id
        }

        setBids(prev => {
          const temps = prev.filter(x => x.__temp)
          const keepTemps = temps.filter(
            t => !real.some(r => r.user_name === t.user_name && Number(r.amount) === Number(t.amount)),
          )
          return [...keepTemps, ...real.slice().reverse()]
        })
      })
      .catch(() => {
        // initial fetch failed/aborted: rail keeps whatever temps + nothing yet
      })
      .finally(() => {
        window.clearTimeout(initTimer)
      })

    // Delta poll: ONE at a time, with a hard timeout per tick.
    // THE HOST-FREEZE FIX: without the AbortController, a single hung
    // fetchLotBids pins pollBusy=true for up to 120s (query_wait_timeout),
    // freezing the host's rail completely. With the 5s timeout, the abort
    // fires, the finally block resets pollBusy, and the next 1000ms tick
    // retries. Maximum rail freeze: 5s + 1s = 6s, not 120s.
    let pollBusy = false
    let pollController: AbortController | null = null
    let pollTimer: number | undefined

    const timer = window.setInterval(async () => {
      if (!alive || pollBusy) return
      pollBusy = true

      pollController = new AbortController()
      pollTimer = window.setTimeout(
        () => pollController?.abort(),
        BID_POLL_TIMEOUT_MS,
      )

      try {
        const fresh = await fetchLotBids(lotId, lastBidId.current, pollController.signal)
        if (alive && fresh.length) merge(fresh)
      } catch {
        // failed/aborted: skip this tick, lastBidId unchanged, retry next tick
      } finally {
        window.clearTimeout(pollTimer)
        pollController = null
        pollBusy = false
      }
    }, 1000)

    // Phantom sweeper: drop optimistic rows the backend never confirmed.
    const sweeper = window.setInterval(() => {
      const cutoff = Date.now() - 12000

      setBids(prev => {
        const hasStale = prev.some(x => x.__temp && (x.__at || 0) < cutoff)
        if (!hasStale) return prev
        return prev.filter(x => !(x.__temp && (x.__at || 0) < cutoff))
      })
    }, 2000)

    return () => {
      alive = false
      window.clearInterval(timer)
      window.clearInterval(sweeper)
      try { initController.abort() } catch { /* noop */ }
      try { pollController?.abort() } catch { /* noop */ }
      window.clearTimeout(pollTimer)
    }
  }, [activeLot?.id])

  // -----------------------------------------------------------------------
  // handleMyBid — anti-clobber: optimistic temps touch the RAIL only.
  // Real bids (id > 0) bump lot.current_bid legitimately.
  // -----------------------------------------------------------------------
  function handleMyBid(b: LotBid) {
    const name = b.user_name || viewer
    const numericAmount = Number(b.amount)
    if (!name || !Number.isFinite(numericAmount) || numericAmount <= 0) return

    setBids(prev => {
      if (b.id > 0) {
        if (b.id > lastBidId.current) lastBidId.current = b.id

        const cleaned = prev.filter(
          x =>
            x.id !== b.id &&
            !(x.__temp && x.user_name === name && Number(x.amount) === numericAmount),
        )

        return [{ ...b, user_name: name, amount: String(b.amount) }, ...cleaned]
      }

      const temp: LedgerRow = {
        ...b,
        user_name: name,
        amount: String(b.amount),
        id: --tempSeqRef.current,
        __temp: true,
        __at: Date.now(),
      }

      const cleaned = prev.filter(
        x => !(x.__temp && x.user_name === name && Number(x.amount) === numericAmount),
      )

      return [temp, ...cleaned]
    })

    // CRITICAL ANTI-CLOBBER: only bump lot.current_bid for a REAL bid.
    if (b.id > 0) {
      setLots(prev =>
        prev.map(l =>
          l.id === activeLot?.id
            ? { ...l, current_bid: b.amount, bid_count: (l.bid_count || 0) + 1 }
            : l,
        ),
      )
    }
  }

  const dropMyTemp = useCallback(
    (amount: number) => {
      const a = Number(amount)
      if (!Number.isFinite(a)) return

      setBids(prev =>
        prev.filter(
          x => !(x.__temp && x.user_name === viewer && Number(x.amount) === a),
        ),
      )
    },
    [viewer],
  )

  const applyOptimistic = useCallback((key: HostActionKey, res: any) => {
    if (!res || res.error) return

    if (key === 'live') {
      setSale(prev => (prev ? { ...prev, status: 'live' } : prev))
      return
    }

    if (key === 'end') {
      setSale(prev =>
        prev ? { ...prev, status: 'ended', ended_at: new Date().toISOString() } : prev,
      )
      return
    }

    if (key === 'reveal' && res.lot?.id) {
      const revealedId = res.lot.id
      setLots(prev =>
        prev.map(l => (l.id === revealedId ? { ...l, status: 'on_block' as const } : l)),
      )
      return
    }

    if ((key === 'hammer' || key === 'pass') && res.message) {
      setLots(prev =>
        prev.map(l => {
          if (l.status !== 'on_block') return l
          if (res.message === 'sold') {
            return {
              ...l,
              status: 'sold' as const,
              sold_price: res.sold_price ?? l.current_bid,
              winner_username: res.winner ?? l.winner_username,
              payment_status: 'unpaid',
              hammer_at: new Date().toISOString(),
            }
          }
          return { ...l, status: 'passed' as const, hammer_at: new Date().toISOString() }
        }),
      )
      return
    }

    if (key === 'reopen' && (res.lot_id || res.lot?.id)) {
      const reopenedId = Number(res.lot_id ?? res.lot?.id)
      setLots(prev =>
        prev.map(l =>
          l.id === reopenedId
            ? {
                ...l,
                status: 'on_block' as const,
                hammer_at: null,
                sold_price: undefined,
                winner_username: null,
                payment_status: null,
              }
            : l,
        ),
      )
    }
  }, [])

  const runHostAction = useCallback(
    async (
      key: HostActionKey,
      fn: () => Promise<any>,
      success: string | ((res: any) => string),
    ) => {
      if (!viewer || !Number.isFinite(saleId)) return

      setActionBusy(key)
      setActionError('')
      setActionNotice('')

      try {
        const res = await fn()
        if (res?.error) { setActionError(res.error); return }

        applyOptimistic(key, res)
        setActionNotice(typeof success === 'function' ? success(res) : success)
        void loadSale()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Action failed.')
      } finally {
        setActionBusy('')
      }
    },
    [saleId, viewer, loadSale, applyOptimistic],
  )

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <Preloader done={false} />
      </main>
    )
  }

  if (!sale) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.gateCard} style={{ maxWidth: 480, margin: '6rem auto' }}>
          <p className={styles.gateTitle}>
            <Lock size={16} /> {error || 'This room is private.'}
          </p>
          <button className={styles.gateBtn} onClick={() => navigate('/auctions')}>
            Back to the floor
          </button>
        </div>
      </main>
    )
  }

  if (sale.status === 'upcoming') {
    const startReached = startCountdown === '00:00:00'

    return (
      <main className={styles.curtainLayout}>
        <Navbar />
        <div className={styles.curtain}>
          <p className={styles.curtainLabel}>The auction will start in</p>
          <h1 className={styles.curtainTime}>{startCountdown || '—'}</h1>
          <p className={styles.curtainSub}>{sale.title} · @{sale.host_username}</p>

          {startReached ? (
            <p className={styles.startNote}>
              Scheduled start reached. Waiting for the house to open the rostrum.
            </p>
          ) : null}

          {actionError ? <div className={styles.hostError}>{actionError}</div> : null}
          {actionNotice ? <div className={styles.hostNotice}>{actionNotice}</div> : null}

          {sale.is_host ? (
            <div className={styles.hostActionsInline}>
              <button
                className={styles.hostBtn}
                onClick={() =>
                  void runHostAction('live', () => goLive(saleId, viewer), 'Sale is live.')
                }
                disabled={actionBusy !== '' || !canGoLive}
              >
                {actionBusy === 'live' ? <Loader2 size={14} className={styles.spin} /> : <Play size={14} />}
                Go live
              </button>
            </div>
          ) : !sale.has_ticket ? (
            <div className={styles.hostActionsInline}>
              <button className={styles.gateBtn} onClick={() => navigate(`/sales/${saleId}`)}>
                Get a paddle
              </button>
            </div>
          ) : null}
        </div>
      </main>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />

      <div className={styles.room}>
        <div className={styles.topBar}>
          <button className={styles.backBtn} onClick={() => navigate('/auctions')} aria-label="Back to floor">
            <ArrowLeft size={18} />
          </button>
          <span className={styles.watching}>
            <i />
            {sale.status === 'live'
              ? `live${endCountdown ? ` · ends in ${endCountdown}` : ''}`
              : sale.status === 'ended' ? 'archive' : 'upcoming'}
          </span>
        </div>

        <section className={styles.main}>
          <div className={styles.streamBox}>
            {stream.embed ? (
              <div className={styles.streamShell}>
                <iframe
                  key={stream.embed}
                  className={styles.streamFrame}
                  src={stream.embed}
                  title="Live broadcast"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
                {stream.external ? (
                  <a className={styles.streamFallback} href={stream.external} target="_blank" rel="noreferrer">
                    Open stream externally
                  </a>
                ) : null}
              </div>
            ) : (
              <div className={styles.streamPlaceholder}>
                <Radio size={30} />
                <p>The house has not opened the broadcast yet.</p>
              </div>
            )}
          </div>

          <AuctionHeader sale={sale} totalLots={lots.length} activeLot={activeLot} />

          {sale.is_host ? (
            <div className={styles.hostBar}>
              <div className={styles.hostBarHead}>
                <span className={styles.ledgerTitle}>Host controls</span>
                <span className={styles.hostMeta}>
                  {lots.length} lots · {soldCount} sold · {passedCount} passed · {sealedCount} sealed
                </span>
              </div>

              <div className={styles.hostActions}>
                <button
                  className={styles.hostBtn}
                  onClick={() => void runHostAction('live', () => goLive(saleId, viewer), 'Sale is live.')}
                  disabled={actionBusy !== '' || !canGoLive}
                >
                  {actionBusy === 'live' ? <Loader2 size={14} className={styles.spin} /> : <Play size={14} />}
                  Go live
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() =>
                    void runHostAction('reveal', () => revealNext(saleId, viewer),
                      res => `Lot ${res.lot?.position ?? '?'} is now on the block.`)
                  }
                  disabled={actionBusy !== '' || !canReveal}
                  title={activeLot ? 'Hammer or pass the current lot before revealing the next one.' : sealedCount === 0 ? 'No sealed lots left to reveal.' : 'Reveal the next sealed lot.'}
                >
                  {actionBusy === 'reveal' ? <Loader2 size={14} className={styles.spin} /> : <Eye size={14} />}
                  Reveal next
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!activeLot) return
                    if (!window.confirm(`Hammer Lot ${activeLot.position}? This sells it to the top bidder if reserve is met, otherwise passes it.`)) return
                    void runHostAction('hammer', () => hammerLot(activeLot.id, viewer),
                      res => res.message === 'sold'
                        ? `Sold Lot ${activeLot.position} to ${res.winner || 'winner'} at ${formatMoney(res.sold_price, currency)}.`
                        : `Lot ${activeLot.position} passed. ${res.reason || ''}`.trim())
                  }}
                  disabled={actionBusy !== '' || !canHammer}
                >
                  {actionBusy === 'hammer' ? <Loader2 size={14} className={styles.spin} /> : <Gavel size={14} />}
                  Hammer
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!activeLot) return
                    if (!window.confirm(`Pass Lot ${activeLot.position} without selling?`)) return
                    void runHostAction('pass', () => passLot(activeLot.id, viewer), `Lot ${activeLot.position} passed.`)
                  }}
                  disabled={actionBusy !== '' || !canPass}
                >
                  {actionBusy === 'pass' ? <Loader2 size={14} className={styles.spin} /> : <SkipForward size={14} />}
                  Pass
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!lastPassedLot) return
                    if (!window.confirm(`Reopen Lot ${lastPassedLot.position}? Its previous bids remain on the ledger and bidding resumes.`)) return
                    void runHostAction('reopen', () => reopenLot(lastPassedLot.id, viewer), `Lot ${lastPassedLot.position} reopened — back on the block.`)
                  }}
                  disabled={actionBusy !== '' || !canReopenLast}
                  title={activeLot ? 'Hammer or pass the current lot before reopening a passed lot.' : lastPassedLot ? 'Reopen the most recently passed lot.' : 'No passed lots to reopen.'}
                >
                  {actionBusy === 'reopen' ? <Loader2 size={14} className={styles.spin} /> : <RotateCcw size={14} />}
                  Reopen last passed
                </button>

                <button
                  className={`${styles.hostBtn} ${styles.hostBtnDanger}`}
                  onClick={() => {
                    const msg = sealedCount > 0
                      ? `There are still ${sealedCount} sealed lots. Ending now leaves them unsold. End sale anyway?`
                      : 'End this sale?'
                    if (!window.confirm(msg)) return
                    void runHostAction('end', () => endSale(saleId, viewer), 'Sale ended.')
                  }}
                  disabled={actionBusy !== '' || !canEnd}
                  title={activeLot ? 'Hammer or pass the current lot before ending the sale.' : 'End the sale.'}
                >
                  {actionBusy === 'end' ? <Loader2 size={14} className={styles.spin} /> : <Square size={14} />}
                  End sale
                </button>
              </div>

              {actionError ? <div className={styles.hostError}>{actionError}</div> : null}
              {actionNotice ? <div className={styles.hostNotice}>{actionNotice}</div> : null}
            </div>
          ) : null}

          {/* CHAPTERS */}
          <div className={styles.chapters}>
            {lots.map(lot => {
              const isPassed = lot.status === 'passed'
              const canReopenThisLot = !!sale.is_host && sale.status === 'live' && isPassed
              const reopenBlockedByActiveLot = !!activeLot
              const reopenDisabled = actionBusy !== '' || reopenBlockedByActiveLot

              const children = lot.status === 'sealed' ? (
                <div className={styles.chapterSealed}>
                  <Lock size={16} />
                  <span>Lot {lot.position}</span>
                </div>
              ) : (
                <>
                  {lot.image_url ? (
                    <img className={styles.chapterImg} src={lot.image_url} alt={lot.title || `Lot ${lot.position}`} />
                  ) : (
                    <div className={styles.chapterImgBlank} />
                  )}
                  <span className={styles.chapterTitle}>{lot.title || `Lot ${lot.position}`}</span>
                  {lot.status === 'sold' && <span className={styles.soldStamp}>SOLD</span>}
                  {lot.status === 'passed' && <span className={styles.passedStamp}>PASSED</span>}
                  {canReopenThisLot && (
                    <span className={styles.reopenHint}><RotateCcw size={12} /> Reopen</span>
                  )}
                </>
              )

              if (canReopenThisLot) {
                return (
                  <button
                    key={lot.id}
                    type="button"
                    className={`${styles.chapter} ${styles.chapterPassed} ${styles.chapterReopenable}`}
                    title={reopenBlockedByActiveLot ? 'Hammer or pass the current lot before reopening this one.' : 'Reopen this lot — previous bids stay and bidding resumes.'}
                    disabled={reopenDisabled}
                    onClick={() => {
                      if (!window.confirm(`Reopen Lot ${lot.position}? Its previous bids remain on the ledger and bidding resumes.`)) return
                      void runHostAction('reopen', () => reopenLot(lot.id, viewer), `Lot ${lot.position} reopened — back on the block.`)
                    }}
                  >
                    {children}
                  </button>
                )
              }

              return (
                <div
                  key={lot.id}
                  className={`${styles.chapter} ${lot.status === 'on_block' ? styles.chapterActive : ''} ${lot.status === 'sold' ? styles.chapterSold : ''} ${lot.status === 'passed' ? styles.chapterPassed : ''}`}
                >
                  {children}
                </div>
              )
            })}
          </div>

          {/* PADDLE, GATE, INTERMISSION, OR ENDED */}
          {sale.status === 'live' ? (
            activeLot ? (
              sale.can_bid ? (
                <BidPanel
                  lot={activeLot}
                  viewer={viewer}
                  currency={sale.currency}
                  leadingUsername={
                    bids.length
                      ? bids.reduce((top, b) => Number(b.amount) > Number(top.amount) ? b : top).user_name
                      : null
                  }
                  viewerHasBid={bids.some(b => b.user_name === viewer)}
                  onBid={handleMyBid}
                  onBidError={dropMyTemp}
                />
              ) : (
                <TicketGate sale={sale} viewer={viewer} onRefresh={loadSale} />
              )
            ) : (
              <div className={styles.gateCard}>
                <p className={styles.gateTitle}><Radio size={16} /> Between lots</p>
                <p className={styles.gateText}>
                  {sale.is_host && passedCount > 0
                    ? 'The house can reveal the next lot or reopen a passed lot.'
                    : 'The house will reveal the next lot shortly.'}
                </p>
              </div>
            )
          ) : sale.status === 'ended' ? (
            <div className={styles.gateCard}>
              <p className={styles.gateTitle}><Lock size={16} /> Sale ended</p>
              <p className={styles.gateText}>Results are visible in the catalogue strip above.</p>
              <div className={styles.hostActionsInline}>
                <button className={styles.gateBtn} onClick={() => navigate(`/sales/${saleId}`)}>
                  View ticket page
                </button>
                {wonLots > 0 ? (
                  <button className={styles.gateBtn} onClick={() => navigate('/wins')}>
                    <Trophy size={14} /> You won {wonLots} lot{wonLots === 1 ? '' : 's'} — view
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <TicketGate sale={sale} viewer={viewer} onRefresh={loadSale} />
          )}
        </section>

        <aside className={styles.rail}>
          <div className={styles.ledgerHead}>
            <span className={styles.ledgerTitle}>
              Bid ledger {activeLot ? `· Lot ${activeLot.position}` : ''}
            </span>
            {sale.status === 'live' && (
              <span className={styles.ledgerLive}><i /> updating live</span>
            )}
          </div>

          <div className={styles.ledger}>
            {!activeLot ? (
              <p className={styles.ledgerEmpty}>No lot on the block. The floor awaits.</p>
            ) : bids.length === 0 ? (
              <p className={styles.ledgerEmpty}>No bids yet on this lot.</p>
            ) : (
              bids.map((b, i) => (
                <div
                  key={b.id}
                  className={`${styles.ledgerRow} ${i === 0 ? styles.ledgerLead : ''} ${b.__temp ? styles.ledgerPending : ''}`}
                >
                  <span className={styles.ledgerUser}>{b.user_name}</span>
                  <span className={styles.ledgerAmount}>{formatMoney(b.amount, currency)}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </main>
  )
}