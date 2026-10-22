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

  // https://youtu.be/VIDEO_ID
  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0]
    if (id) return buildYouTubeEmbed(id, nocookie)
    return ''
  }

  // https://youtube.com / https://www.youtube.com / https://youtube-nocookie.com
  if (host === 'youtube.com' || nocookie) {
    // https://youtube.com/watch?v=VIDEO_ID
    if (path === '/watch') {
      const id = u.searchParams.get('v')
      if (id) return buildYouTubeEmbed(id, nocookie)
    }

    // https://youtube.com/embed/VIDEO_ID
    // https://youtube.com/shorts/VIDEO_ID
    // https://youtube.com/live/VIDEO_ID
    const idMatch = path.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)
    if (idMatch?.[1]) {
      return buildYouTubeEmbed(idMatch[1], nocookie)
    }

    // https://youtube.com/embed/live_stream?channel=CHANNEL_ID
    if (path === '/embed/live_stream') {
      const channel = u.searchParams.get('channel')
      if (channel) return buildYouTubeChannelLiveEmbed(channel, nocookie)
    }
  }

  // Twitch / Zoom / other external embeds: return as-is if it looks valid.
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
  const [bids, setBids] = useState<LotBid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [startCountdown, setStartCountdown] = useState('')
  const [endCountdown, setEndCountdown] = useState('')

  const [actionBusy, setActionBusy] = useState<HostActionKey | ''>('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')

  const lastBidId = useRef(0)

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

    return {
      embed,
      external,
      isYouTube,
    }
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

  // Did this viewer win anything in this sale?
  // winner_username is left visible by get_sale for sold lots.
  const wonLots = useMemo(
    () => (viewer ? lots.filter(l => l.winner_username === viewer).length : 0),
    [lots, viewer],
  )

  const loadSale = useCallback(async () => {
    if (!Number.isFinite(saleId)) {
      setError('Invalid sale id.')
      setLoading(false)
      return
    }

    try {
      const data = await fetchSale(String(saleId), viewer)

      if (data.sale) {
        setSale(data.sale)
        setLots(data.lots || [])
        setError('')
      } else {
        setError(data.error || 'This room is private.')
      }
    } catch {
      setError('network error - is the feed server running?')
    } finally {
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
    if (!target) {
      setStartCountdown('')
      return
    }

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

    if (!done && !cancelled) {
      timer = window.setInterval(tick, 1000)
    }

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
    if (!target) {
      setEndCountdown('')
      return
    }

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

    if (!done && !cancelled) {
      timer = window.setInterval(tick, 1000)
    }

    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [sale?.status, sale?.ends_at, loadSale])

  // Poll sale status while not ended.
  useEffect(() => {
    if (!sale || sale.status === 'ended') return

    const timer = window.setInterval(() => {
      void loadSale()
    }, 2500)

    return () => window.clearInterval(timer)
  }, [sale?.status, loadSale])

  /**
   * Single source of truth for the ledger.
   *
   * Keyed ONLY on activeLot?.id so a lot change always clears the board.
   * Merge is strictly id-deduped so an optimistic row can never coexist with
   * the polled real row.
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
        const seen = new Set(prev.map(b => b.id))

        const add = incoming.filter(
          b => b.id > 0 && b.id > lastBidId.current && !seen.has(b.id),
        )

        if (!add.length) return prev

        const maxId = add.reduce((m, b) => Math.max(m, b.id), lastBidId.current)
        lastBidId.current = maxId

        return [...add.slice().reverse(), ...prev]
      })
    }

    fetchLotBids(lotId, 0).then(list => {
      if (!alive) return

      const real = list.filter(b => b.id > 0)

      if (real.length) {
        lastBidId.current = real[real.length - 1].id
      }

      setBids(real.slice().reverse())
    })

    const timer = window.setInterval(async () => {
      const fresh = await fetchLotBids(lotId, lastBidId.current)

      if (alive && fresh.length) {
        merge(fresh)
      }
    }, 1000)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [activeLot?.id])

  function handleMyBid(b: LotBid) {
    // Only trust real backend ids; the poll will also surface it and merge() dedupes.
    if (b.id > 0) {
      lastBidId.current = Math.max(lastBidId.current, b.id)
      setBids(prev => (prev.some(x => x.id === b.id) ? prev : [b, ...prev]))
    }

    setLots(prev =>
      prev.map(l =>
        l.id === activeLot?.id
          ? {
              ...l,
              current_bid: b.amount,
              bid_count: (l.bid_count || 0) + 1,
            }
          : l,
      ),
    )
  }

  /**
   * Flip local state the instant an action succeeds, so the board moves without
   * waiting on the network reconcile.
   */
  const applyOptimistic = useCallback((key: HostActionKey, res: any) => {
    if (!res || res.error) return

    if (key === 'live') {
      setSale(prev => (prev ? { ...prev, status: 'live' } : prev))
      return
    }

    if (key === 'end') {
      setSale(prev =>
        prev
          ? {
              ...prev,
              status: 'ended',
              ended_at: new Date().toISOString(),
            }
          : prev,
      )
      return
    }

    if (key === 'reveal' && res.lot?.id) {
      const revealedId = res.lot.id

      setLots(prev =>
        prev.map(l =>
          l.id === revealedId ? { ...l, status: 'on_block' as const } : l,
        ),
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

          return {
            ...l,
            status: 'passed' as const,
            hammer_at: new Date().toISOString(),
          }
        }),
      )

      return
    }

    /**
     * Reopen a passed lot back onto the block.
     *
     * Bids are preserved server-side. The ledger effect, keyed on activeLot?.id,
     * refetches them once this lot becomes active again.
     *
     * We only flip THIS lot, never another.
     */
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

        if (res?.error) {
          setActionError(res.error)
          return
        }

        applyOptimistic(key, res)
        setActionNotice(typeof success === 'function' ? success(res) : success)

        // Reconcile in the background; do NOT block the button on it.
        void loadSale()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Action failed.')
      } finally {
        setActionBusy('')
      }
    },
    [saleId, viewer, loadSale, applyOptimistic],
  )

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

  // THE CURTAIN — before the sale, only the timer exists.
  if (sale.status === 'upcoming') {
    const startReached = startCountdown === '00:00:00'

    return (
      <main className={styles.curtainLayout}>
        <Navbar />

        <div className={styles.curtain}>
          <p className={styles.curtainLabel}>The auction will start in</p>
          <h1 className={styles.curtainTime}>{startCountdown || '—'}</h1>

          <p className={styles.curtainSub}>
            {sale.title} · @{sale.host_username}
          </p>

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
                {actionBusy === 'live' ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Play size={14} />
                )}
                Go live
              </button>
            </div>
          ) : !sale.has_ticket ? (
            <div className={styles.hostActionsInline}>
              <button
                className={styles.gateBtn}
                onClick={() => navigate(`/sales/${saleId}`)}
              >
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
          <button
            className={styles.backBtn}
            onClick={() => navigate('/auctions')}
            aria-label="Back to floor"
          >
            <ArrowLeft size={18} />
          </button>

          <span className={styles.watching}>
            <i />
            {sale.status === 'live'
              ? `live${endCountdown ? ` · ends in ${endCountdown}` : ''}`
              : sale.status === 'ended'
                ? 'archive'
                : 'upcoming'}
          </span>
        </div>

        <section className={styles.main}>
          {/* THE STREAM */}
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
                  <a
                    className={styles.streamFallback}
                    href={stream.external}
                    target="_blank"
                    rel="noreferrer"
                  >
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

          <AuctionHeader
            sale={sale}
            totalLots={lots.length}
            activeLot={activeLot}
          />

          {/* HOST CONTROLS */}
          {sale.is_host ? (
            <div className={styles.hostBar}>
              <div className={styles.hostBarHead}>
                <span className={styles.ledgerTitle}>Host controls</span>

                <span className={styles.hostMeta}>
                  {lots.length} lots · {soldCount} sold · {passedCount} passed ·{' '}
                  {sealedCount} sealed
                </span>
              </div>

              <div className={styles.hostActions}>
                <button
                  className={styles.hostBtn}
                  onClick={() =>
                    void runHostAction('live', () => goLive(saleId, viewer), 'Sale is live.')
                  }
                  disabled={actionBusy !== '' || !canGoLive}
                >
                  {actionBusy === 'live' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Play size={14} />
                  )}
                  Go live
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() =>
                    void runHostAction(
                      'reveal',
                      () => revealNext(saleId, viewer),
                      res => `Lot ${res.lot?.position ?? '?'} is now on the block.`,
                    )
                  }
                  disabled={actionBusy !== '' || !canReveal}
                  title={
                    activeLot
                      ? 'Hammer or pass the current lot before revealing the next one.'
                      : sealedCount === 0
                        ? 'No sealed lots left to reveal.'
                        : 'Reveal the next sealed lot.'
                  }
                >
                  {actionBusy === 'reveal' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Eye size={14} />
                  )}
                  Reveal next
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!activeLot) return

                    const ok = window.confirm(
                      `Hammer Lot ${activeLot.position}? This sells it to the top bidder if reserve is met, otherwise passes it.`,
                    )

                    if (!ok) return

                    void runHostAction(
                      'hammer',
                      () => hammerLot(activeLot.id, viewer),
                      res =>
                        res.message === 'sold'
                          ? `Sold Lot ${activeLot.position} to ${res.winner || 'winner'} at ${formatMoney(
                              res.sold_price,
                              currency,
                            )}.`
                          : `Lot ${activeLot.position} passed. ${res.reason || ''}`.trim(),
                    )
                  }}
                  disabled={actionBusy !== '' || !canHammer}
                >
                  {actionBusy === 'hammer' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Gavel size={14} />
                  )}
                  Hammer
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!activeLot) return

                    const ok = window.confirm(
                      `Pass Lot ${activeLot.position} without selling?`,
                    )

                    if (!ok) return

                    void runHostAction(
                      'pass',
                      () => passLot(activeLot.id, viewer),
                      `Lot ${activeLot.position} passed.`,
                    )
                  }}
                  disabled={actionBusy !== '' || !canPass}
                >
                  {actionBusy === 'pass' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <SkipForward size={14} />
                  )}
                  Pass
                </button>

                <button
                  className={styles.hostBtn}
                  onClick={() => {
                    if (!lastPassedLot) return

                    const ok = window.confirm(
                      `Reopen Lot ${lastPassedLot.position}? Its previous bids remain on the ledger and bidding resumes.`,
                    )

                    if (!ok) return

                    void runHostAction(
                      'reopen',
                      () => reopenLot(lastPassedLot.id, viewer),
                      `Lot ${lastPassedLot.position} reopened — back on the block.`,
                    )
                  }}
                  disabled={actionBusy !== '' || !canReopenLast}
                  title={
                    activeLot
                      ? 'Hammer or pass the current lot before reopening a passed lot.'
                      : lastPassedLot
                        ? 'Reopen the most recently passed lot.'
                        : 'No passed lots to reopen.'
                  }
                >
                  {actionBusy === 'reopen' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  Reopen last passed
                </button>

                <button
                  className={`${styles.hostBtn} ${styles.hostBtnDanger}`}
                  onClick={() => {
                    const msg =
                      sealedCount > 0
                        ? `There are still ${sealedCount} sealed lots. Ending now leaves them unsold. End sale anyway?`
                        : 'End this sale?'

                    if (!window.confirm(msg)) return

                    void runHostAction('end', () => endSale(saleId, viewer), 'Sale ended.')
                  }}
                  disabled={actionBusy !== '' || !canEnd}
                  title={
                    activeLot
                      ? 'Hammer or pass the current lot before ending the sale.'
                      : 'End the sale.'
                  }
                >
                  {actionBusy === 'end' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Square size={14} />
                  )}
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

              const canReopenThisLot =
                !!sale.is_host && sale.status === 'live' && isPassed

              const reopenBlockedByActiveLot = !!activeLot

              const reopenDisabled =
                actionBusy !== '' || reopenBlockedByActiveLot

              const children =
                lot.status === 'sealed' ? (
                  <div className={styles.chapterSealed}>
                    <Lock size={16} />
                    <span>Lot {lot.position}</span>
                  </div>
                ) : (
                  <>
                    {lot.image_url ? (
                      <img
                        className={styles.chapterImg}
                        src={lot.image_url}
                        alt={lot.title || `Lot ${lot.position}`}
                      />
                    ) : (
                      <div className={styles.chapterImgBlank} />
                    )}

                    <span className={styles.chapterTitle}>
                      {lot.title || `Lot ${lot.position}`}
                    </span>

                    {lot.status === 'sold' && (
                      <span className={styles.soldStamp}>SOLD</span>
                    )}

                    {lot.status === 'passed' && (
                      <span className={styles.passedStamp}>PASSED</span>
                    )}

                    {canReopenThisLot && (
                      <span className={styles.reopenHint}>
                        <RotateCcw size={12} />
                        Reopen
                      </span>
                    )}
                  </>
                )

              if (canReopenThisLot) {
                return (
                  <button
                    key={lot.id}
                    type="button"
                    className={`${styles.chapter} ${styles.chapterPassed} ${styles.chapterReopenable}`}
                    title={
                      reopenBlockedByActiveLot
                        ? 'Hammer or pass the current lot before reopening this one.'
                        : 'Reopen this lot — previous bids stay and bidding resumes.'
                    }
                    disabled={reopenDisabled}
                    onClick={() => {
                      const ok = window.confirm(
                        `Reopen Lot ${lot.position}? Its previous bids remain on the ledger and bidding resumes.`,
                      )

                      if (!ok) return

                      void runHostAction(
                        'reopen',
                        () => reopenLot(lot.id, viewer),
                        `Lot ${lot.position} reopened — back on the block.`,
                      )
                    }}
                  >
                    {children}
                  </button>
                )
              }

              return (
                <div
                  key={lot.id}
                  className={`${styles.chapter} ${
                    lot.status === 'on_block' ? styles.chapterActive : ''
                  } ${lot.status === 'sold' ? styles.chapterSold : ''} ${
                    lot.status === 'passed' ? styles.chapterPassed : ''
                  }`}
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
                      ? bids.reduce((top, b) =>
                          Number(b.amount) > Number(top.amount) ? b : top,
                        ).user_name
                      : null
                  }
                  viewerHasBid={bids.some(b => b.user_name === viewer)}
                  onBid={handleMyBid}
                />
              ) : (
                <TicketGate sale={sale} viewer={viewer} onRefresh={loadSale} />
              )
            ) : (
              <div className={styles.gateCard}>
                <p className={styles.gateTitle}>
                  <Radio size={16} /> Between lots
                </p>

                <p className={styles.gateText}>
                  {sale.is_host && passedCount > 0
                    ? 'The house can reveal the next lot or reopen a passed lot.'
                    : 'The house will reveal the next lot shortly.'}
                </p>
              </div>
            )
          ) : sale.status === 'ended' ? (
            <div className={styles.gateCard}>
              <p className={styles.gateTitle}>
                <Lock size={16} /> Sale ended
              </p>

              <p className={styles.gateText}>
                Results are visible in the catalogue strip above.
              </p>

              <div className={styles.hostActionsInline}>
                <button
                  className={styles.gateBtn}
                  onClick={() => navigate(`/sales/${saleId}`)}
                >
                  View ticket page
                </button>

                {wonLots > 0 ? (
                  <button
                    className={styles.gateBtn}
                    onClick={() => navigate('/wins')}
                  >
                    <Trophy size={14} />
                    You won {wonLots} lot{wonLots === 1 ? '' : 's'} — view
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <TicketGate sale={sale} viewer={viewer} onRefresh={loadSale} />
          )}
        </section>

        <aside className={styles.rail}>
          {/* THE LEDGER */}
          <div className={styles.ledgerHead}>
            <span className={styles.ledgerTitle}>
              Bid ledger {activeLot ? `· Lot ${activeLot.position}` : ''}
            </span>

            {sale.status === 'live' && (
              <span className={styles.ledgerLive}>
                <i /> updating live
              </span>
            )}
          </div>

          <div className={styles.ledger}>
            {!activeLot ? (
              <p className={styles.ledgerEmpty}>
                No lot on the block. The floor awaits.
              </p>
            ) : bids.length === 0 ? (
              <p className={styles.ledgerEmpty}>No bids yet on this lot.</p>
            ) : (
              bids.map((b, i) => (
                <div
                  key={b.id}
                  className={`${styles.ledgerRow} ${
                    i === 0 ? styles.ledgerLead : ''
                  }`}
                >
                  <span className={styles.ledgerUser}>{b.user_name}</span>

                  <span className={styles.ledgerAmount}>
                    {formatMoney(b.amount, currency)}
                  </span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </main>
  )
}