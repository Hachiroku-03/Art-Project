import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Landmark } from 'lucide-react'
import { API } from '../../lib/sales'
import { fetchSuggestions, type Suggestion } from '../../lib/feed'
import styles from './SuggestionsRail.module.css'

export function SuggestionsRail({ viewer }: { viewer: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<Suggestion[]>([])
  const [followed, setFollowed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    fetchSuggestions(viewer).then(d => { if (alive) setItems(d) })
    return () => { alive = false }
  }, [viewer])

  async function follow(u: string) {
    const r = await fetch(`${API}/follow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, target: u }) }).then(x => x.json()).catch(() => ({}))
    setFollowed(p => ({ ...p, [u]: !!r.following }))
  }

  if (items.length === 0) return <p className={styles.quiet}>No new houses to find yet.</p>

  return (
    <div className={styles.rail}>
      <p className={styles.head}>Who to know</p>
      {items.map(s => {
        const on = followed[s.username] ?? false
        const initial = (s.display_name || s.username)[0]?.toUpperCase()
        return (
          <div key={s.username} className={styles.row}>
            <button className={styles.ava} onClick={() => navigate(`/profile/${s.username}`)}>{initial}</button>
            <button className={styles.info} onClick={() => navigate(`/profile/${s.username}`)}>
              <span className={styles.nm}>{s.display_name || s.username}</span>
              <span className={styles.sub}>@{s.username} {s.role === 'house' && <Landmark size={10} />} · {s.follower_count} followers</span>
            </button>
            <button className={`${styles.btn} ${on ? styles.btnOn : ''}`} onClick={() => follow(s.username)}>{on ? 'Following' : 'Follow'}</button>
          </div>
        )
      })}
    </div>
  )
}