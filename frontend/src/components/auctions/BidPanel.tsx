import { useState, type FormEvent } from 'react'
import { Gavel } from 'lucide-react'
import { API, type Lot, type LotBid } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

type Props = { lot: Lot; viewer: string; onBid: (b: LotBid) => void }

export function BidPanel({ lot, viewer, onBid }: Props) {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const floor = Math.max(parseFloat(lot.current_bid || '0'), parseFloat(lot.starting_price || '0'))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const val = parseFloat(amount)
    if (!val || val <= floor) { setError(`Bid must exceed $${floor}`); return }
    setBusy(true); setError('')
    try {
      const res = await fetch(`${API}/lots/${lot.id}/bid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, amount: val }),
      })
      const data = await res.json()
      if (data.id) {
        onBid({ id: data.id, user_name: viewer, amount: String(data.amount), created_at: new Date().toISOString() })
        setAmount('')
      } else setError(data.error || 'Bid failed.')
    } catch { setError('Could not reach the floor.') }
    setBusy(false)
  }

  return (
    <form className={styles.paddleBox} onSubmit={submit}>
      <div className={styles.paddleTop}>
        <span className={styles.paddleLabel}>Current bid · Lot {lot.position} "{lot.title}"</span>
        <span className={styles.paddleAmount}>${lot.current_bid || lot.starting_price}</span>
      </div>
      <div className={styles.paddleRow}>
        <input
          className={styles.paddleInput}
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={`Your paddle · min $${floor + 1}`}
          inputMode="decimal"
        />
        <button className={styles.paddleBtn} type="submit" disabled={busy}><Gavel size={14} /> Raise paddle</button>
      </div>
      {error && <p className={styles.paddleError}>{error}</p>}
    </form>
  )
}