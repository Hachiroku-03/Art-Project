import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Gavel, Loader2, TrendingUp } from 'lucide-react'
import { API, formatMoney, type Lot, type LotBid } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

type Props = {
  lot: Lot
  viewer: string
  currency?: string
  leadingUsername?: string | null
  viewerHasBid?: boolean
  onBid: (bid: LotBid) => void
}

export function BidPanel({
  lot,
  viewer,
  currency = 'NGN',
  leadingUsername = null,
  viewerHasBid = false,
  onBid,
}: Props) {
  const lotCurrency = lot.currency || currency || 'NGN'

  const current = Number(lot.current_bid || lot.starting_price || 0)

  const increment = useMemo(() => {
    if (!Number.isFinite(current) || current <= 0) return 1000
    return Math.max(100, Math.ceil((current * 0.05) / 100) * 100)
  }, [current])

  const minimum = current + increment

  const [amount, setAmount] = useState(String(minimum))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
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
    numericAmount >= minimum &&
    !busy

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

    setBusy(true)

    try {
      const res = await fetch(`${API}/lots/${lot.id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, amount: numericAmount }),
      })

      const data = await res.json()

      if (data.error) {
        setError(data.error)
        setBusy(false)
        return
      }

      const bid: LotBid | null =
        data.bid ||
        (data.id
          ? {
              id: data.id,
              user_name: viewer,
              amount: String(data.amount ?? numericAmount),
              created_at: new Date().toISOString(),
            }
          : null)

      if (!bid) {
        setError('Bid failed.')
        setBusy(false)
        return
      }

      onBid({
        ...bid,
        amount: String(bid.amount),
      })

      setAmount(String(numericAmount + increment))
      setNotice(
        isLeading
          ? 'Bid placed. You remain leading.'
          : 'Bid placed. You are now the leading bidder.',
      )
    } catch {
      setError('Could not reach the floor.')
    } finally {
      setBusy(false)
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
              disabled={busy || lot.status !== 'on_block'}
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
            disabled={busy || lot.status !== 'on_block'}
            aria-label="Bid amount"
          />

          <button className={styles.paddleBtn} type="submit" disabled={!canSubmit}>
            {busy ? (
              <>
                <Loader2 size={14} className={styles.spin} />
                Placing…
              </>
            ) : (
              <>
                <Gavel size={14} />
                Raise paddle
              </>
            )}
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