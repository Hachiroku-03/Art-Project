import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Crown, Ticket, Bookmark, Gavel } from 'lucide-react'
import { fetchStanding, type Standing } from '../../lib/feed'
import { formatRemaining } from '../../lib/sales'
import { useNow } from '../../lib/useNow'
import styles from './PaddleCard.module.css'

function ts(raw: string | null) { return raw ? new Date(raw.replace(' ', 'T')).getTime() : Infinity }

export function PaddleCard({ viewer }: { viewer: string }) {
  const navigate = useNavigate()
  const now = useNow(1000)
  const [st, setSt] = useState<Standing | null>(null)

  useEffect(() => {
    let alive = true
    fetchStanding(viewer).then(d => { if (alive) setSt(d) })
    return () => { alive = false }
  }, [viewer])

  if (!st) return null
  const vip = st.tier === 'vip'
  const hasStuff = st.leading.length > 0 || st.tickets > 0 || st.collects > 0

  return (
    <div className={styles.card}>
      <p className={styles.head}>Your paddle</p>
      <span className={vip ? styles.vipOn : styles.std}><Crown size={12} fill={vip ? 'currentColor' : 'none'} />{vip ? 'VIP member' : 'Standard'}</span>

      {st.leading.length > 0 && (
        <div className={styles.block}>
          <p className={styles.blkHead}><Gavel size={11} /> Leading {st.leading.length} lot{st.leading.length > 1 ? 's' : ''}</p>
          {st.leading.slice(0, 2).map(l => {
            const rem = l.ends_at ? formatRemaining(ts(l.ends_at) - now) : ''
            return (
              <button key={l.lot_id} className={styles.lot} onClick={() => navigate(`/sales/${l.sale_id}`)}>
                <span className={styles.lotNm}>{l.title || 'Untitled lot'}</span>
                <span className={styles.lotSub}>{l.sale_title}{rem && ` · hammer ${rem}`}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className={styles.stats}>
        <span className={styles.stat}><Ticket size={12} /> {st.tickets} ticket{st.tickets !== 1 ? 's' : ''}</span>
        <span className={styles.stat}><Bookmark size={12} /> {st.collects} kept</span>
      </div>

      {!hasStuff && <p className={styles.invite}>Your paddle is empty — the floor is open.</p>}
    </div>
  )
}