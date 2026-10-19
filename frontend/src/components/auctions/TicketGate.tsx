import { useState } from 'react'
import { Crown, Lock, Ticket, Gavel } from 'lucide-react'
import { API, formatMoney, normalizeAccessMode, type Sale } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

type Props = { sale: Sale; viewer: string; onRefresh: () => void }

function accessMode(sale: Sale) {
  return normalizeAccessMode((sale as any).access_mode ?? sale.tier)
}

function isSoldOut(sale: Sale) {
  const capacity = (sale as any).ticket_capacity as number | null | undefined
  const remaining = (sale as any).tickets_remaining as number | null | undefined
  const sold = (sale as any).tickets_sold as number | null | undefined

  if (remaining === 0) return true
  if (capacity != null && sold != null && sold >= capacity) return true

  return false
}

export function TicketGate({ sale, viewer, onRefresh }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const mode = accessMode(sale)
  const soldOut = isSoldOut(sale)
  const currency = sale.ticket_currency || sale.currency || 'NGN'
  const price = Number(sale.ticket_price || 0)

  async function buyTicket() {
    setBusy(true)
    setMsg('')

    try {
      const res = await fetch(`${API}/sales/${sale.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer }),
      })

      const data = await res.json()

      if (data.error) {
        setMsg(data.error)
        setBusy(false)
        return
      }

      if (data.message) {
        setMsg(
          price > 0
            ? `Paddle secured for ${formatMoney(data.price ?? price, data.currency || currency)}.`
            : 'Free paddle claimed.',
        )
      } else {
        setMsg('Paddle secured.')
      }

      onRefresh()
    } catch {
      setMsg('Could not reach the box office.')
    } finally {
      setBusy(false)
    }
  }

  if (sale.status === 'ended') {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Gavel size={16} /> The hammer fell.
        </p>
        <p className={styles.gateText}>
          This sale has closed. The ledger above is the official record.
        </p>
      </div>
    )
  }

  if ((sale as any).is_host) {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Gavel size={16} /> Host controls are above.
        </p>
        <p className={styles.gateText}>
          You do not need a paddle in your own room. Use the host controls to reveal, hammer, pass, or end the sale.
        </p>
      </div>
    )
  }

  if (soldOut && !(sale as any).has_ticket) {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Lock size={16} /> Sold out.
        </p>
        <p className={styles.gateText}>
          This room has reached paddle capacity. You may still watch the broadcast if the house allows it.
        </p>
      </div>
    )
  }

  if ((sale as any).can_buy_ticket) {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Ticket size={16} /> Room access available.
        </p>

        <p className={styles.gateText}>
          {mode === 'invite'
            ? 'Your invitation allows you to claim a paddle for this room.'
            : mode === 'vip'
              ? 'VIP members may claim a paddle for this room.'
              : 'Claim a paddle to bid in this room.'}
        </p>

        <button className={styles.gateBtn} onClick={buyTicket} disabled={busy}>
          {busy
            ? 'Issuing…'
            : price > 0
              ? `Purchase paddle · ${formatMoney(price, currency)}`
              : 'Claim free paddle'}
        </button>

        {msg && <p className={styles.gateMsg}>{msg}</p>}
      </div>
    )
  }

  if (!(sale as any).has_ticket && mode === 'invite') {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Lock size={16} /> Invite only.
        </p>
        <p className={styles.gateText}>
          This floor opens solely to invited paddles. The house must issue your paddle before you can bid.
        </p>
      </div>
    )
  }

  if (!(sale as any).has_ticket && mode === 'vip' && !(sale as any).is_vip) {
    return (
      <div className={styles.gateCard}>
        <p className={styles.gateTitle}>
          <Crown size={16} /> VIP members only.
        </p>
        <p className={styles.gateText}>
          Bidding here is reserved for VIP members. You may watch every bid live.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}>
        <Gavel size={16} /> Watching only.
      </p>
      <p className={styles.gateText}>
        No lot is open for bidding right now. Paddles rise when the house reveals the next lot.
      </p>
    </div>
  )
}