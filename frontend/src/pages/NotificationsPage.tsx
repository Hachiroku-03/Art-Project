import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  AtSign,
  CheckCheck,
  Info,
  Inbox,
  Loader2,
  MessageSquare,
  Users,
  X,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '../lib/chat'
import styles from './NotificationsPage.module.css'

type Kind = 'all' | 'unread' | 'message' | 'mention' | 'group_invite' | 'system'

const KIND_ORDER: { key: Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'message', label: 'Messages' },
  { key: 'mention', label: 'Mentions' },
  { key: 'group_invite', label: 'Group invites' },
  { key: 'system', label: 'System' },
]

const META: Record<string, { icon: typeof MessageSquare; label: string; className: string }> = {
  message: {
    icon: MessageSquare,
    label: 'Message',
    className: styles.iconMessage,
  },
  mention: {
    icon: AtSign,
    label: 'Mention',
    className: styles.iconMention,
  },
  group_invite: {
    icon: Users,
    label: 'Group invite',
    className: styles.iconInvite,
  },
  system: {
    icon: Info,
    label: 'System',
    className: styles.iconSystem,
  },
}

function parseDate(raw?: string | null) {
  if (!raw) return new Date(NaN)
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
}

function ts(raw?: string | null) {
  const d = parseDate(raw)
  return isNaN(d.getTime()) ? 0 : d.getTime()
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

export function NotificationsPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kind, setKind] = useState<Kind>('all')

  const alive = useRef(true)

  const load = useCallback(async () => {
    if (!viewer) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    try {
      const rows = await fetchNotifications(viewer, false, 100)

      rows.sort((a, b) => ts(b.created_at) - ts(a.created_at))

      if (alive.current) {
        setItems(rows)
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
  }, [viewer])

  useEffect(() => {
    alive.current = true

    void load()

    const onRefresh = () => {
      void load()
    }

    window.addEventListener('notifications-refresh', onRefresh as EventListener)

    return () => {
      alive.current = false
      window.removeEventListener('notifications-refresh', onRefresh as EventListener)
    }
  }, [load])

  const counts = useMemo(() => {
    return {
      all: items.length,
      unread: items.filter(n => !n.read_at).length,
      message: items.filter(n => n.type === 'message').length,
      mention: items.filter(n => n.type === 'mention').length,
      group_invite: items.filter(n => n.type === 'group_invite').length,
      system: items.filter(n => n.type === 'system').length,
    } satisfies Record<Kind, number>
  }, [items])

  const visible = useMemo(() => {
    if (kind === 'all') return items
    if (kind === 'unread') return items.filter(n => !n.read_at)
    return items.filter(n => n.type === kind)
  }, [items, kind])

  const openItem = useCallback(
    (n: NotificationItem) => {
      const unread = !n.read_at

      if (unread) {
        void markNotificationRead(viewer, n.id)
      }

      if (n.conversation_id != null) {
        navigate('/messenger', {
          state: {
            openConversationId: n.conversation_id,
          },
        })
      } else if (unread) {
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
      }

      window.dispatchEvent(new Event('notifications-refresh'))
    },
    [navigate, viewer],
  )

  const markAll = useCallback(async () => {
    if (!viewer || counts.unread === 0) return

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

      window.dispatchEvent(new Event('notifications-refresh'))
    } catch {
      setError('Could not mark notifications read.')
    } finally {
      setBusy(false)
    }
  }, [counts.unread, viewer])

  const emptyText =
    kind === 'unread'
      ? 'No unread notifications.'
      : kind === 'message'
        ? 'No message notifications.'
        : kind === 'mention'
          ? 'No mentions yet.'
          : kind === 'group_invite'
            ? 'No group invites.'
            : kind === 'system'
              ? 'No system notifications yet.'
              : 'No notifications yet.'

  return (
    <main className={styles.page}>
      <Navbar />

      <div className={styles.inner}>
        <div className={styles.topbar}>
          <button
            className={styles.back}
            onClick={() => navigate('/messenger')}
            aria-label="Back to messenger"
          >
            <ArrowLeft size={18} /> Messenger
          </button>

          <button
            className={styles.markAll}
            onClick={() => void markAll()}
            disabled={busy || counts.unread === 0}
          >
            <CheckCheck size={15} /> Mark all read
          </button>
        </div>

        <h1 className={styles.heading}>Notifications</h1>

        <div className={styles.chips} role="tablist" aria-label="Notification kinds">
          {KIND_ORDER.map(k => {
            const n = counts[k.key]
            const on = kind === k.key

            return (
              <button
                key={k.key}
                role="tab"
                aria-selected={on}
                className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                onClick={() => setKind(k.key)}
              >
                <span>{k.label}</span>
                {n > 0 && <span className={styles.chipCount}>{n}</span>}
              </button>
            )
          })}
        </div>

        {error && (
          <p className={styles.error}>
            {error}
            <button onClick={() => setError('')} aria-label="Dismiss">
              <X size={13} />
            </button>
          </p>
        )}

        <div className={styles.list}>
          {loading ? (
            <div className={styles.center}>
              <Loader2 size={20} className={styles.spin} />
            </div>
          ) : visible.length === 0 ? (
            <div className={styles.emptyWrap}>
              <Inbox size={30} />
              <p>{emptyText}</p>
            </div>
          ) : (
            visible.map(n => {
              const meta = META[n.type] || META.system
              const Icon = meta.icon
              const unread = !n.read_at

              return (
                <button
                  key={n.id}
                  className={`${styles.row} ${unread ? styles.rowUnread : ''}`}
                  onClick={() => openItem(n)}
                >
                  <span className={`${styles.icon} ${meta.className}`}>
                    <Icon size={16} />
                  </span>

                  <span className={styles.mid}>
                    <span className={styles.top}>
                      <strong>{n.title || meta.label}</strong>
                      <em>{fromNow(n.created_at)}</em>
                    </span>

                    <span className={styles.body}>{n.body || meta.label}</span>
                  </span>

                  {unread && <span className={styles.dot} />}
                </button>
              )
            })
          )}
        </div>
      </div>
    </main>
  )
}