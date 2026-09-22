import { useState } from 'react'
import { Crown, Lock, Ticket } from 'lucide-react'
import { API, type Sale } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

type Props = { sale: Sale; viewer: string; onRefresh: () => void }

export function TicketGate({ sale, viewer, onRefresh }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function buyTicket() {
    setBusy(true)
    try {
      const res = await fetch(`${API}/sales/${sale.id}/ticket`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }),
      })
      const data = await res.json()
      setMsg(data.message ? `Paddle secured for $${data.price}.` : data.error || '')
      onRefresh()
    } catch { setMsg('Could not reach the box office.') }
    setBusy(false)
  }

  if (sale.status === 'ended') return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}>The hammer fell.</p>
      <p className={styles.gateText}>This sale has closed. The ledger below is the official record.</p>
    </div>
  )
  if (sale.can_buy_ticket) return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}><Ticket size={16} /> You've been invited to this private sale.</p>
      <p className={styles.gateText}>Your invitation grants the privilege to purchase a paddle. Paddles are bound to your account — they cannot be shared or transferred.</p>
      <button className={styles.gateBtn} onClick={buyTicket} disabled={busy}>
        {busy ? 'Issuing…' : `Purchase paddle · $${sale.ticket_price}`}
      </button>
      {msg && <p className={styles.gateMsg}>{msg}</p>}
    </div>
  )
  if (sale.needs_ticket) return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}><Lock size={16} /> Invite only.</p>
      <p className={styles.gateText}>This floor opens solely to invited paddles. You may watch the broadcast.</p>
    </div>
  )
  if (sale.tier === 'vip_only' && !sale.is_vip) return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}><Crown size={16} /> VIP members only.</p>
      <p className={styles.gateText}>Bidding here is reserved for VIP members. You may watch every bid live.</p>
    </div>
  )
  return (
    <div className={styles.gateCard}>
      <p className={styles.gateTitle}>Watching only.</p>
      <p className={styles.gateText}>No lot is on the block right now. Paddles rise when the house reveals the next one.</p>
    </div>
  )
}