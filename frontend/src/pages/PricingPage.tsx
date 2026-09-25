import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Crown, Check, ArrowLeft, Pause } from 'lucide-react'
import styles from './PricingPage.module.css'

const AUTH = 'http://localhost:8000'

// Only unlocks that genuinely exist in the build today.
const UNLOCKS = [
  'Bid inside VIP-only rooms — the crown gate opens for you.',
  'The VIP mark on your wall, your name, and your comments.',
  'A purple ring that collectors recognise across the floor.',
]

export function PricingPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''
  const tier = localStorage.getItem('space_tier') || 'standard'
  const isVip = tier === 'vip'

  // ---- all hooks top-level, before any conditional ----
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  async function upgrade(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setToast('')
    try {
      const res = await fetch(`${AUTH}/vip/upgrade`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer }),
      })
      const data = await res.json()
      if (data.error) { setToast(data.error); setBusy(false); return }
      localStorage.setItem('space_tier', 'vip')
      navigate('/auctions') // bar remounts and reads the new tier
    } catch {
      setToast('The server is unreachable.'); setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true); setToast('')
    try {
      await fetch(`${AUTH}/vip/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer }),
      })
      localStorage.setItem('space_tier', 'standard')
      navigate('/auctions')
    } catch {
      setToast('Could not reach the server.'); setBusy(false)
    }
  }

  return (
    <main className={styles.layout}>
      <div className={styles.shell}>
        <button className={styles.back} onClick={() => navigate(-1)}><ArrowLeft size={15} /> Back</button>

        <section className={styles.card}>
          <div className={styles.seal}><Crown size={22} fill={isVip ? 'currentColor' : 'none'} /></div>
          <p className={styles.kicker}>Membership</p>
          <h1 className={styles.title}>{isVip ? 'You hold the inner circle.' : 'Step behind the velvet rope.'}</h1>
          <p className={styles.lede}>
            {isVip
              ? 'Your membership is active. The crown rooms are open to you wherever you find them on the floor.'
              : 'Some rooms are reserved. Membership is the key — one status that travels with you across every house that gates its floor.'}
          </p>

          <ul className={styles.unlocks}>
            {UNLOCKS.map(u => (
              <li key={u} className={styles.unlock}><Check size={15} /> <span>{u}</span></li>
            ))}
          </ul>

          {isVip ? (
            <div className={styles.activeRow}>
              <span className={styles.activeBadge}><Crown size={13} fill="currentColor" /> VIP active</span>
              <button className={styles.quietBtn} onClick={cancel} disabled={busy}>
                <Pause size={13} /> {busy ? 'Pausing…' : 'Pause membership'}
              </button>
            </div>
          ) : (
            <form onSubmit={upgrade} className={styles.action}>
              <button className={styles.primary} type="submit" disabled={busy}>
                <Crown size={15} /> {busy ? 'Opening…' : 'Become a VIP'}
              </button>
            </form>
          )}

          {toast && <p className={styles.toast}>{toast}</p>}
          <p className={styles.fine}>
            Payments arrive with the Space Wallet — for now this is a mock upgrade, but it writes your real status,
            so the crown gates genuinely open. No card, no charge, fully reversible.
          </p>
        </section>
      </div>
    </main>
  )
}