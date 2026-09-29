import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Check, Loader2, X } from 'lucide-react'
import {
  fetchNotifications,
  fetchUnreadTotal,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '../lib/chat'
import styles from './NotificationBell.module.css'

function parseDate(raw?: string | null) {
  if (!raw) return new Date(NaN)
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
}

function fromNow(raw?: string | null) {
  const d = parseDate(raw)
  if (isNaN(d.getTime())) return ''

  const s = Math.round((Date.now() - d.getTime()) / 1000)

  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`

  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function firstLetter(name?: string | null) {
  return (name || '?')[0]?.toUpperCase() || '?'
}

export function NotificationBell() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const rootRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)

  const load = useCallback(
    async (loadList: boolean) => {
      if (!viewer) return

      setLoading(true)
      setError('')

      try {
        const total = await fetchUnreadTotal(viewer)

        if (alive.current) {
          setCount(Number(total.notifications || 0))
        }

        if (loadList) {
          const rows = await fetchNotifications(viewer, false, 30)

          if (alive.current) {
            setItems(rows)
          }
        }
      } catch {
        if (alive.current) {
          setError('Could not load notifications.')
        }
      } finally {
        if (alive.current) {
          setLoading(false)
        }
      }
    },
    [viewer],
  )

  useEffect(() => {
    alive.current = true

    void load(true)

    const interval = window.setInterval(() => {
      void load(false)
    }, 45000)

    const onFocus = () => {
      void load(false)
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load(false)
      }
    }

    const onRefresh = () => {
      void load(true)
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('notifications-refresh', onRefresh as EventListener)

    return () => {
      alive.current = false

      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('notifications-refresh', onRefresh as EventListener)
    }
  }, [load])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const el = event.target as Node | null

      if (el && rootRef.current && !rootRef.current.contains(el)) {
        setOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const openNotification = useCallback(
    async (n: NotificationItem) => {
      if (n.conversation_id == null) {
        setOpen(false)
        return
      }

      if (!n.read_at) {
        setBusy(true)

        try {
          const d = await markNotificationRead(viewer, n.id)

          if (!d.error) {
            const now = new Date().toISOString()

            setItems(prev =>
              prev.map(x =>
                x.id === n.id
                  ? {
                      ...x,
                      read_at: now,
                    }
                  : x,
              ),
            )

            setCount(c => Math.max(0, c - 1))
            window.dispatchEvent(new Event('notifications-refresh'))
          }
        } catch {
          // still open chat even if mark-read fails
        } finally {
          setBusy(false)
        }
      }

      setOpen(false)

      const convId = Number(n.conversation_id)

      navigate('/messenger', {
        state: {
          openConversationId: convId,
        },
      })

      window.dispatchEvent(
        new CustomEvent('open-chat', {
          detail: convId,
        }),
      )
    },
    [navigate, viewer],
  )

  const markAll = useCallback(async () => {
    if (!viewer || count === 0) return

    setBusy(true)
    setError('')

    try {
      const d = await markAllNotificationsRead(viewer)

      if (d.error) {
        setError(d.error)
        return
      }

      const now = new Date().toISOString()

      setItems(prev =>
        prev.map(n =>
          n.read_at
            ? n
            : {
                ...n,
                read_at: now,
              },
        ),
      )

      setCount(0)
      window.dispatchEvent(new Event('notifications-refresh'))
    } catch {
      setError('Could not mark notifications read.')
    } finally {
      setBusy(false)
    }
  }, [count, viewer])

  if (!viewer) return null

  const badge = count > 9 ? '9+' : String(count)

  return (
    <div className={styles.wrap} ref={rootRef}>
      <button
        className={styles.btn}
        onClick={() => {
          const next = !open
          setOpen(next)

          if (next) {
            void load(true)
          }
        }}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell size={18} />

        {count > 0 && <span className={styles.badge}>{badge}</span>}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.head}>
            <strong>Notifications</strong>

            <div className={styles.headActions}>
              <button
                onClick={() => void markAll()}
                disabled={busy || count === 0}
                title="Mark all read"
                aria-label="Mark all read"
              >
                <Check size={14} />
                <span>Mark all</span>
              </button>

              <button
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close notifications"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.list}>
            {loading && items.length === 0 ? (
              <div className={styles.center}>
                <Loader2 size={18} className={styles.spin} />
              </div>
            ) : items.length === 0 ? (
              <p className={styles.empty}>No notifications yet.</p>
            ) : (
              items.map(n => {
                const unread = !n.read_at

                return (
                  <button
                    key={n.id}
                    className={`${styles.item} ${unread ? styles.itemUnread : ''}`}
                    onClick={() => void openNotification(n)}
                    disabled={busy}
                  >
                    <span className={styles.avatar}>
                      {firstLetter(n.title)}
                    </span>

                    <span className={styles.mid}>
                      <span className={styles.top}>
                        <strong>{n.title || 'Notification'}</strong>
                        <em>{fromNow(n.created_at)}</em>
                      </span>

                      <span className={styles.body}>
                        {n.body || 'New activity'}
                      </span>
                    </span>

                    {unread && <span className={styles.dot} />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}