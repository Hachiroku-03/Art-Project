import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, Loader2, X } from 'lucide-react'
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  routeFor,
  type AppNotification,
} from '../lib/notifications'
import styles from './NotificationBell.module.css'

function ago(raw?: string | null) {
  if (!raw) return ''
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function NotificationBell() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [count, setCount] = useState(0)
  const alive = useRef(true)
  const debounceRef = useRef<number | null>(null)

  const [open, setOpen] = useState(false)
  const [list, setList] = useState<AppNotification[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [markingAll, setMarkingAll] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Badge source of truth = the unified notifications unread count — the SAME
  // metric the dropdown rows and the /notifications page header use. (It used to
  // read fetchUnreadTotal from lib/chat, a different aggregate, which let the
  // badge disagree with the dots in this very component.) The live events below
  // are used strictly as TRIGGERS to recompute from here, never as the value, so
  // a burst of arrivals costs one recount and an async read has a beat to commit.
  const load = useCallback(async () => {
    if (!viewer) return
    try {
      const d = await fetchUnreadNotificationCount(viewer)
      if (alive.current && typeof d.count === 'number') setCount(d.count)
    } catch {
      // ignore
    }
  }, [viewer])

  const scheduleLoad = useCallback(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      if (alive.current) void load()
    }, 250)
  }, [load])

  const refreshList = useCallback(async () => {
    if (!viewer) return
    setListLoading(true)
    setListError('')
    try {
      const d = await fetchNotifications(viewer, { limit: 12 })
      if (!alive.current) return
      if (d.error) {
        setListError(d.error)
        setList([])
      } else {
        setList(d.notifications || [])
      }
    } catch {
      if (alive.current) {
        setListError('Could not load notifications.')
        setList([])
      }
    } finally {
      if (alive.current) setListLoading(false)
    }
  }, [viewer])

  const openPanel = useCallback(() => {
    setOpen(true)
    void refreshList()
  }, [refreshList])

  const closePanel = useCallback(() => setOpen(false), [])

  const togglePanel = useCallback(() => {
    if (open) closePanel()
    else openPanel()
  }, [open, closePanel, openPanel])

  const onItemClick = useCallback(
    (n: AppNotification) => {
      if (!n.read_at) {
        setList(prev =>
          prev.map(x => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
        )
        void markNotificationRead(viewer, n.id)
        void load()
      }

      const r = routeFor(n)
      closePanel()
      if (r.state) navigate(r.to, { state: r.state })
      else navigate(r.to)
    },
    [closePanel, load, navigate, viewer],
  )

  const onMarkAll = useCallback(async () => {
    if (!viewer) return
    setMarkingAll(true)
    setListError('')
    try {
      const d = await markAllNotificationsRead(viewer)
      if (d.error) {
        setListError(d.error)
        return
      }
      setList(prev =>
        prev.map(x => ({ ...x, read_at: x.read_at || new Date().toISOString() })),
      )
      void load()
    } finally {
      setMarkingAll(false)
    }
  }, [load, viewer])

  // Badge: poll + focus + visibility + legacy refresh + live signals (debounced).
  useEffect(() => {
    alive.current = true
    void load()

    const iv = window.setInterval(() => void load(), 45000)
    const onFocus = () => void load()
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const onRefresh = () => void load()
    const onLive = () => scheduleLoad()

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('notifications-refresh', onRefresh as EventListener)
    window.addEventListener('space:notification', onLive as EventListener)
    window.addEventListener('space:unread-count', onLive as EventListener)
    window.addEventListener('space:notification-read', onLive as EventListener)

    return () => {
      alive.current = false
      window.clearInterval(iv)
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('notifications-refresh', onRefresh as EventListener)
      window.removeEventListener('space:notification', onLive as EventListener)
      window.removeEventListener('space:unread-count', onLive as EventListener)
      window.removeEventListener('space:notification-read', onLive as EventListener)
    }
  }, [load, scheduleLoad])

  // While the panel is open, sync the list live from ToastHost's broadcasts.
  useEffect(() => {
    if (!open || !viewer) return

    const onNew = (event: Event) => {
      const n = (event as CustomEvent<AppNotification>).detail
      if (!n || typeof n.id !== 'number') return
      setList(prev => (prev.some(x => x.id === n.id) ? prev : [n, ...prev].slice(0, 30)))
    }

    const onRead = (event: Event) => {
      const id = (event as CustomEvent<number>).detail
      if (typeof id !== 'number') return
      setList(prev =>
        prev.map(x => (x.id === id ? { ...x, read_at: x.read_at || new Date().toISOString() } : x)),
      )
    }

    window.addEventListener('space:notification', onNew as EventListener)
    window.addEventListener('space:notification-read', onRead as EventListener)
    return () => {
      window.removeEventListener('space:notification', onNew as EventListener)
      window.removeEventListener('space:notification-read', onRead as EventListener)
    }
  }, [open, viewer])

  // Outside-click + Esc close. Attached only while open; the opening click is a
  // mousedown on the button (inside wrapRef) that fires before this listener
  // exists, so it never self-closes.
  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!viewer) return null

  const badge = count > 9 ? '9+' : String(count)
  const unreadRows = list.filter(n => !n.read_at).length

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={styles.btn}
        onClick={togglePanel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      >
        <Bell size={18} />
        {count > 0 && <span className={styles.badge}>{badge}</span>}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Recent notifications">
          <div className={styles.head}>
            <strong>Notifications</strong>

            <div className={styles.headActions}>
              <button
                onClick={() => void onMarkAll()}
                disabled={markingAll || unreadRows === 0}
                aria-label="Mark all read"
                title="Mark all read"
              >
                {markingAll ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <CheckCheck size={14} />
                )}
              </button>

              <button onClick={closePanel} aria-label="Close notifications" title="Close">
                <X size={15} />
              </button>
            </div>
          </div>

          {listError && <p className={styles.error}>{listError}</p>}

          <div className={styles.list}>
            {listLoading ? (
              <div className={styles.center}>
                <Loader2 size={18} className={styles.spin} />
              </div>
            ) : list.length === 0 ? (
              <p className={styles.empty}>No notifications yet.</p>
            ) : (
              list.map(n => {
                const unread = !n.read_at
                const label = n.actor_display || n.actor || n.title || '?'

                return (
                  <button
                    key={n.id}
                    className={`${styles.item} ${unread ? styles.itemUnread : ''}`}
                    onClick={() => onItemClick(n)}
                  >
                    <span className={styles.avatar}>
                      {n.actor_avatar ? (
                        <img src={n.actor_avatar} alt="" />
                      ) : (
                        label[0]?.toUpperCase() || '?'
                      )}
                    </span>

                    <span className={styles.mid}>
                      <span className={styles.top}>
                        <strong>{n.title}</strong>
                        <em>{ago(n.created_at)}</em>
                      </span>

                      {n.body && <span className={styles.body}>{n.body}</span>}
                    </span>

                    {unread && <span className={styles.dot} />}
                  </button>
                )
              })
            )}
          </div>

          <div className={styles.foot}>
            <button
              className={styles.footBtn}
              onClick={() => {
                closePanel()
                navigate('/notifications')
              }}
            >
              See all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  )
}