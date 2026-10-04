import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AtSign,
  Bell,
  CheckCheck,
  FileText,
  Gavel,
  Info,
  Loader2,
  MessageCircle,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import {
  deleteNotification,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  routeFor as routeForNotification,
  type AppNotification,
  type NotificationCategory,
} from '../lib/notifications'
import styles from './NotificationsPage.module.css'

type FilterKey = 'all' | 'unread' | NotificationCategory

const FILTERS: {
  key: FilterKey
  label: string
  icon: ComponentType<{ size?: number }>
}[] = [
  { key: 'all', label: 'All', icon: Bell },
  { key: 'unread', label: 'Unread', icon: CheckCheck },
  { key: 'messages', label: 'Messages', icon: MessageCircle },
  { key: 'mentions', label: 'Mentions', icon: AtSign },
  { key: 'groups', label: 'Groups', icon: Users },
  { key: 'posts', label: 'Posts', icon: FileText },
  { key: 'auctions', label: 'Auctions', icon: Gavel },
  { key: 'wallet', label: 'Wallet', icon: Wallet },
  { key: 'security', label: 'Security', icon: ShieldCheck },
  { key: 'system', label: 'System', icon: Info },
]

function parseDate(raw?: string | null) {
  if (!raw) return new Date(NaN)
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
}

