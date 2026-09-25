import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API, type Sale } from '../../lib/sales'
import styles from './LiveStrip.module.css'

export function LiveStrip({ viewer }: { viewer: string }) {
  const navigate = useNavigate()
  const [live, setLive] = useState<Sale[]>([])

  useEffect(() => {
    let alive = true
    fetch(`${API}/sales?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => { if (alive) setLive(((d.sales || []) as Sale[]).filter(s => s.status === 'live')) })
      .catch(() => {})
    return () => { alive = false }
  }, [viewer])

  if (live.length === 0) return null   // no pulse when nothing is on air

  return (
    <div className={styles.strip}>
      <span className={styles.label}>On air</span>
      <div className={styles.row}>
        {live.map(s => (
          <button key={s.id} className={styles.item} onClick={() => navigate(`/sales/${s.id}`)} title={s.title}>
            <span className={styles.ring}><span className={styles.dot} />{(s.host_username || '?')[0]?.toUpperCase()}</span>
            <span className={styles.name}>{s.host_username}</span>
          </button>
        ))}
      </div>
    </div>
  )
}