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
  SkipForward,
  Square,
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
  revealNext,
  type Lot,
  type LotBid,
  type Sale,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import styles from './AuctionRoomPage.module.css'

type HostActionKey = 'live' | 'reveal' | 'hammer' | 'pass' | 'end'

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
 * Converts normal YouTube watch / youtu.be links into embeddable URLs.
 *
 * Do not scrape youtu.be.
 * Only embed the resulting YouTube embed URL.
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

/**
 * Converts YouTube watch / youtu.be / shorts / live URLs into embeddable URLs.
 *
 * Important:
 * Do not scrape youtu.be.
 * Only embed the resulting YouTube embed URL.
 */
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

  // Upcoming start countdown.
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

    const tick = () => {
      if (cancelled) return

      const diff = target - Date.now()

      if (diff <= 0) {
        setStartCountdown('00:00:00')
        void loadSale()
        return
      }

      setStartCountdown(formatDuration(diff))
    }

    tick()
    const timer = window.setInterval(tick, 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sale?.status, sale?.starts_at, loadSale])

  // Live end countdown.
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

    const tick = () => {
      if (cancelled) return

      const diff = target - Date.now()

      if (diff <= 0) {
        setEndCountdown('00:00:00')
        void loadSale()
        return
      }

      setEndCountdown(formatDuration(diff))
    }

    tick()
    const timer = window.setInterval(tick, 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sale?.status, sale?.ends_at, loadSale])

  // Poll sale status while not ended.
  // This catches:
  // - upcoming -> live when host presses Go live
  // - live lot changes
  // - live -> ended
  useEffect(() => {
    if (!sale || sale.status === 'ended') return

    const timer = window.setInterval(() => {
      void loadSale()
    }, 4000)

    return () => window.clearInterval(timer)
  }, [sale?.status, loadSale])

  // Reset ledger when active lot changes.
  useEffect(() => {
    if (!activeLot) {
      setBids([])
      lastBidId.current = 0
      return
    }

    let alive = true

    setBids([])
    lastBidId.current = 0

    fetchLotBids(activeLot.id, 0).then(list => {
      if (!alive) return

      if (list.length) {
        lastBidId.current = list[list.length - 1].id
      }

      setBids([...list].reverse())
    })

    const timer = window.setInterval(async () => {
      const fresh = await fetchLotBids(activeLot.id, lastBidId.current)

      if (!alive) return

      if (fresh.length > 0) {
        lastBidId.current = fresh[fresh.length - 1].id
        setBids(prev => [...[...fresh].reverse(), ...prev])
      }
    }, 1500)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [activeLot?.id])

  function handleMyBid(b: LotBid) {
    lastBidId.current = Math.max(lastBidId.current, b.id)

    setBids(prev => [b, ...prev])
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

        setActionNotice(typeof success === 'function' ? success(res) : success)
        await loadSale()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Action failed.')
      } finally {
        setActionBusy('')
      }
    },
    [saleId, viewer, loadSale],
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
          {/* THE STREAM — dominant, full width */}
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
                      `Hammer Lot ${activeLot.position}? This will sell it to the top bidder if reserve is met, otherwise pass it.`,
                    )
                    if (!ok) return

                    void runHostAction(
                      'hammer',
                      () => hammerLot(activeLot.id, viewer),
                      res => {
                        if (res.message === 'sold') {
                          return `Sold Lot ${activeLot.position} to ${res.winner || 'winner'} at ${formatMoney(
                            res.sold_price,
                            currency,
                          )}.`
                        }

                        return `Lot ${activeLot.position} passed. ${res.reason || ''}`.trim()
                      },
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

                    const ok = window.confirm(`Pass Lot ${activeLot.position} without selling?`)
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
                  className={`${styles.hostBtn} ${styles.hostBtnDanger}`}
                  onClick={() => {
                    const ok =
                      sealedCount > 0
                        ? `There are still ${sealedCount} sealed lots. Ending now will leave them unsold. End sale anyway?`
                        : 'End this sale?'

                    const confirmed = window.confirm(ok)
                    if (!confirmed) return

                    void runHostAction('end', () => endSale(saleId, viewer), 'Sale ended.')
                  }}
                  disabled={actionBusy !== '' || !canEnd}
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

          {/* CHAPTERS — the catalogue strip */}
          <div className={styles.chapters}>
            {lots.map(lot => (
              <div
                key={lot.id}
                className={`${styles.chapter} ${
                  lot.status === 'on_block' ? styles.chapterActive : ''
                } ${lot.status === 'sold' ? styles.chapterSold : ''} ${
                  lot.status === 'passed' ? styles.chapterPassed : ''
                }`}
              >
                {lot.status === 'sealed' ? (
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

                    {lot.status === 'sold' && <span className={styles.soldStamp}>SOLD</span>}
                    {lot.status === 'passed' && <span className={styles.passedStamp}>PASSED</span>}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* PADDLE, GATE, OR INTERMISSION */}
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
                  The house will reveal the next lot shortly.
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
              <button
                className={styles.gateBtn}
                onClick={() => navigate(`/sales/${saleId}`)}
              >
                View ticket page
              </button>
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
              <p className={styles.ledgerEmpty}>No lot on the block. The floor awaits.</p>
            ) : bids.length === 0 ? (
              <p className={styles.ledgerEmpty}>No bids yet on this lot.</p>
            ) : (
              bids.map((b, i) => (
                <div
                  key={b.id}
                  className={`${styles.ledgerRow} ${i === 0 ? styles.ledgerLead : ''}`}
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