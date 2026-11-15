import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Gavel, TrendingUp } from 'lucide-react'
import { API, formatMoney, type Lot, type LotBid } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

// Client-side ceiling for a bid confirmation. The Neon pool can hold a queued
// query up to query_wait_timeout (default 120s); we refuse to wait that long on
// a single paddle. 12s is generous for a healthy commit and short enough that a
// stuck POST cannot pin the "Already sending…" notice forever. If the server
// eventually commits the bid after we abort, the bid poll + sale poll surface it
// as a real row (the dropped temp is not needed for that).
const BID_CONFIRM_TIMEOUT_MS = 12000

type Props = {
  lot: Lot
  viewer: string
  currency?: string
  leadingUsername?: string | null
  viewerHasBid?: boolean
  onBid: (bid: LotBid) => void
  onBidError?: (amount: number) => void
}

export function BidPanel({
  lot,
  viewer,
  currency = 'NGN',
  leadingUsername = null,
  viewerHasBid = false,
  onBid,
  onBidError,
}: Props) {
  const lotCurrency = lot.currency || currency || 'NGN'

  // current / minimum are PURELY server truth (lot.current_bid). We never lie
  // about them with an optimistic echo, so the 2500ms loadSale poll cannot
  // "revert" a paddle that was never really raised yet. Your pending bid lives
  // on the rail (temp row) + the notice, not in current_bid.
  const current = Number(lot.current_bid || lot.starting_price || 0)

  const increment = useMemo(() => {
    if (!Number.isFinite(current) || current <= 0) return 1000
    return Math.max(100, Math.ceil((current * 0.05) / 100) * 100)
  }, [current])

  const minimum = current + increment

  const [amount, setAmount] = useState(String(minimum))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Prevent duplicate POSTs of the exact same amount while one is in flight.
  const inFlightRef = useRef<Set<string>>(new Set())

  // When OUR OWN confirmed bid lands, the parent bumps lot.current_bid, which
  // changes `minimum`. The reset effect below would normally wipe the input +
  // the "Bid placed" notice on that change. This counter tells it: "this
  // minimum change came from our own confirmation — advance the input to the
  // new legal minimum, but KEEP the feedback." (The optimistic echo no longer
  // changes minimum, so only the real confirm consumes this token.)
  const pendingConfirmRef = useRef(0)
  const prevLotIdRef = useRef(lot.id)

  useEffect(() => {
    // New lot: hard reset.
    if (prevLotIdRef.current !== lot.id) {
      prevLotIdRef.current = lot.id
      pendingConfirmRef.current = 0
      inFlightRef.current.clear()

      setAmount(String(minimum))
      setError('')
      setNotice('')
      return
    }

    // Our own confirmation changed the minimum: advance the input to the new
    // legal minimum, but PRESERVE the "Bid placed" notice/error so the feedback
    // survives. (BUG FIX: the previous early-return skipped setAmount entirely,
    // leaving the box on the just-paid amount — now below the new minimum — which
    // silently disabled Raise paddle until you retapped a quick bid.)
    if (pendingConfirmRef.current > 0) {
      pendingConfirmRef.current -= 1
      setAmount(String(minimum))
      return
    }

    // External change (rival bid / host action): refresh suggested amount and
    // clear our own stale feedback, because the board moved underneath us.
    setAmount(String(minimum))
    setError('')
    setNotice('')
  }, [lot.id, minimum])

  const numericAmount = Number(amount)

  const isLeading =
    !!leadingUsername &&
    !!viewer &&
    leadingUsername.trim().toLowerCase() === viewer.trim().toLowerCase()

  const isOutbid = !!viewerHasBid && !isLeading

  const canSubmit =
    !!viewer &&
    lot.status === 'on_block' &&
    Number.isFinite(numericAmount) &&
    numericAmount >= minimum

  const quickBids = [
    minimum,
    minimum + increment,
    minimum + increment * 2,
    minimum + increment * 5,
  ]

  async function submit(e: FormEvent) {
    e.preventDefault()

    setError('')
    setNotice('')

    if (!viewer) {
      setError('No signed-in bidder detected.')
      return
    }

    if (lot.status !== 'on_block') {
      setError('This lot is not on the block.')
      return
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Enter a valid bid amount.')
      return
    }

    if (numericAmount < minimum) {
      setError(`Minimum bid is ${formatMoney(minimum, lotCurrency)}.`)
      return
    }

    const key = String(numericAmount)

    // Double-tap guard for the same amount. The temp is already on the rail from
    // the first tap; we do NOT echo again. The abort timeout below guarantees
    // this state cannot outlive BID_CONFIRM_TIMEOUT_MS.
    if (inFlightRef.current.has(key)) {
      setNotice('Still confirming your last paddle…')
      return
    }

    inFlightRef.current.add(key)

    // 1) OPTIMISTIC ECHO onto the RAIL only (id: 0 = not committed yet).
    //    We deliberately do NOT fake lot.current_bid here, so the loadSale poll
    //    cannot revert a "paddle" that the house has not recorded.
    const tempBid: LotBid = {
      id: 0,
      user_name: viewer,
      amount: key,
      created_at: new Date().toISOString(),
    }

    onBid(tempBid)
    setNotice('Paddle raised — confirming…')

    // 2) BACKGROUND CONFIRMATION with a hard client timeout.
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), BID_CONFIRM_TIMEOUT_MS)

    try {
      const res = await fetch(`${API}/lots/${lot.id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, amount: numericAmount }),
        signal: controller.signal,
      })

      const data = await res.json().catch(() => ({}))

      if (data?.error) {
        // Server rejected fast (below min, no ticket, blocked, insufficient…).
        setError(String(data.error))
        onBidError?.(numericAmount) // drop the rail temp immediately
        return
      }

      const rawBid =
        data?.bid ||
        (data?.id
          ? {
              id: Number(data.id),
              user_name: data.user_name || viewer,
              amount: data.amount ?? numericAmount,
              created_at: data.created_at || new Date().toISOString(),
            }
          : null)

      if (!rawBid) {
        setError('Bid failed.')
        onBidError?.(numericAmount)
        return
      }

      // 3) RECONCILE — real row (id > 0). Parent collapses the matching temp IN
      //    PLACE and bumps current_bid legitimately (server now agrees, so the
      //    next loadSale poll will NOT revert it).
      const bid = {
        ...rawBid,
        id: Number(rawBid.id ?? 0),
        user_name: String(rawBid.user_name ?? viewer),
        amount: String(rawBid.amount ?? numericAmount),
        created_at: String(rawBid.created_at ?? new Date().toISOString()),
      } as LotBid

      // Protect the "Bid placed" notice across the minimum change this confirm
      // will cause in the parent, AND advance the input to the new minimum
      // (handled in the effect's pendingConfirmRef branch).
      pendingConfirmRef.current += 1

      onBid(bid)

      setNotice(
        isLeading
          ? 'Bid placed. You remain leading.'
          : 'Bid placed. You are now the leading bidder.',
      )
    } catch (err) {
      const aborted =
        err instanceof DOMException
          ? err.name === 'AbortError'
          : (err as { name?: string })?.name === 'AbortError'

      if (aborted) {
        // The POST is stuck in the Neon queue. Unstick the UI: drop the ghost
        // temp so "Already sending…" cannot persist. If the server commits the
        // bid later, the bid poll + sale poll surface it as a real row anyway.
        onBidError?.(numericAmount)
        setError(
          'Confirming your bid timed out. It may still have gone through — watch the ledger.',
        )
      } else {
        setError('Could not reach the floor.')
        onBidError?.(numericAmount)
      }
    } finally {
      window.clearTimeout(timer)
      inFlightRef.current.delete(key)
    }
  }

  return (
    <div className={styles.paddleBox}>
      <div className={styles.paddleTop}>
        <div>
          <p className={styles.paddleLabel}>
            Current bid · Lot {lot.position} “{lot.title || 'Untitled'}”
          </p>
        </div>

        <span className={styles.paddleAmount}>
          {formatMoney(current, lotCurrency)}
        </span>
      </div>

      <div className={styles.bidStatusRow}>
        <span className={styles.bidMeta}>
          Minimum next bid: <strong>{formatMoney(minimum, lotCurrency)}</strong>
        </span>

        {isLeading ? (
          <span className={`${styles.bidPill} ${styles.bidLeading}`}>
            <TrendingUp size={13} />
            You are leading
          </span>
        ) : isOutbid ? (
          <span className={`${styles.bidPill} ${styles.bidOutbid}`}>
            <AlertTriangle size={13} />
            You have been outbid
          </span>
        ) : (
          <span className={`${styles.bidPill} ${styles.bidNeutral}`}>
            <Gavel size={13} />
            Raise your paddle
          </span>
        )}
      </div>

      <form className={styles.bidForm} onSubmit={submit}>
        <div className={styles.quickRow}>
          {quickBids.map(q => (
            <button
              key={q}
              type="button"
              className={styles.quickBtn}
              onClick={() => {
                setAmount(String(q))
                setError('')
                setNotice('')
              }}
              disabled={lot.status !== 'on_block'}
            >
              {formatMoney(q, lotCurrency)}
            </button>
          ))}
        </div>

        <div className={styles.paddleRow}>
          <input
            className={styles.paddleInput}
            value={amount}
            onChange={e => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ''))
              setError('')
              setNotice('')
            }}
            placeholder={String(minimum)}
            inputMode="decimal"
            disabled={lot.status !== 'on_block'}
            aria-label="Bid amount"
          />

          <button className={styles.paddleBtn} type="submit" disabled={!canSubmit}>
            <Gavel size={14} />
            Raise paddle
          </button>
        </div>

        <p className={styles.paddleHint}>
          Bids are binding. Your paddle is personal to this account.
        </p>
      </form>

      {error ? <p className={styles.paddleError}>{error}</p> : null}
      {notice ? <p className={styles.paddleNotice}>{notice}</p> : null}
    </div>
  )
}