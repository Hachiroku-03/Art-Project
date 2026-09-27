import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  X,
  Plus,
  Ticket,
  Crown,
  Copy,
  Check,
  ArrowUpRight,
  AlertTriangle,
  Wallet as WalletIcon,
} from 'lucide-react'
import { ErrorBoundary } from './ErrorBoundary'
import {
  fetchWallet,
  fetchPaddles,
  topUp,
  fmtMoney,
  fmtDate,
  type WalletData,
  type Paddle,
} from '../lib/wallet'
import styles from './WalletPanel.module.css'

type Tab = 'overview' | 'topup' | 'paddles'

const KIND_LABEL: Record<string, string> = {
  top_up: 'Added funds',
  vip_upgrade: 'VIP membership',
  vip_renewal: 'VIP renewal',
  ticket_purchase: 'Paddle',
  refund: 'Refund',
  payout: 'House payout',
  commission: 'Commission',
}

export function WalletPanel({ viewer, onClose }: { viewer: string; onClose?: () => void }) {
  const navigate = useNavigate()

  // ---- all hooks, top level, above any return (Rules of Hooks) ----
  const [tab, setTab] = useState<Tab>('overview')
  const [wallet, setWallet] = useState<WalletData | null>(null)
  const [paddles, setPaddles] = useState<Paddle[]>([])
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const copyTimer = useRef<number | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    Promise.all([fetchWallet(viewer), fetchPaddles(viewer)]).then(([w, p]) => {
      setWallet(w)
      setPaddles(p)
      setLoading(false)
    })
  }, [viewer])

  useEffect(() => {
    reload()
  }, [reload])

  // Clear the copy-timeout on unmount. This is the only timer in the panel,
  // and it is cleaned up so Strict Mode / fast unmount cannot setState late.
  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const balance = useMemo(() => parseFloat(wallet?.balance || '0') || 0, [wallet])
  const sub = wallet?.subscription ?? null
  const isVip = wallet?.tier === 'vip'
  const pastDue = sub?.status === 'past_due'
  const willCancel = !!sub?.cancelled_at && sub?.status === 'active'

  const membershipAction = isVip
    ? sub
      ? willCancel
        ? `Ends ${fmtDate(sub.renews_at)}`
        : `Renews ${fmtDate(sub.renews_at)}`
      : 'Manage'
    : pastDue
      ? 'Resume'
      : `Upgrade · ${fmtMoney(wallet?.vip_price)}/mo`

  const headerDetail =
    isVip && sub
      ? willCancel
        ? `ends ${fmtDate(sub.renews_at)}`
        : `renews ${fmtDate(sub.renews_at)}`
      : 'mock top‑ups, real ledger'

  async function handleTopUp(e: React.FormEvent) {
    e.preventDefault()
    setNote('')
    const v = parseFloat(amount)
    if (!v || v <= 0) {
      setNote('Enter an amount.')
      return
    }

    setBusy(true)
    const d = await topUp(viewer, v)
    setBusy(false)

    if (d.error) {
      setNote(d.error)
      return
    }

    setAmount('')
    setNote(`Added ${fmtMoney(d.added)} to your balance.`)
    reload()
  }

  function copyCode(p: Paddle) {
    navigator.clipboard
      ?.writeText(p.code)
      .then(() => {
        setCopied(p.auction_id)
        if (copyTimer.current) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => {
          setCopied(c => (c === p.auction_id ? null : c))
        }, 1500)
      })
      .catch(() => {})
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div>
          <p className={styles.kicker}>
            <WalletIcon size={12} /> The Space Wallet
          </p>
          <p className={styles.balance}>{loading ? '—' : fmtMoney(balance)}</p>
          <p className={styles.sub}>
            {isVip ? (
              <span className={styles.vipChip}>
                <Crown size={11} fill="currentColor" /> VIP
              </span>
            ) : pastDue ? (
              <span className={styles.warnChip}>
                <AlertTriangle size={11} /> Past due
              </span>
            ) : (
              'Standard member'
            )}
            {' · '}
            {headerDetail}
          </p>
        </div>
        {onClose && (
          <button className={styles.close} onClick={onClose} aria-label="Close wallet">
            <X size={18} />
          </button>
        )}
      </div>

      <div className={styles.tabs}>
        {(['overview', 'topup', 'paddles'] as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabOn : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'topup' ? 'Top up' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className={styles.body}>
          <div className={styles.rowBetween}>
            <span className={styles.label}>Membership</span>
            <button
              className={styles.linkBtn}
              onClick={() => {
                onClose?.()
                navigate('/pricing')
              }}
            >
              {membershipAction} <ArrowUpRight size={12} />
            </button>
          </div>

          {pastDue && (
            <p className={styles.warn}>
              <AlertTriangle size={13} />
              <span>
                {sub?.failure_reason || 'Renewal failed'} —{' '}
                <button className={styles.inlineLink} onClick={() => setTab('topup')}>
                  add funds
                </button>{' '}
                to resume.
              </span>
            </p>
          )}

          <div className={styles.divider} />
          <p className={styles.label}>History</p>

          {/* Boundary around the LIST, never per row (Error-Boundary granularity rule). */}
          <ErrorBoundary fallback={<p className={styles.quiet}>The ledger is resting.</p>}>
            {loading ? (
              <p className={styles.quiet}>Reading your statement…</p>
            ) : wallet && wallet.entries.length > 0 ? (
              <div className={styles.ledger}>
                {wallet.entries.map(en => {
                  const num = parseFloat(en.amount)
                  const pos = num >= 0
                  return (
                    <div key={en.id} className={styles.entry}>
                      <div className={styles.entryMid}>
                        <span className={styles.entryKind}>{KIND_LABEL[en.kind] || en.kind}</span>
                        {en.reference && <span className={styles.entryRef}>{en.reference}</span>}
                      </div>
                      <span className={`${styles.entryAmt} ${pos ? styles.pos : styles.neg}`}>
                        {pos ? '+' : '−'}
                        {fmtMoney(Math.abs(num))}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className={styles.quiet}>No movements yet. Top up to open an account.</p>
            )}
          </ErrorBoundary>
        </div>
      )}

      {tab === 'topup' && (
        <form className={styles.body} onSubmit={handleTopUp}>
          <p className={styles.label}>Add funds</p>
          <p className={styles.hint}>
            No payment gateway yet — this writes a real credit row so you can spend against the
            true ledger.
          </p>

          <div className={styles.quick}>
            {[10, 25, 50, 100].map(q => (
              <button
                key={q}
                type="button"
                className={styles.quickBtn}
                onClick={() => setAmount(String(q))}
              >
                ${q}
              </button>
            ))}
          </div>

          <div className={styles.inputRow}>
            <span className={styles.prefix}>$</span>
            <input
              className={styles.input}
              value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>

          {note && <p className={styles.note}>{note}</p>}

          <button className={styles.submit} type="submit" disabled={busy}>
            <Plus size={14} /> {busy ? 'Adding…' : 'Add funds'}
          </button>
        </form>
      )}

      {tab === 'paddles' && (
        <div className={styles.body}>
          <p className={styles.label}>My paddles</p>
          <p className={styles.hint}>
            Your unique numbers, for re‑entering a room on a new device. One paddle, one account.
          </p>

          {/* Boundary around the LIST, never per row. */}
          <ErrorBoundary fallback={<p className={styles.quiet}>The paddle desk is resting.</p>}>
            {loading ? (
              <p className={styles.quiet}>Fetching…</p>
            ) : paddles.length > 0 ? (
              <div className={styles.paddles}>
                {paddles.map(p => (
                  <div key={p.auction_id} className={styles.paddle}>
                    <div className={styles.paddleMid}>
                      <span className={styles.paddleTitle}>{p.title}</span>
                      <span className={styles.paddleSub}>
                        <span className={`${styles.statusDot} ${p.status === 'live' ? styles.live : ''}`} />
                        @{p.host_username} · {p.status}
                      </span>
                    </div>

                    <button className={styles.code} onClick={() => copyCode(p)} title="Copy paddle number">
                      {copied === p.auction_id ? <Check size={13} /> : <Copy size={13} />}
                      <span className={styles.codeNum}>{p.code}</span>
                    </button>

                    <button
                      className={styles.enterBtn}
                      onClick={() => {
                        onClose?.()
                        navigate(`/sales/${p.auction_id}`)
                      }}
                      aria-label="Enter room"
                    >
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.quiet}>
                <Ticket size={13} /> No paddles yet — the floor is open.
              </p>
            )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}