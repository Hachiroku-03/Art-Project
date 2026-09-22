import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Gavel, Radio, Eye, Image as ImageIcon } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { API, fetchSale, type Lot, type Sale } from '../lib/sales'
import styles from './ControlRoomPage.module.css'

export function ControlRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  if (!id) return <SalesDashboard viewer={viewer} />
  return <SaleControl saleId={id} viewer={viewer} navigate={navigate} />
}

/* ---------- dashboard: my sales + create ---------- */
function SalesDashboard({ viewer }: { viewer: string }) {
  const [sales, setSales] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [tier, setTier] = useState('open')
  const [starts, setStarts] = useState('')
  const navigate = useNavigate()

  async function load() {
    const res = await fetch(`${API}/my_sales?viewer=${encodeURIComponent(viewer)}`)
    const data = await res.json()
    setSales(data.sales || [])
  }
  useEffect(() => { load() }, [viewer])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const res = await fetch(`${API}/sales`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, title: title.trim(), tier, starts_at: starts ? new Date(starts).toISOString() : null }),
    })
    const data = await res.json()
    if (data.id) { setTitle(''); setStarts(''); load(); navigate(`/sales/${data.id}/control`) }
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.wrap}>
        <h1 className={styles.heading}>Control Room</h1>

        <form className={styles.card} onSubmit={create}>
          <p className={styles.cardTitle}><Plus size={15} /> Open a new sale</p>
          <input className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Sale title · e.g. Autumn Evening Sale" />
          <div className={styles.row}>
            <select className={styles.input} value={tier} onChange={e => setTier(e.target.value)}>
              <option value="open">Open floor</option>
              <option value="vip_only">VIP only</option>
              <option value="invite_only">Invite only</option>
            </select>
            <input className={styles.input} type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)} />
          </div>
          <button className={styles.primaryBtn} type="submit">Create sale</button>
        </form>

        <div className={styles.card}>
          <p className={styles.cardTitle}>Your sales</p>
          {sales.length === 0 && <p className={styles.muted}>No sales yet. Open your first one above.</p>}
          {sales.map(s => (
            <button key={s.id} className={styles.saleRow} onClick={() => navigate(`/sales/${s.id}/control`)}>
              <span className={styles.saleTitle}>{s.title}</span>
              <span className={styles.saleMeta}>{s.status} · {s.lot_count} lots</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}

/* ---------- per-sale control ---------- */
function SaleControl({ saleId, viewer, navigate }: { saleId: string; viewer: string; navigate: (p: string) => void }) {
  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [streamType, setStreamType] = useState('external')
  const [streamUrl, setStreamUrl] = useState('')
  const [peerId, setPeerId] = useState('')
  const [lotTitle, setLotTitle] = useState('')
  const [lotPrice, setLotPrice] = useState('')
  const [lotImage, setLotImage] = useState('')
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    const data = await fetchSale(saleId, viewer)
    if (data.sale) {
      setSale(data.sale)
      setLots(data.lots || [])
      setStreamType(data.sale.stream_type || 'external')
      setStreamUrl(data.sale.stream_url || '')
      setPeerId(data.sale.stream_peer_id || '')
    }
  }
  useEffect(() => { load() }, [saleId, viewer])

  async function post(url: string, body: any) {
    const res = await fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, ...body }) })
    const data = await res.json()
    setMsg(data.error || data.message || '')
    load()
    return data
  }

  async function saveStream() {
    await post(`/sales/${saleId}/stream`, { stream_type: streamType, stream_url: streamUrl, stream_peer_id: peerId })
  }

  async function uploadLotImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const form = new FormData(); form.append('file', file)
    const res = await fetch(`${API}/upload`, { method: 'POST', body: form })
    const data = await res.json()
    if (data.url) setLotImage(data.url)
    e.target.value = ''
  }

  async function addLot(e: FormEvent) {
    e.preventDefault()
    if (!lotTitle.trim()) return
    await post(`/sales/${saleId}/lots`, { title: lotTitle.trim(), starting_price: lotPrice || 0, image_url: lotImage })
    setLotTitle(''); setLotPrice(''); setLotImage('')
  }

  if (sale && !sale.is_host) {
    return (
      <main className={styles.layout}><Navbar />
        <p className={styles.muted} style={{ textAlign: 'center', marginTop: '6rem' }}>Only the house sees behind the curtain.</p>
      </main>
    )
  }

  const onBlockExists = lots.some(l => l.status === 'on_block')

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.wrap}>
        <button className={styles.backBtn} onClick={() => navigate('/sales/control')}><ArrowLeft size={16} /> All sales</button>
        <h1 className={styles.heading}>{sale?.title || '…'}</h1>
        <p className={styles.statusLine}>
          status: <strong>{sale?.status}</strong> · tier: <strong>{sale?.tier}</strong>
          {sale?.starts_at && <> · starts {new Date(sale.starts_at.replace(' ', 'T')).toLocaleString()}</>}
        </p>
        {msg && <p className={styles.msg}>{msg}</p>}

        {sale?.status === 'upcoming' && (
          <button className={styles.primaryBtn} onClick={() => post(`/sales/${saleId}/go_live`, {})}>
            <Radio size={15} /> Go live now
          </button>
        )}

        <div className={styles.card}>
          <p className={styles.cardTitle}><Radio size={15} /> Broadcast</p>
          <div className={styles.row}>
            <button className={`${styles.chip} ${streamType === 'external' ? styles.chipOn : ''}`} onClick={() => setStreamType('external')}>External link</button>
            <button className={`${styles.chip} ${streamType === 'internal' ? styles.chipOn : ''}`} onClick={() => setStreamType('internal')}>Internal camera</button>
          </div>
          {streamType === 'external' ? (
            <input className={styles.input} value={streamUrl} onChange={e => setStreamUrl(e.target.value)} placeholder="YouTube / Twitch live embed URL" />
          ) : (
            <div className={styles.row}>
              <input className={styles.input} value={peerId} readOnly placeholder="peer id" />
              <button className={styles.chip} onClick={() => setPeerId(`space-${Math.random().toString(36).slice(2, 8)}`)}>Generate</button>
            </div>
          )}
          <button className={styles.primaryBtn} onClick={saveStream}>Save broadcast</button>
          <p className={styles.muted}>Internal camera streaming switches on with the viewer room phase.</p>
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}><Eye size={15} /> The block</p>
          {lots.length === 0 && <p className={styles.muted}>No lots yet. Add the first one below.</p>}
          {lots.map(l => (
            <div key={l.id} className={styles.lotRow}>
              <span className={styles.lotPos}>#{l.position}</span>
              <span className={styles.lotTitle}>{l.status === 'sealed' ? 'Sealed lot' : l.title}</span>
              <span className={`${styles.lotBadge} ${styles[`lot_${l.status}`]}`}>{l.status.replace('_', ' ')}</span>
              {l.status === 'on_block' && <span className={styles.lotBid}>${l.current_bid || l.starting_price}</span>}
              {l.status === 'sold' && <span className={styles.lotBid}>sold ${l.sold_price}</span>}
              {l.status === 'sealed' && !onBlockExists && (
                <button className={styles.miniBtn} onClick={() => post(`/sales/${saleId}/reveal_next`, {})}>Put on block</button>
              )}
              {l.status === 'on_block' && (
                <button className={styles.miniBtn} onClick={() => post(`/lots/${l.id}/hammer`, {})}><Gavel size={12} /> Hammer</button>
              )}
            </div>
          ))}
        </div>

        <form className={styles.card} onSubmit={addLot}>
          <p className={styles.cardTitle}><Plus size={15} /> Add a lot</p>
          <input className={styles.input} value={lotTitle} onChange={e => setLotTitle(e.target.value)} placeholder="Lot title" />
          <input className={styles.input} value={lotPrice} onChange={e => setLotPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="Starting price" inputMode="decimal" />
          <button type="button" className={styles.chip} onClick={() => fileRef.current?.click()}>
            <ImageIcon size={14} /> {lotImage ? 'Image attached ✓' : 'Attach image'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={uploadLotImage} />
          <button className={styles.primaryBtn} type="submit">Add lot</button>
        </form>
      </div>
    </main>
  )
}