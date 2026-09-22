import { useEffect, useState, useRef, type FormEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Lock, Gavel, Radio, Ticket, Crown } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { API, fetchSale, fetchLotBids, type Sale, type Lot, type LotBid } from '../lib/sales'
import styles from './SalesRoomPage.module.css'

export function SalesRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

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

  // 1. Initial Load
  useEffect(() => {
    if (!id) return
    async function load() {
      const data = await fetchSale(id!, viewer)
      if (data.sale) {
        setSale(data.sale)
        setLots(data.lots || [])
      }
      setLoading(false)
    }
    load()
  }, [id, viewer])

  // 2. Countdown Timer (Before the sale starts)
  useEffect(() => {
    if (!sale || sale.status !== 'upcoming' || !sale.starts_at) return
    const target = new Date(sale.starts_at.replace(' ', 'T')).getTime()
    
    const tick = () => {
      const diff = target - Date.now()
      if (diff <= 0) {
        setCountdown('00:00:00')
        // Auto-refresh when it hits zero to show the live room
        fetchSale(id!, viewer).then(data => {
          if (data.sale) { setSale(data.sale); setLots(data.lots || []) }
        })
      } else {
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0')
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0')
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0')
        setCountdown(`${h}:${m}:${s}`)
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [sale?.starts_at, sale?.status, id, viewer])

  // 3. Poll for Lot Status Changes (Every 3s while live)
  useEffect(() => {
    if (!sale || sale.status !== 'live') return
    const interval = setInterval(async () => {
      const data = await fetchSale(id!, viewer)
      if (data.sale) setLots(data.lots || [])
    }, 3000)
    return () => clearInterval(interval)
  }, [sale?.status, id, viewer])

  // 4. Detect Active Lot & Clear Ledger
  useEffect(() => {
    const onBlock = lots.find(l => l.status === 'on_block')
    if (onBlock?.id !== activeLot?.id) {
      setActiveLot(onBlock || null)
      setBids([])
      lastBidId.current = 0
    }
  }, [lots])

  // 5. Poll Live Bids (Every 1.5s while a lot is on the block)
  useEffect(() => {
    if (!activeLot) return
    const interval = setInterval(async () => {
      const fresh = await fetchLotBids(activeLot.id, lastBidId.current)
      if (fresh.length > 0) {
        lastBidId.current = fresh[fresh.length - 1].id
        setBids(prev => [...fresh.reverse(), ...prev])
      }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeLot?.id])

  async function placeBid(e: FormEvent) {
    e.preventDefault()
    if (!activeLot || !sale) return
    const val = parseFloat(bidAmount)
    const floor = Math.max(
      parseFloat(activeLot.current_bid || '0'), 
      parseFloat(activeLot.starting_price || '0')
    )
    
    if (!val || val <= floor) {
      setBidError(`Bid must exceed $${floor}`)
      return
    }
    
    setBidding(true); setBidError('')
    try {
      const res = await fetch(`${API}/lots/${activeLot.id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, amount: val })
      })
      const data = await res.json()
      if (data.id) {
        setBids(prev => [{ id: data.id, user_name: viewer, amount: String(data.amount), created_at: new Date().toISOString() }, ...prev])
        setBidAmount('')
      } else {
        setBidError(data.error || 'Bid failed')
      }
    } catch { setBidError('Network error') }
    setBidding(false)
  }

  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>
  if (!sale) return <main className={styles.layout}><Navbar /><p style={{textAlign:'center', marginTop:'4rem'}}>Sale not found.</p></main>

  // THE CURTAIN (Before the sale starts)
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

  // THE LIVE ROOM
  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.room}>
        
        <header className={styles.topBar}>
          <button className={styles.backBtn} onClick={() => navigate('/auctions')}><ArrowLeft size={18} /></button>
          <span className={styles.livePill}><i /> LIVE · {sale.title}</span>
        </header>

        {/* THE STREAMING SCREEN */}
        <div className={styles.streamBox}>
          {sale.stream_type === 'external' && sale.stream_url ? (
            <iframe 
              src={sale.stream_url} 
              className={styles.streamFrame}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
              allowFullScreen
            />
          ) : (
            <div className={styles.streamPlaceholder}>
              <Radio size={32} />
              <p>Waiting for the house to start the broadcast...</p>
            </div>
          )}
        </div>

        {/* THE CAROUSEL (The Catalogue) */}
        <div className={styles.carousel}>
          {lots.map(lot => (
            <div key={lot.id} className={`${styles.lotCard} ${lot.status === 'on_block' ? styles.lotActive : ''} ${lot.status === 'sold' ? styles.lotSold : ''}`}>
              {lot.status === 'sealed' ? (
                <div className={styles.lotSealed}>
                  <Lock size={20} />
                  <span>Lot {lot.position}</span>
                </div>
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

        {/* THE BID CONTAINER & LEDGER */}
        <div className={styles.bidContainer}>
          <div className={styles.currentRow}>
            <span className={styles.currentLabel}>Current bid {activeLot ? `· Lot ${activeLot.position}` : ''}</span>
            <span className={styles.currentAmount}>${currentPrice}</span>
          </div>

          {/* THE VELVET ROPE (Ticket Gate Logic) */}
          {!activeLot ? (
            <p className={styles.watchOnly}>Waiting for the house to put the next lot on the block...</p>
          ) : sale.can_bid ? (
            // ALLOWED TO BID (Open, VIP in VIP room, or Ticket Holder in Invite room)
            <form className={styles.bidForm} onSubmit={placeBid}>
              <input 
                className={styles.bidInput} 
                value={bidAmount} 
                onChange={e => setBidAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder={`Your paddle · min $${parseFloat(currentPrice) + 1}`}
                inputMode="decimal"
              />
              <button className={styles.bidBtn} type="submit" disabled={bidding}>
                <Gavel size={14} /> Raise Paddle
              </button>
            </form>
          ) : sale.can_buy_ticket ? (
            // INVITED BUT NO PADDLE YET
            <div className={styles.gateCard}>
              <p className={styles.gateTitle}><Ticket size={16} /> You've been invited.</p>
              <p className={styles.gateText}>Purchase your paddle to bid on this private lot.</p>
              <button 
                className={styles.gateBtn} 
                onClick={async () => {
                  const res = await fetch(`${API}/auctions/${sale.id}/ticket`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({viewer}) });
                  const data = await res.json();
                  if (data.message) window.location.reload(); // Refresh to update access flags
                }}
              >
                Purchase Paddle · ${sale.ticket_price}
              </button>
            </div>
          ) : sale.needs_ticket ? (
            // INVITE ONLY, NOT INVITED
            <div className={styles.gateCard}>
              <p className={styles.gateTitle}><Lock size={16} /> Invite only.</p>
              <p className={styles.gateText}>This floor opens solely to invited paddles. You may watch the broadcast.</p>
            </div>
          ) : sale.tier === 'vip_only' && !sale.is_vip ? (
            // VIP ONLY, NOT VIP
            <div className={styles.gateCard}>
              <p className={styles.gateTitle}><Crown size={16} /> VIP members only.</p>
              <p className={styles.gateText}>Bidding is reserved for VIP members. Upgrade in settings to participate.</p>
            </div>
          ) : (
            <p className={styles.watchOnly}>You are watching this lot.</p>
          )}
          
          {bidError && <p className={styles.bidError}>{bidError}</p>}

          <div className={styles.ledgerHead}>
            <span>Bid Ledger</span>
            {activeLot && <span className={styles.ledgerLive}><i /> updating live</span>}
          </div>

          <div className={styles.ledger}>
            {bids.length === 0 ? (
              <p className={styles.ledgerEmpty}>The floor is quiet. Awaiting the first paddle.</p>
            ) : (
              bids.map(b => (
                <div key={b.id} className={styles.ledgerRow}>
                  <span className={styles.ledgerUser}>{b.user_name}</span>
                  <span className={styles.ledgerAmount}>${b.amount}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  )
}