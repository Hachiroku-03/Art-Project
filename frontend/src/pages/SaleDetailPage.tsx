import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  API,
  buyPaddle,
  formatMoney,
  getSaleView,
  normalizeAccessMode,
  type Lot,
  type Sale,
} from '../lib/sales'
import { getViewer } from '../lib/session'
import { EnterRoomModal } from '../components/sales/EnterRoomModal'
import styles from './SaleDetailPage.module.css'

type HostProfile = {
  username: string
  display_name?: string | null
  avatar_url?: string | null
  role?: string | null
  tier?: string | null
}

function paddleStorageKey(saleId: number, viewer: string) {
  return `paddle_code:${saleId}:${viewer}`
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

  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

function lotStatusText(status: Lot['status']) {
  if (status === 'on_block') return 'on the block'
  if (status === 'sold') return 'sold'
  if (status === 'passed') return 'passed'
  return 'sealed'
}

export function SaleDetailPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const id = Number(saleId)
  const viewer = getViewer()
  const navigate = useNavigate()

  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [host, setHost] = useState<HostProfile | null>(null)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [paddleCode, setPaddleCode] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [codeModalOpen, setCodeModalOpen] = useState(false)

  const [startCountdown, setStartCountdown] = useState('')
  const [endCountdown, setEndCountdown] = useState('')

  const autoEnteredRef = useRef(false)

  const load = useCallback(async () => {
    if (!Number.isFinite(id)) {
      setError('Invalid sale id.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await getSaleView(id, viewer)

    if (d.error) {
      setError(d.error)
      setSale(null)
      setLots([])
    } else {
      setSale(d.sale || null)
      setLots(d.lots || [])
    }

    setLoading(false)
  }, [id, viewer])

  useEffect(() => {
    void load()
  }, [load])

  // Load auction house profile for the clickable profile picture.
  useEffect(() => {
    const username = sale?.host_username

    if (!username) {
      setHost(null)
      return
    }

    let alive = true

    fetch(`${API}/me?viewer=${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        if (d.user) setHost(d.user as HostProfile)
      })
      .catch(() => {
        // Non-blocking. The page still works without the host avatar.
      })

    return () => {
      alive = false
    }
  }, [sale?.host_username])

  // Restore a previously purchased/issued code for this viewer + sale.
  useEffect(() => {
    if (!sale?.id || !viewer) return

    try {
      const stored = localStorage.getItem(paddleStorageKey(sale.id, viewer))
      if (stored) setPaddleCode(stored)
    } catch {
      // ignore storage errors
    }
  }, [sale?.id, viewer])

  const saleEnded = sale?.status === 'ended'
  const isHost = Boolean(sale?.is_host)
  const hasPaddle = Boolean(sale?.has_ticket || isHost)

  const soldOut =
    sale?.ticket_capacity != null &&
    sale?.tickets_sold != null &&
    sale.tickets_sold >= sale.ticket_capacity

  const canBuy = Boolean(
    sale?.can_buy_ticket &&
    !sale?.has_ticket &&
    !isHost &&
    !saleEnded &&
    !soldOut,
  )

  const canEnter = isHost || (Boolean(sale?.has_ticket) && !saleEnded)

  const currency = sale?.ticket_currency || sale?.currency || 'NGN'
  const price = Number(sale?.ticket_price || 0)
  const priceLabel = price > 0 ? formatMoney(price, currency) : null

  const mode = normalizeAccessMode(sale?.access_mode ?? sale?.tier)
  const accessLabel =
    mode === 'vip'
      ? 'VIP room'
      : mode === 'invite'
        ? 'Invite only'
        : 'Open room'

  const buyLabel = busy
    ? 'Working…'
    : isHost
      ? 'Host account'
      : sale?.has_ticket
        ? 'Paddle owned'
        : saleEnded
          ? 'Sale ended'
          : soldOut
            ? 'Sold out'
            : mode === 'invite'
              ? 'Invite only'
              : mode === 'vip' && !sale?.is_vip
                ? 'VIP required'
                : price > 0
                  ? 'Claim paddle'
                  : 'Claim free paddle'

  const buyHelp = isHost
    ? 'You are hosting this sale. Use the room entry button to open the rostrum.'
    : sale?.has_ticket
      ? 'Your paddle is unlocked. Enter room will ask for your paddle code.'
      : saleEnded
        ? 'This sale has ended. Paddles can no longer be claimed.'
        : soldOut
          ? 'This room has reached paddle capacity.'
          : mode === 'invite'
            ? 'This sale is invite only. The house must issue your paddle.'
            : mode === 'vip' && !sale?.is_vip
              ? 'This is a VIP room. Activate VIP to claim a paddle.'
              : price > 0
                ? `Claiming a paddle costs ${priceLabel}.`
                : 'Claim a free paddle to enter this room.'

  const enterLabel = isHost
    ? 'Enter as host'
    : canEnter
      ? 'Enter room'
      : 'Locked'

  const maskedCode = paddleCode ? `•••• ${paddleCode.slice(-4)}` : ''

  // -------------------------------------------------------------------
  // UPCOMING START COUNTDOWN + AUTO ENTER
  // -------------------------------------------------------------------
  const autoTarget = sale?.status === 'upcoming' ? sale?.starts_at : null
  const autoTargetMs = parseTimestamp(autoTarget)
  const autoEnterKey =
    sale?.id && autoTarget
      ? `auto_entered_sale:${sale.id}:${autoTarget}`
      : null

  useEffect(() => {
    autoEnteredRef.current = false

    if (!autoEnterKey) return

    try {
      autoEnteredRef.current = sessionStorage.getItem(autoEnterKey) === '1'
    } catch {
      // ignore storage errors
    }
  }, [autoEnterKey])

  useEffect(() => {
  if (!sale?.id) return

  if (!autoTargetMs) {
    setStartCountdown('')
    return
  }

  let cancelled = false
  let done = false
  let timer: number | undefined

  const tick = () => {
    if (cancelled) return

    const diff = autoTargetMs - Date.now()

    if (diff <= 0) {
      done = true
      setStartCountdown('00:00:00')

      if (timer) {
        window.clearInterval(timer)
        timer = undefined
      }

      if (!autoEnteredRef.current) {
        autoEnteredRef.current = true

        try {
          if (autoEnterKey) sessionStorage.setItem(autoEnterKey, '1')
        } catch {
          // ignore storage errors
        }

        if (canEnter) {
          navigate(`/sales/${sale.id}/room`)
        } else {
          setNotice('The scheduled start time has passed. Claim a paddle to enter the room.')
        }
      }

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
}, [sale?.id, autoTargetMs, autoEnterKey, canEnter, navigate])

  // -------------------------------------------------------------------
  // LIVE END COUNTDOWN
  // -------------------------------------------------------------------
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

      if (timer) {
        window.clearInterval(timer)
        timer = undefined
      }

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
}, [sale?.status, sale?.ends_at])

  const handleBuy = async () => {
    if (!sale) return

    setBusy(true)
    setError('')
    setNotice('')

    const r = await buyPaddle(sale.id, viewer)

    if (r.error) {
      setError(r.error)
      setBusy(false)
      return
    }

    if (r.code) {
      setPaddleCode(r.code)
      setRevealed(true)

      try {
        localStorage.setItem(paddleStorageKey(sale.id, viewer), r.code)
      } catch {
        // ignore storage errors
      }

      setNotice(`Paddle issued. Code: ${r.code}. Keep it safe; you will need it to enter the room.`)
    } else {
      setNotice('Paddle issued.')
    }

    await load()
    setBusy(false)
  }

  const handleEnter = () => {
    if (!sale) return

    setError('')

    if (isHost) {
      navigate(`/sales/${sale.id}/room`)
      return
    }

    if (!sale.has_ticket) {
      setError('You need a paddle before entering this room.')
      return
    }

    if (saleEnded) {
      setError('This sale has ended.')
      return
    }

    setCodeModalOpen(true)
  }

  const copyCode = async () => {
    if (!paddleCode) return

    try {
      await navigator.clipboard.writeText(paddleCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.loading}>Loading sale…</div>
      </main>
    )
  }

  if (!sale) {
    return (
      <main className={styles.page}>
        <div className={styles.wrap}>
          <Link className={styles.back} to="/auctions">
            ← Back to auctions
          </Link>

          <div className={styles.notFound}>{error || 'Sale not found.'}</div>
        </div>
      </main>
    )
  }

  const soldCount = lots.filter(l => l.status === 'sold').length
  const onBlockCount = lots.filter(l => l.status === 'on_block').length

  const statusText =
    sale.status === 'live'
      ? endCountdown
        ? `live · ends in ${endCountdown}`
        : 'live'
      : sale.status === 'upcoming'
        ? startCountdown
          ? `opens in ${startCountdown}`
          : 'upcoming'
        : 'ended'

  return (
    <main className={styles.page}>
      <section className={styles.banner}>
        {sale.image_url ? (
          <img className={styles.bannerImg} src={sale.image_url} alt={sale.title} />
        ) : (
          <div className={styles.bannerEmpty} />
        )}

        <div className={styles.bannerTop}>
          <Link className={styles.back} to="/auctions">
            ← Auctions
          </Link>

          <div
            className={`${styles.status} ${
              sale.status === 'live' ? styles.statusLive : ''
            }`}
          >
            <span className={styles.statusDot} />
            {statusText}
          </div>
        </div>
      </section>

      <div className={styles.wrap}>
        <div className={styles.head}>
          <Link className={styles.host} to={`/profile/${sale.host_username}`}>
            <span className={styles.avatar}>
              {host?.avatar_url ? (
                <img className={styles.avatarImg} src={host.avatar_url} alt="" />
              ) : (
                <span className={styles.avatarInitial}>
                  {(host?.display_name || sale.host_username || '?')[0]?.toUpperCase()}
                </span>
              )}
            </span>

            <span className={styles.hostText}>
              <span className={styles.hostName}>
                {host?.display_name || sale.host_username}
              </span>
              <span className={styles.hostHandle}>
                @{sale.host_username} · auction house
              </span>
            </span>
          </Link>

          <h1 className={styles.title}>{sale.title}</h1>

          <p className={styles.meta}>
            <b className={styles.access}>{accessLabel}</b>
            <span className={styles.sep}>·</span>
            <span>{lots.length} lots</span>
            <span className={styles.sep}>·</span>
            <span>
              Paddle {priceLabel || 'free'}
            </span>
            {sale.tickets_remaining != null ? (
              <>
                <span className={styles.sep}>·</span>
                <span>{sale.tickets_remaining} paddles remaining</span>
              </>
            ) : null}
          </p>

          {sale.description ? <p className={styles.desc}>{sale.description}</p> : null}

          <div className={styles.action}>
            <button
              className={styles.primary}
              onClick={() => void handleBuy()}
              disabled={!canBuy || busy}
            >
              {buyLabel}
              {priceLabel && !sale.has_ticket && !isHost ? (
                <span className={styles.primaryPrice}>{priceLabel}</span>
              ) : null}
            </button>

            <button
              className={styles.link}
              onClick={handleEnter}
              disabled={!canEnter}
            >
              {!canEnter ? '🔒 ' : ''}
              {enterLabel}
            </button>

            <p className={styles.help}>{buyHelp}</p>

            {error ? <p className={`${styles.msg} ${styles.msgErr}`}>{error}</p> : null}
            {notice ? <p className={`${styles.msg} ${styles.msgOk}`}>{notice}</p> : null}
          </div>

          {paddleCode && hasPaddle ? (
            <div className={styles.code}>
              <span>Your paddle code</span>
              <span className={styles.codeValue}>
                {revealed ? paddleCode : maskedCode}
              </span>

              <span className={styles.codeActions}>
                <button
                  className={styles.link}
                  type="button"
                  onClick={() => setRevealed(r => !r)}
                >
                  {revealed ? 'Hide' : 'Reveal'}
                </button>

                <button
                  className={styles.link}
                  type="button"
                  onClick={() => void copyCode()}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </span>
            </div>
          ) : null}
        </div>

        <section className={styles.catalogue}>
          <div className={styles.catHead}>
            <h2 className={styles.catTitle}>Catalogue</h2>
            <span className={styles.catCount}>
              {lots.length} lots · {soldCount} sold · {onBlockCount} on the block
            </span>
          </div>

          {lots.length ? (
            <div className={styles.lots}>
              {lots.map(lot => {
                const isSealed = lot.status === 'sealed'
                const current = Number(lot.current_bid || lot.starting_price || 0)
                const lotCurrency = lot.currency || sale.currency || 'NGN'

                return (
                  <div key={lot.id} className={styles.lot}>
                    <div className={styles.lotNo}>
                      <span>LOT {lot.position}</span>
                      <span
                        className={
                          lot.status === 'on_block'
                            ? styles.lotLive
                            : lot.status === 'sold'
                              ? styles.lotSold
                              : ''
                        }
                      >
                        {lotStatusText(lot.status)}
                      </span>
                    </div>

                    {isSealed ? (
                      <div className={styles.lotSealed}>sealed</div>
                    ) : lot.image_url ? (
                      <img
                        className={styles.lotImg}
                        src={lot.image_url}
                        alt={lot.title || `Lot ${lot.position}`}
                      />
                    ) : (
                      <div className={styles.lotSealed}>no image</div>
                    )}

                    <div className={styles.lotTitle}>
                      {isSealed ? `Lot ${lot.position}` : lot.title || `Lot ${lot.position}`}
                    </div>

                    {isSealed ? (
                      <div className={styles.lotLine}>Revealed at the rostrum</div>
                    ) : lot.status === 'sold' ? (
                      <div className={`${styles.lotLine} ${styles.lotSold}`}>
                        {formatMoney(lot.sold_price, lotCurrency)}
                        {lot.winner_username ? ` · @${lot.winner_username}` : ''}
                      </div>
                    ) : lot.status === 'passed' ? (
                      <div className={styles.lotLine}>Passed</div>
                    ) : (
                      <div className={styles.lotLine}>
                        {formatMoney(current, lotCurrency)}
                        {lot.bid_count ? ` · ${lot.bid_count} bids` : ''}
                      </div>
                    )}

                    {lot.status === 'on_block' ? (
                      <button
                        className={styles.lotBid}
                        onClick={() => navigate(`/sales/${sale.id}/room`)}
                      >
                        {sale.can_bid ? 'Bid in room' : 'Enter room'}
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className={styles.catEmpty}>
              The catalogue will appear here once the house adds lots.
            </p>
          )}
        </section>
      </div>

      <EnterRoomModal
        open={codeModalOpen}
        saleId={sale.id}
        viewer={viewer}
        initialCode={paddleCode || ''}
        onClose={() => setCodeModalOpen(false)}
        onEntered={() => {
          setCodeModalOpen(false)
          navigate(`/sales/${sale.id}/room`)
        }}
      />
    </main>
  )
}