function timeAgo(raw?: string | null) {
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

function categoryMeta(category: string): {
  label: string
  icon: ComponentType<{ size?: number }>
  className: string
} {
  switch (category) {
    case 'messages':
      return { label: 'Message', icon: MessageCircle, className: styles.catMessages }
    case 'mentions':
      return { label: 'Mention', icon: AtSign, className: styles.catMentions }
    case 'groups':
      return { label: 'Group', icon: Users, className: styles.catGroups }
    case 'posts':
      return { label: 'Post', icon: FileText, className: styles.catPosts }
    case 'auctions':
      return { label: 'Auction', icon: Gavel, className: styles.catAuctions }
    case 'wallet':
      return { label: 'Wallet', icon: Wallet, className: styles.catWallet }
    case 'security':
      return { label: 'Security', icon: ShieldCheck, className: styles.catSecurity }
    default:
      return { label: 'System', icon: Info, className: styles.catSystem }
  }
}


function Avatar({
  src,
  name,
}: {
  src?: string | null
  name?: string | null
}) {
  return (
    <span className={styles.avatar}>
      {src ? <img src={src} alt="" /> : firstLetter(name)}
    </span>
  )
}

export function NotificationsPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [filter, setFilter] = useState<FilterKey>('all')
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [markingAll, setMarkingAll] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refreshUnreadCount = useCallback(async () => {
    if (!viewer) return

    const d = await fetchUnreadNotificationCount(viewer)

    if (!d.error && typeof d.count === 'number') {
      setUnreadCount(d.count)
    }
  }, [viewer])

  const load = useCallback(
    async (mode: 'replace' | 'append' = 'replace', beforeId = 0) => {
      if (!viewer) {
        setNotifications([])
        setLoading(false)
        return
      }

      if (mode === 'replace') {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }

      setError('')

      try {
        const res = await fetchNotifications(viewer, {
          category: filter === 'unread' ? 'all' : filter,
          unreadOnly: filter === 'unread',
          limit: 40,
          beforeId: mode === 'append' ? beforeId : 0,
        })

        if (res.error) {
          setError(res.error)
          setNotifications([])
          setHasMore(false)
          return
        }

        const rows = res.notifications || []

        setNotifications(prev => (mode === 'append' ? [...prev, ...rows] : rows))
        setHasMore(!!res.has_more)
      } catch {
        setError('Could not load notifications.')
        setNotifications([])
        setHasMore(false)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [filter, viewer],
  )

  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      navigate('/login', { replace: true })
      return
    }

    void load('replace', 0)
    void refreshUnreadCount()
  }, [load, navigate, refreshUnreadCount])

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || !notifications.length) return

    const oldest = notifications[notifications.length - 1]?.id
    if (!oldest) return

    void load('append', oldest)
  }, [hasMore, load, loadingMore, notifications])

  const openNotification = useCallback(
    (n: AppNotification) => {
      if (!n.read_at) {
        setNotifications(prev =>
          filter === 'unread'
            ? prev.filter(x => x.id !== n.id)
            : prev.map(x =>
                x.id === n.id
                  ? {
                      ...x,
                      read_at: new Date().toISOString(),
                    }
                  : x,
              ),
        )

        setUnreadCount(prev => Math.max(0, prev - 1))

        void markNotificationRead(viewer, n.id)
      }

      const route = routeForNotification(n)

      if (route.state) {
        navigate(route.to, { state: route.state })
      } else {
        navigate(route.to)
      }
    },
    [filter, navigate, viewer],
  )

  const removeNotification = useCallback(
    async (n: AppNotification, e: React.MouseEvent) => {
      e.stopPropagation()

      if (!viewer) return

      setBusyId(n.id)
      setError('')

      try {
        const d = await deleteNotification(viewer, n.id)

        if (d.error) {
          setError(d.error)
          return
        }

        if (!n.read_at) {
          setUnreadCount(prev => Math.max(0, prev - 1))
        }

        setNotifications(prev => prev.filter(x => x.id !== n.id))
        setNotice('Notification removed.')
      } catch {
        setError('Could not remove notification.')
      } finally {
        setBusyId(null)
      }
    },
    [viewer],
  )

  const markAll = useCallback(async () => {
    if (!viewer) return

    setMarkingAll(true)
    setError('')
    setNotice('')

    try {
      const d = await markAllNotificationsRead(viewer)

      if (d.error) {
        setError(d.error)
        return
      }

      setNotifications(prev =>
        prev.map(n => ({
          ...n,
          read_at: n.read_at || new Date().toISOString(),
        })),
      )

      setUnreadCount(0)
      setNotice('All notifications marked read.')

      if (filter === 'unread') {
        void load('replace', 0)
      }
    } catch {
      setError('Could not mark notifications read.')
    } finally {
      setMarkingAll(false)
    }
  }, [filter, load, viewer])

  return (
    <main className={styles.layout}>
      <Navbar />

      <div className={styles.shell}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.heading}>Notifications</h1>
            <p className={styles.strap}>
              {unreadCount > 0
                ? `${unreadCount} unread update${unreadCount === 1 ? '' : 's'}`
                : 'You are up to date.'}
            </p>
          </div>

          <button
            className={styles.markAllBtn}
            onClick={() => void markAll()}
            disabled={markingAll || unreadCount === 0}
          >
            {markingAll ? <Loader2 size={15} className={styles.spin} /> : <CheckCheck size={15} />}
            Mark all read
          </button>
        </header>

        {error && <p className={styles.error}>{error}</p>}
        {notice && <p className={styles.notice}>{notice}</p>}

        <div className={styles.filters} role="tablist" aria-label="Notification filters">
          {FILTERS.map(f => {
            const Icon = f.icon
            const active = filter === f.key
            const count =
              f.key === 'unread'
                ? unreadCount
                : f.key === 'all'
                  ? notifications.length
                  : undefined

            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={active}
                className={`${styles.filterChip} ${active ? styles.filterChipOn : ''}`}
                onClick={() => setFilter(f.key)}
              >
                <Icon size={14} />
                <span>{f.label}</span>
                {count != null && count > 0 && <em>{count}</em>}
              </button>
            )
          })}
        </div>

        <section className={styles.list}>
          {loading ? (
            <div className={styles.state}>
              <Loader2 size={20} className={styles.spin} />
              <p>Loading notifications…</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className={styles.state}>
              <Bell size={24} />
              <p>
                {filter === 'unread'
                  ? 'No unread notifications.'
                  : 'No notifications yet.'}
              </p>
            </div>
          ) : (
            notifications.map(n => {
              const meta = categoryMeta(n.category)
              const Icon = meta.icon
              const unread = !n.read_at

              return (
                <button
                  key={n.id}
                  className={`${styles.item} ${unread ? styles.itemUnread : ''}`}
                  onClick={() => openNotification(n)}
                >
                  <Avatar src={n.actor_avatar} name={n.actor_display || n.actor} />

                  <span className={styles.itemBody}>
                    <span className={styles.itemTop}>
                      <strong className={styles.itemTitle}>{n.title}</strong>
                      <span className={styles.itemTime}>{timeAgo(n.created_at)}</span>
                    </span>

                    {n.body && <span className={styles.itemText}>{n.body}</span>}

                    <span className={styles.itemBottom}>
                      <span className={`${styles.categoryPill} ${meta.className}`}>
                        <Icon size={11} />
                        {meta.label}
                      </span>

                      {n.actor_display && (
                        <span className={styles.actor}>@{n.actor_display}</span>
                      )}
                    </span>
                  </span>

                  <span
                    className={styles.itemActions}
                    onClick={e => e.stopPropagation()}
                  >
                    {busyId === n.id ? (
                      <Loader2 size={14} className={styles.spin} />
                    ) : (
                      <button
                        className={styles.deleteBtn}
                        onClick={e => void removeNotification(n, e)}
                        aria-label="Delete notification"
                        title="Delete notification"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}

                    {unread && <span className={styles.unreadDot} />}
                  </span>
                </button>
              )
            })
          )}

          {!loading && hasMore && notifications.length > 0 && (
            <button
              className={styles.loadMore}
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? <Loader2 size={14} className={styles.spin} /> : null}
              Load older notifications
            </button>
          )}
        </section>
      </div>
    </main>
  )
}