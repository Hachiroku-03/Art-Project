import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API, formatRemaining, type Sale } from '../../lib/sales'
import { useNow } from '../../lib/useNow'
import styles from './ProgrammeRail.module.css'

function ts(raw: string | null) { return raw ? new Date(raw.replace(' ', 'T')).getTime() : Infinity }
// plain fn, not an as-const object indexed by a string — keeps TS happy regardless of how Sale['status'] is typed
const rankOf = (s: string) => (s === 'live' ? 0 : s === 'upcoming' ? 1 : 2)

export function ProgrammeRail({ viewer }: { viewer: string }) {
  const navigate = useNavigate()
  const now = useNow(1000)
  const [rooms, setRooms] = useState<Sale[]>([])

  useEffect(() => {
    let alive = true
    fetch(`${API}/sales?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        const list = ((d.sales || []) as Sale[]).filter(s => s.status !== 'ended')
        setRooms([...list].sort((a, b) =>
          (rankOf(a.status) - rankOf(b.status)) ||
          ((a.status === 'live' ? ts(a.ends_at) : ts(a.starts_at)) - (b.status === 'live' ? ts(b.ends_at) : ts(b.starts_at)))
        ))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [viewer])

  if (rooms.length === 0) return <p className={styles.quiet}>No rooms on the calendar.</p>

  return (
    <div className={styles.rail}>
      <p className={styles.head}>The Programme</p>
      {rooms.slice(0, 6).map(s => {
        const live = s.status === 'live'
        const target = live ? ts(s.ends_at) : ts(s.starts_at)
        const rem = target === Infinity ? '' : formatRemaining(target - now)
        return (
          <button key={s.id} className={styles.row} onClick={() => navigate(`/sales/${s.id}`)}>
            <span className={`${styles.bar} ${live ? styles.barLive : ''}`} />
            <span className={styles.mid}>
              <span className={styles.nm}>{s.title}</span>
              <span className={styles.sub}>@{s.host_username} · {live ? 'on air' : 'upcoming'}</span>
            </span>
            <span className={styles.time}>{live ? 'hammer' : 'opens'}<br /><b>{rem || '—'}</b></span>
          </button>
        )
      })}
    </div>
  )
}