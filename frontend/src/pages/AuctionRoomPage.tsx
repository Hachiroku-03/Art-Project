import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Lock, Radio } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { AuctionHeader } from '../components/auctions/AuctionHeader'
import { TicketGate } from '../components/auctions/TicketGate'
import { BidPanel } from '../components/auctions/BidPanel'
import { fetchSale, fetchLotBids, type Sale, type Lot, type LotBid } from '../lib/sales'
import styles from './AuctionRoomPage.module.css'

export function AuctionRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [activeLot, setActiveLot] = useState<Lot | null>(null)
  const [bids, setBids] = useState<LotBid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState('')
  const lastBidId = useRef(0)

  async function loadSale() {
    try {
      const data = await fetchSale(id!, viewer)
      if (data.sale) { setSale(data.sale); setLots(data.lots || []) }
      else setError(data.error || 'not found')
    } catch { setError('network error - is the feed server running?') }
  }

  useEffect(() => {
    if (!id) return
    let alive = true
    loadSale().then(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, viewer])

  // THE CURTAIN countdown
  useEffect(() => {
    if (!sale || sale.status !== 'upcoming' || !sale.starts_at) return
    const target = new Date(sale.starts_at.replace(' ', 'T')).getTime()
    const tick = () => {
      const diff = target - Date.now()
      if (diff <= 0) { setCountdown('00:00:00'); loadSale(); return }
      const h = Math.floor(diff / 3600000).toString().padStart(2, '0')
      const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0')
      const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0')
      setCountdown(`${h}:${m}:${s}`)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [sale?.status, sale?.starts_at])

  // poll lot statuses while live
  useEffect(() => {
    if (!sale || sale.status !== 'live') return
    const t = setInterval(loadSale, 3000)
    return () => clearInterval(t)
  }, [sale?.status, id])

  // active lot detection + ledger reset
  useEffect(() => {
    const onBlock = lots.find(l => l.status === 'on_block') ?? null
    if (onBlock?.id !== activeLot?.id) {
      setActiveLot(onBlock)
      setBids([])
      lastBidId.current = 0
    }
  }, [lots])

  // ledger: initial + live polling
  useEffect(() => {
    if (!activeLot) return
    let alive = true
    fetchLotBids(activeLot.id, 0).then(list => {
      if (!alive) return
      if (list.length) lastBidId.current = list[list.length - 1].id
      setBids([...list].reverse())
    })
    const t = setInterval(async () => {
      const fresh = await fetchLotBids(activeLot.id, lastBidId.current)
      if (fresh.length > 0 && alive) {
        lastBidId.current = fresh[fresh.length - 1].id
        setBids(prev => [...[...fresh].reverse(), ...prev])
      }
    }, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [activeLot?.id])

  function handleMyBid(b: LotBid) {
    lastBidId.current = Math.max(lastBidId.current, b.id)
    setBids(prev => [b, ...prev])
    setLots(prev => prev.map(l => l.id === activeLot?.id
      ? { ...l, current_bid: b.amount, bid_count: (l.bid_count || 0) + 1 }
      : l))
  }

  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>

  if (!sale) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.gateCard} style={{ maxWidth: 480, margin: '6rem auto' }}>
          <p className={styles.gateTitle}><Lock size={16} /> {error || 'This room is private.'}</p>
          <button className={styles.gateBtn} onClick={() => navigate('/auctions')}>Back to the floor</button>
        </div>
      </main>
    )
  }

  // THE CURTAIN — before the sale, only the timer exists
  if (sale.status === 'upcoming') {
    return (
      <main className={styles.curtainLayout}>
        <Navbar />
        <div className={styles.curtain}>
          <p className={styles.curtainLabel}>The auction will start in</p>
          <h1 className={styles.curtainTime}>{countdown || '—'}</h1>
          <p className={styles.curtainSub}>{sale.title} · @{sale.host_username}</p>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.room}>

        <div className={styles.topBar}>
          <button className={styles.backBtn} onClick={() => navigate('/auctions')} aria-label="Back to floor">
            <ArrowLeft size={18} />
          </button>
          <span className={styles.watching}><i /> {sale.status === 'live' ? 'watching live' : 'archive'}</span>
        </div>

        {/* THE STREAM — dominant, full width */}
        <div className={styles.streamBox}>
          {sale.stream_type === 'external' && sale.stream_url ? (
            <iframe
              className={styles.streamFrame}
              src={sale.stream_url}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              title="Live broadcast"
            />
          ) : (
            <div className={styles.streamPlaceholder}>
              <Radio size={30} />
              <p>The house has not opened the broadcast yet.</p>
            </div>
          )}
        </div>

        <AuctionHeader sale={sale} totalLots={lots.length} activeLot={activeLot} />

        {/* CHAPTERS — the catalogue strip */}
        <div className={styles.chapters}>
          {lots.map(lot => (
            <div
              key={lot.id}
              className={`${styles.chapter} ${lot.status === 'on_block' ? styles.chapterActive : ''} ${lot.status === 'sold' ? styles.chapterSold : ''}`}
            >
              {lot.status === 'sealed' ? (
                <div className={styles.chapterSealed}><Lock size={16} /><span>Lot {lot.position}</span></div>
              ) : (
                <>
                  {lot.image_url ? <img className={styles.chapterImg} src={lot.image_url} alt={lot.title} /> : <div className={styles.chapterImgBlank} />}
                  <span className={styles.chapterTitle}>{lot.title}</span>
                  {lot.status === 'sold' && <span className={styles.soldStamp}>SOLD</span>}
                </>
              )}
            </div>
          ))}
        </div>

        {/* PADDLE OR GATE */}
        {activeLot && sale.status === 'live' && sale.can_bid ? (
          <BidPanel lot={activeLot} viewer={viewer} onBid={handleMyBid} />
        ) : (
          <TicketGate sale={sale} viewer={viewer} onRefresh={loadSale} />
        )}

        {/* THE LEDGER */}
        <div className={styles.ledgerHead}>
          <span className={styles.ledgerTitle}>Bid ledger {activeLot ? `· Lot ${activeLot.position}` : ''}</span>
          {sale.status === 'live' && <span className={styles.ledgerLive}><i /> updating live</span>}
        </div>
        <div className={styles.ledger}>
          {!activeLot ? (
            <p className={styles.ledgerEmpty}>No lot on the block. The floor awaits.</p>
          ) : bids.length === 0 ? (
            <p className={styles.ledgerEmpty}>No bids yet on this lot.</p>
          ) : (
            bids.map((b, i) => (
              <div key={b.id} className={`${styles.ledgerRow} ${i === 0 ? styles.ledgerLead : ''}`}>
                <span className={styles.ledgerUser}>{b.user_name}</span>
                <span className={styles.ledgerAmount}>${b.amount}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  )
}