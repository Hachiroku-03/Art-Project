import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Crown, Check, ArrowLeft, CalendarClock, AlertTriangle, ArrowUpRight } from 'lucide-react'
import { fetchVipStatus, fmtMoney, fmtDate, type VipStatus } from '../lib/wallet'
import styles from './PricingPage.module.css'

const AUTH = 'http://localhost:8000'
const UNLOCKS = [
  'Bid inside VIP-only rooms — the crown gate opens for you.',
  'The VIP mark on your wall, your name, and your comments.',
  'A purple ring that collectors recognise across the floor.',
]

export function PricingPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- all hooks top-level, above any return ----
  const [st, setSt] = useState<VipStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [needFunds, setNeedFunds] = useState(false)

  const reload = useCallback(() => {
    fetchVipStatus(viewer).then(s => {
      setSt(s)
      if (s) localStorage.setItem('space_tier', s.tier)   // keep the navbar pill honest after a sweep
    })
  }, [viewer])
  useEffect(() => { reload() }, [reload])

  const sub = st?.subscription ?? null
  const isVip = !!st?.vip
  const price = useMemo(() => parseFloat(String(st?.price ?? 20)) || 20, [st])
  const balance = useMemo(() => parseFloat(st?.balance || '0') || 0, [st])
  const willCancel = !!sub?.cancelled_at && sub?.status === 'active'
  const pastDue = sub?.status === 'past_due'
  const short = Math.max(0, price - balance)

  async function post(path: string) {
    setToast(''); setNeedFunds(false); setBusy(true)
    try {
      const res = await fetch(`${AUTH}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
      const d = await res.json()
      setBusy(false)
      if (d.error) { setToast(d.error); if (/insufficient/i.test(d.error)) setNeedFunds(true); return false }
      if (d.tier) localStorage.setItem('space_tier', d.tier)
      reload()
      return true
    } catch { setBusy(false); setToast('The server is unreachable.'); return false }
  }

  return (
    <main className={styles.layout}>
      <div className={styles.shell}>
        <button className={styles.back} onClick={() => navigate(-1)}><ArrowLeft size={15} /> Back</button>

        <section className={styles.card}>
          <div className={styles.seal}><Crown size={22} fill={isVip ? 'currentColor' : 'none'} /></div>
          <p className={styles.kicker}>Monthly membership</p>
          <h1 className={styles.title}>
            {isVip ? (willCancel ? 'Your circle ends soon.' : 'You hold the inner circle.') : 'Step behind the velvet rope.'}
          </h1>
          <p className={styles.lede}>
            {isVip
              ? (willCancel
                  ? `Membership is active through ${fmtDate(sub?.renews_at)}, then it ends. Resume any time before then — free, you've already paid for it.`
                  : `Active. ${fmtMoney(price)} is drawn from your wallet on ${fmtDate(sub?.renews_at)} each month, wherever your balance allows.`)
              : `${fmtMoney(price)} per month, debited from your wallet. Some rooms are reserved; membership is the key that travels with you across every house that gates its floor.`}
          </p>

          <ul className={styles.unlocks}>
            {UNLOCKS.map(u => (<li key={u} className={styles.unlock}><Check size={15} /> <span>{u}</span></li>))}
          </ul>

          {isVip && sub && (
            <div className={styles.balanceRow}>
              <span className={styles.balanceLabel}><CalendarClock size={12} /> {willCancel ? 'Ends' : 'Renews'}</span>
              <span className={styles.balanceVal}>{fmtDate(sub.renews_at)}</span>
            </div>
          )}
          {!isVip && (
            <div className={styles.balanceRow}>
              <span className={styles.balanceLabel}>Wallet balance</span>
              <span className={styles.balanceVal}>{st ? fmtMoney(balance) : '—'}</span>
            </div>
          )}

          {pastDue && (
            <p className={styles.warn}><AlertTriangle size={14} /> Renewal failed — {sub?.failure_reason || 'insufficient balance'}. Top up to resume, or rejoin below.</p>
          )}

          {isVip ? (
            <div className={styles.action}>
              {willCancel ? (
                <button className={styles.primary} onClick={() => post('/vip/upgrade')} disabled={busy}>
                  <Crown size={15} /> {busy ? 'Resuming…' : 'Resume membership'}
                </button>
              ) : (
                <button className={styles.quietBtn} onClick={() => post('/vip/cancel')} disabled={busy}>
                  Cancel at period end
                </button>
              )}
            </div>
          ) : (
            <div className={styles.action}>
              <button className={styles.primary} onClick={() => post('/vip/upgrade')} disabled={busy || !st}>
                <Crown size={15} /> {busy ? 'Charging…' : `Become a VIP · ${fmtMoney(price)} / month`}
              </button>
            </div>
          )}

          {needFunds && (
            <button className={styles.topupLink} onClick={() => navigate('/wallet')}>
              Short by {fmtMoney(short)} — add funds in your wallet <ArrowUpRight size={13} />
            </button>
          )}
          {toast && !needFunds && <p className={styles.toast}>{toast}</p>}

          <p className={styles.fine}>
            Top-ups are mock credits (no gateway yet), but every charge is a real ledger entry — if your balance can't cover a
            renewal, membership lapses to <em>past&nbsp;due</em> and the crown gate closes. Cancelling keeps your access through
            the paid period and never refunds.
          </p>
        </section>
      </div>
    </main>
  )
}