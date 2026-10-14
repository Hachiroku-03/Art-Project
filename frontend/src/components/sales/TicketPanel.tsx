import { useState } from 'react'
import { formatMoney, type Sale } from '../../lib/sales'
import styles from './sales.module.css'

type TicketState =
  | 'host'
  | 'has'
  | 'buy'
  | 'vip_required'
  | 'invite_only'
  | 'sold_out'
  | 'ended'
  | 'unavailable'

function deriveState(sale: Sale): TicketState {
  if (sale.status === 'ended') return 'ended'
  if (sale.is_host) return 'host'
  if (sale.has_ticket) return 'has'

  if (sale.access_mode === 'invite') return 'invite_only'

  if (sale.access_mode === 'vip' && !sale.is_vip) return 'vip_required'

  if (
    sale.ticket_capacity != null &&
    sale.tickets_sold != null &&
    sale.tickets_sold >= sale.ticket_capacity
  ) {
    return 'sold_out'
  }

  if (sale.can_buy_ticket) return 'buy'

  return 'unavailable'
}

export function TicketPanel({
  sale,
  paddleCode,
  busy,
  error,
  onBuy,
  onEnter,
  onUseCode,
}: {
  sale: Sale
  paddleCode: string | null
  busy: boolean
  error: string
  onBuy: () => void
  onEnter: () => void
  onUseCode: () => void
}) {
  const [copied, setCopied] = useState(false)
  const state = deriveState(sale)
  const currency = sale.ticket_currency || sale.currency || 'NGN'
  const price = formatMoney(sale.ticket_price, currency)

  const copyCode = async () => {
    if (!paddleCode) return
    try {
      await navigator.clipboard.writeText(paddleCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Paddle</h2>

      {error ? <div className={styles.error}>{error}</div> : null}

      {state === 'host' && (
        <>
          <p className={styles.muted}>
            You are hosting this sale. The full sealed catalogue is visible to you.
          </p>
          <button className={styles.button} onClick={onEnter} disabled={busy}>
            Open room as host
          </button>
        </>
      )}

      {state === 'has' && (
        <>
          <p className={styles.success}>You have a paddle for this room.</p>

          {paddleCode ? (
            <div className={styles.codeBox}>
              <div>
                <div className={styles.small}>One-time code</div>
                <div className={styles.code}>{paddleCode}</div>
              </div>

              <button className={`${styles.button} ${styles.secondary}`} onClick={copyCode}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className={styles.small}>
              Your paddle is bound to your account. You do not need the code unless you switch devices.
            </p>
          )}

          <div className={styles.row}>
            <button className={styles.button} onClick={onEnter} disabled={busy}>
              Enter room
            </button>

            {!paddleCode ? (
              <button className={`${styles.button} ${styles.secondary}`} onClick={onUseCode} disabled={busy}>
                Use code
              </button>
            ) : null}
          </div>
        </>
      )}

      {state === 'buy' && (
        <>
          <p className={styles.muted}>
            Claim a paddle to enter this sale and bid when lots are revealed.
          </p>

          <div className={styles.price}>
            {Number(sale.ticket_price || 0) > 0 ? price : 'Free paddle'}
          </div>

          <button className={styles.button} onClick={onBuy} disabled={busy}>
            {busy ? 'Working…' : Number(sale.ticket_price || 0) > 0 ? 'Buy paddle' : 'Get free paddle'}
          </button>
        </>
      )}

      {state === 'vip_required' && (
        <>
          <p className={styles.muted}>This is a VIP-only room. Active VIP members can claim a paddle.</p>
          <button className={styles.button} disabled>
            VIP required
          </button>
        </>
      )}

      {state === 'invite_only' && (
        <>
          <p className={styles.muted}>This sale is by invitation only.</p>
          <button className={styles.button} disabled>
            Invite only
          </button>
        </>
      )}

      {state === 'sold_out' && (
        <>
          <p className={styles.muted}>This room has reached capacity.</p>
          <button className={styles.button} disabled>
            Sold out
          </button>
        </>
      )}

      {state === 'ended' && (
        <>
          <p className={styles.muted}>This sale has ended.</p>
          <button className={styles.button} disabled>
            Ended
          </button>
        </>
      )}

      {state === 'unavailable' && (
        <>
          <p className={styles.muted}>You cannot claim a paddle for this sale right now.</p>
          <button className={styles.button} disabled>
            Unavailable
          </button>
        </>
      )}
    </section>
  )
}