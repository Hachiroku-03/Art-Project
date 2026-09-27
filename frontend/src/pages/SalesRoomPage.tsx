import { useEffect, useState, useRef, type FormEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Lock, Gavel, Radio, Ticket, Crown, ShieldCheck } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { API, fetchSale, fetchLotBids, type Sale, type Lot, type LotBid } from '../lib/sales'
import styles from './SalesRoomPage.module.css'

export function SalesRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- existing state ----
  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [activeLot, setActiveLot] = useState<Lot | null>(null)
  const [bids, setBids] = useState<LotBid[]>([])
  const [loading, setLoading] = useState(true)
  const [countdown, setCountdown] = useState('')
  const [bidAmount, setBidAmount] = useState('')
  const [bidError, setBidError] = useState('')
  const [bidding, setBidding] = useState(false)
  const lastBidId = useRef(0)

  // ---- GATE state: declared at the very top, above every early return ----
  const storeKey = id ? `paddle:${id}` : ''
  const [locked, setLocked] = useState(false)
  const [hasTicket, setHasTicket] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [gateError, setGateError] = useState('')
  const [claiming, setClaiming] = useState(false)

  async function load(withCode?: string) {
    const data = await fetchSale(id!, viewer, withCode)
    if (data.sale) {
      setSale(data.sale)
      setLocked(!!data.sale.locked && !data.sale.is_host)
      setHasTicket(!!data.sale.has_ticket)
      setLots(data.lots || [])
    }
    setLoading(false)
  }

  // 1. Initial load — present any saved paddle immediately so return visits skip the door
  useEffect(() => {
    if (!id) return
    setLoading(true)
    load(sessionStorage.getItem(storeKey) || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, viewer])

  // 2. Countdown (only meaningful once unlocked)
  useEffect(() => {
    if (locked || !sale || sale.status !== 'upcoming' || !sale.starts_at) return
    const target = new Date(sale.starts_at.replace(' ', 'T')).getTime()
    const tick = () => {
      const diff = target - Date.now()
      if (diff <= 0) { setCountdown('00:00:00'); load(sessionStorage.getItem(storeKey) || undefined) }
      else {
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0')
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0')
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0')
        setCountdown(`${h}:${m}:${s}`)
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)   // cleared on every change — Strict-Mode safe
  }, [locked, sale?.starts_at, sale?.status, id, viewer])

  // 3. Poll lot status (guarded by !locked)
  useEffect(() => {
    if (locked || !sale || sale.status !== 'live') return
    const interval = setInterval(async () => {
      const data = await fetchSale(id!, viewer, sessionStorage.getItem(storeKey) || undefined)
      if (data.sale) setLots(data.lots || [])
    }, 3000)
    return () => clearInterval(interval)
  }, [locked, sale?.status, id, viewer])

  // 4. Detect active lot & clear ledger
  useEffect(() => {
    const onBlock = lots.find(l => l.status === 'on_block')
    if (onBlock?.id !== activeLot?.id) { setActiveLot(onBlock || null); setBids([]); lastBidId.current = 0 }
  }, [lots])

  // 5. Poll live bids (guarded by !locked)
  useEffect(() => {
    if (locked || !activeLot) return
    const interval = setInterval(async () => {
      const fresh = await fetchLotBids(activeLot.id, lastBidId.current)
      if (fresh.length > 0) { lastBidId.current = fresh[fresh.length - 1].id; setBids(prev => [...fresh.reverse(), ...prev]) }
    }, 1500)
    return () => clearInterval(interval)
  }, [locked, activeLot?.id])

  async function claimPaddle() {
    setClaiming(true); setGateError('')
    try {
      const res = await fetch(`${API}/sales/${id}/ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
      const data = await res.json()
      if (data.error) { setGateError(data.error); return }
      sessionStorage.setItem(storeKey, data.code)
      setCodeInput(data.code)
      await load(data.code)            // unlocks; the code was shown once above
    } catch { setGateError('Network error') }
    setClaiming(false)
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault(); setCodeBusy(true); setGateError('')
    try {
      const res = await fetch(`${API}/sales/${id}/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, code: codeInput.trim() }) })
      const data = await res.json()
      if (data.ok) { sessionStorage.setItem(storeKey, codeInput.trim()); await load(codeInput.trim()) }
      else setGateError(data.error || 'Could not verify that paddle.')   // server-authored: "Tickets are unique to one account."
    } catch { setGateError('Network error') }
    setCodeBusy(false)
  }

  async function placeBid(e: FormEvent) {
    e.preventDefault()
    if (!activeLot || !sale) return
    const val = parseFloat(bidAmount)
    const floor = Math.max(parseFloat(activeLot.current_bid || '0'), parseFloat(activeLot.starting_price || '0'))
    if (!val || val <= floor) { setBidError(`Bid must exceed $${floor}`); return }
    setBidding(true); setBidError('')
    try {
      const res = await fetch(`${API}/lots/${activeLot.id}/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, amount: val }) })
      const data = await res.json()
      if (data.id) { setBids(prev => [{ id: data.id, user_name: viewer, amount: String(data.amount), created_at: new Date().toISOString() }, ...prev]); setBidAmount('') }
      else setBidError(data.error || 'Bid failed')
    } catch { setBidError('Network error') }
    setBidding(false)
  }

  // ---- early returns (every hook is above this line) ----
  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>
  if (!sale) return <main className={styles.layout}><Navbar /><p style={{ textAlign: 'center', marginTop: '4rem' }}>Sale not found.</p></main>

  // THE DOOR (locked) — takes precedence over curtain & live
  if (locked) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1.2rem' }}>
          <div style={{ width: '100%', maxWidth: 380, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 18, padding: '1.8rem 1.6rem', boxShadow: '0 24px 60px rgba(20,18,15,0.10)', textAlign: 'center' }}>
            <div style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(14,14,14,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem', color: 'var(--ink)' }}>
              {hasTicket ? <ShieldCheck size={22} /> : <Ticket size={22} />}
            </div>
            <h2 style={{ fontFamily: 'var(--font-label)', fontStyle: 'italic', fontWeight: 500, fontSize: '1.4rem', marginBottom: '0.4rem' }}>{sale.title}</h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--ink-soft)', lineHeight: 1.55, marginBottom: '1.2rem' }}>
              {hasTicket
                ? "You hold a paddle for this room. Enter its number to take your seat."
                : "This floor requires a paddle. Claim yours to receive a unique number."}
            </p>

            {hasTicket ? (
              <form onSubmit={submitCode} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <input value={codeInput} onChange={e => setCodeInput(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" maxLength={6} placeholder="Paddle number"
                  style={{ width: '100%', textAlign: 'center', letterSpacing: '0.3em', fontFamily: 'var(--font-display)', fontSize: '1.2rem', padding: '0.7rem', borderRadius: 12, border: '1px solid var(--line)', background: '#f7f6f3', outline: 'none' }} />
                <button type="submit" disabled={codeBusy || codeInput.length < 6}
                  style={{ background: 'var(--ink)', color: 'var(--wall)', border: 'none', borderRadius: 999, padding: '0.7rem 1.4rem', fontFamily: 'var(--font-ui)', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer', opacity: (codeBusy || codeInput.length < 6) ? 0.5 : 1 }}>
                  {codeBusy ? 'Checking…' : 'Take my seat'}
                </button>
              </form>
            ) : (
              <button onClick={claimPaddle} disabled={claiming}
                style={{ background: 'var(--ink)', color: 'var(--wall)', border: 'none', borderRadius: 999, padding: '0.7rem 1.4rem', fontFamily: 'var(--font-ui)', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer', opacity: claiming ? 0.5 : 1 }}>
                {claiming ? 'Issuing…' : (sale.ticket_price && parseFloat(sale.ticket_price) > 0 ? `Claim paddle · $${sale.ticket_price}` : 'Claim my paddle')}
              </button>
            )}

            {gateError && <p style={{ marginTop: '0.9rem', fontSize: '0.82rem', color: 'var(--err)' }}>{gateError}</p>}
            {hasTicket && !gateError && <p style={{ marginTop: '0.9rem', fontSize: '0.72rem', color: 'var(--ink-faint)', fontStyle: 'italic', fontFamily: 'var(--font-label)' }}>Lost your number? Paddle recovery arrives with the wallet.</p>}
            <button onClick={() => navigate('/auctions')} style={{ marginTop: '1.2rem', background: 'none', border: 'none', color: 'var(--ink-faint)', fontSize: '0.72rem', letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer' }}>Back to the floor</button>
          </div>
        </div>
      </main>
    )
  }

  // THE CURTAIN
  if (sale.status === 'upcoming' && countdown !== '00:00:00') {
    return (
      <main className={styles.curtainLayout}>
        <Navbar />
        <div className={styles.curtain}>
          <p className={styles.curtainLabel}>THE AUCTION WILL START IN</p>
          <h1 className={styles.curtainTime}>{countdown}</h1>
        </div>
      </main>
    )
  }

  const currentPrice = activeLot?.current_bid || activeLot?.starting_price || '0'

  // THE LIVE ROOM (unchanged from your version)
  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.room}>
        <header className={styles.topBar}>
          <button className={styles.backBtn} onClick={() => navigate('/auctions')}><ArrowLeft size={18} /></button>
          <span className={styles.livePill}><i /> LIVE · {sale.title}</span>
        </header>
        <div className={styles.streamBox}>
          {sale.stream_type === 'external' && sale.stream_url ? (
            <iframe src={sale.stream_url} className={styles.streamFrame} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          ) : (
            <div className={styles.streamPlaceholder}><Radio size={32} /><p>Waiting for the house to start the broadcast...</p></div>
          )}
        </div>
        <div className={styles.carousel}>
          {lots.map(lot => (
            <div key={lot.id} className={`${styles.lotCard} ${lot.status === 'on_block' ? styles.lotActive : ''} ${lot.status === 'sold' ? styles.lotSold : ''}`}>
              {lot.status === 'sealed' ? (
                <div className={styles.lotSealed}><Lock size={20} /><span>Lot {lot.position}</span></div>
              ) : (
                <>
                  {lot.image_url ? <img src={lot.image_url} alt={lot.title} className={styles.lotImg} /> : <div className={styles.lotImgBlank} />}
                  <div className={styles.lotInfo}>
                    <span className={styles.lotTitle}>{lot.title}</span>
                    {lot.status === 'sold' && <span className={styles.soldStamp}>SOLD ${lot.sold_price}</span>}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className={styles.bidContainer}>
          <div className={styles.currentRow}>
            <span className={styles.currentLabel}>Current bid {activeLot ? `· Lot ${activeLot.position}` : ''}</span>
            <span className={styles.currentAmount}>${currentPrice}</span>
          </div>
          {!activeLot ? (
            <p className={styles.watchOnly}>Waiting for the house to put the next lot on the block...</p>
          ) : sale.can_bid ? (
            <form className={styles.bidForm} onSubmit={placeBid}>
              <input className={styles.bidInput} value={bidAmount} onChange={e => setBidAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={`Your paddle · min $${parseFloat(currentPrice) + 1}`} inputMode="decimal" />
              <button className={styles.bidBtn} type="submit" disabled={bidding}><Gavel size={14} /> Raise Paddle</button>
            </form>
          ) : sale.can_buy_ticket ? (
            <div className={styles.gateCard}><p className={styles.gateTitle}><Ticket size={16} /> You've been invited.</p><p className={styles.gateText}>Claim your paddle to bid on this private lot.</p><button className={styles.gateBtn} onClick={claimPaddle}><Ticket size={14} /> Claim Paddle{sale.ticket_price && parseFloat(sale.ticket_price) > 0 ? ` · $${sale.ticket_price}` : ''}</button></div>
          ) : sale.needs_ticket ? (
            <div className={styles.gateCard}><p className={styles.gateTitle}><Lock size={16} /> Invite only.</p><p className={styles.gateText}>This floor opens solely to invited paddles. You may watch the broadcast.</p></div>
          ) : sale.tier === 'vip_only' && !sale.is_vip ? (
            <div className={styles.gateCard}><p className={styles.gateTitle}><Crown size={16} /> VIP members only.</p><p className={styles.gateText}>Bidding is reserved for VIP members.</p></div>
          ) : (
            <p className={styles.watchOnly}>You are watching this lot.</p>
          )}
          {bidError && <p className={styles.bidError}>{bidError}</p>}
          <div className={styles.ledgerHead}><span>Bid Ledger</span>{activeLot && <span className={styles.ledgerLive}><i /> updating live</span>}</div>
          <div className={styles.ledger}>
            {bids.length === 0 ? <p className={styles.ledgerEmpty}>The floor is quiet. Awaiting the first paddle.</p> : bids.map(b => (
              <div key={b.id} className={styles.ledgerRow}><span className={styles.ledgerUser}>{b.user_name}</span><span className={styles.ledgerAmount}>${b.amount}</span></div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}