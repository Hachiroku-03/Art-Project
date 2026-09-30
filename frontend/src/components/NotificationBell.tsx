import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { fetchUnreadTotal } from '../lib/chat'
import styles from './NotificationBell.module.css'

export function NotificationBell() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''
  const [count, setCount] = useState(0)
  const alive = useRef(true)

  const load = useCallback(async () => {
    if (!viewer) return
    try {
      const t = await fetchUnreadTotal(viewer)
      if (alive.current) setCount(Number(t.notifications || 0))
    } catch {
      // ignore
    }
  }, [viewer])

  useEffect(() => {
    alive.current = true
    void load()

    const iv = window.setInterval(() => void load(), 45000)
    const onFocus = () => void load()
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const onRefresh = () => void load()

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('notifications-refresh', onRefresh as EventListener)

    return () => {
      alive.current = false
      window.clearInterval(iv)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('notifications-refresh', onRefresh as EventListener)
    }
  }, [load])

  if (!viewer) return null

  const badge = count > 9 ? '9+' : String(count)

  return (
    <button
      className={styles.btn}
      onClick={() => navigate('/notifications')}
      aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
    >
      <Bell size={18} />
      {count > 0 && <span className={styles.badge}>{badge}</span>}
    </button>
  )
}