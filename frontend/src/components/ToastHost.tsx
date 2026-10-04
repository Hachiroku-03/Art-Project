import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AtSign,
  Bell,
  Check,
  Gavel,
  Info,
  MessageCircle,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import {
  fetchNotifications,
  fetchNotificationsSince,
  fetchUnreadNotificationCount,
  markNotificationRead,
  routeFor,
  type AppNotification,
} from '../lib/notifications'
import { fetchAccountSettings, type NotificationPrefs } from '../lib/settings'
import styles from './ToastHost.module.css'

const POLL_MS = 5000
const TOAST_TTL = 5500
const MAX_VISIBLE = 4

// Categories that always deserve a toast.
const TOAST_CATEGORIES = new Set([
  'messages',
  'mentions',
  'auctions',
  'security',
  'wallet',
])

// Group events worth toasting (not every group noise).
const TOAST_GROUP_TYPES = new Set([
  'group_invite',
  'group_request_approved',
  'group_request_rejected',
  'group_removed',
  'group_announcement',
])

// Posts: only substantive interactions toast; likes/follows stay badge-only.
const TOAST_POST_TYPES = new Set([
  'post_comment',
  'post_reply',
  'post_mention',
])

const WALLET_TOAST_TYPES = new Set([
  'ticket_purchase_success',
  'ticket_purchase_failed',
  'invoice_ready',
  'payment_failed',
])

type Toast = {
  key: string
  n: AppNotification
}

function shouldToast(n: AppNotification): boolean {
  const cat = n.category
  const type = n.type

  if (cat === 'groups') return TOAST_GROUP_TYPES.has(type)
  if (cat === 'posts') return TOAST_POST_TYPES.has(type)
  if (cat === 'wallet') return WALLET_TOAST_TYPES.has(type)
  if (cat === 'system') return false

  return TOAST_CATEGORIES.has(cat)
}

function categoryIcon(category: string) {
  switch (category) {
    case 'messages':
      return MessageCircle
    case 'mentions':
      return AtSign
    case 'groups':
      return Users
    case 'auctions':
      return Gavel
    case 'wallet':
      return Wallet
    case 'security':
      return ShieldCheck
    default:
      return category === 'posts' ? Info : Bell
  }
}

function categoryClass(category: string): string {
  switch (category) {
    case 'messages':
      return styles.catMessages
    case 'mentions':
      return styles.catMentions
    case 'groups':
      return styles.catGroups
    case 'posts':
      return styles.catPosts
    case 'auctions':
      return styles.catAuctions
    case 'wallet':
      return styles.catWallet
    case 'security':
      return styles.catSecurity
    default:
      return styles.catSystem
  }
}


function cursorKey(viewer: string) {
  return `space_notif_cursor:${viewer}`
}

export function ToastHost() {
  const navigate = useNavigate()
  const location = useLocation()

  // Recompute viewer on every navigation so login/logout are picked up
  // without needing a global auth context.
  const viewer = localStorage.getItem('space_user') || ''

  const [toasts, setToasts] = useState<Toast[]>([])
  const prefsRef = useRef<NotificationPrefs | null>(null)
  const cursorRef = useRef<number>(0)
  const seenRef = useRef<Set<number>>(new Set())
  const audioRef = useRef<AudioContext | null>(null)
  const mountedRef = useRef(true)

  const dismiss = useCallback((key: string) => {
    setToasts(prev => prev.filter(t => t.key !== key))
  }, [])

  const playPing = useCallback(() => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return

      audioRef.current = audioRef.current || new Ctx()
      const ctx = audioRef.current
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, ctx.currentTime)
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.2)
    } catch {
      // audio blocked
    }
  }, [])

  const pushToasts = useCallback(
    (rows: AppNotification[]) => {
      if (!rows.length) return

      const next: Toast[] = []

      for (const n of rows) {
        if (seenRef.current.has(n.id)) continue
        seenRef.current.add(n.id)

        // Tell any listener (bell, notifications page) a notification arrived.
        window.dispatchEvent(new CustomEvent('space:notification', { detail: n }))

        if (!shouldToast(n)) continue

        const soundOn = !!prefsRef.current?.[n.category as keyof NotificationPrefs] &&
          (prefsRef.current[n.category as keyof NotificationPrefs] as { sound?: boolean })?.sound

        if (soundOn) playPing()

        next.push({ key: `${n.id}`, n })
      }

      if (!next.length) return

      setToasts(prev => [...next.reverse(), ...prev].slice(0, MAX_VISIBLE))

      // Auto-dismiss each.
      for (const t of next) {
        window.setTimeout(() => dismiss(t.key), TOAST_TTL)
      }
    },
    [dismiss, playPing],
  )

  const tick = useCallback(async () => {
    if (!viewer || document.hidden) return

    try {
      const d = await fetchNotificationsSince(viewer, cursorRef.current, 20)
      if (!mountedRef.current || d.error) return

      const rows = d.notifications || []
      if (!rows.length) return

      const maxId = rows.reduce((m, r) => Math.max(m, r.id), cursorRef.current)
      cursorRef.current = maxId
      localStorage.setItem(cursorKey(viewer), String(maxId))

      pushToasts(rows)

      // Broadcast fresh unread count for the bell (optional listener).
      const c = await fetchUnreadNotificationCount(viewer)
      if (mountedRef.current && typeof c.count === 'number') {
        window.dispatchEvent(new CustomEvent('space:unread-count', { detail: c.count }))
      }
    } catch {
      // silent; next tick retries
    }
  }, [pushToasts, viewer])

  // Load sound prefs once per viewer.
  useEffect(() => {
    if (!viewer) {
      prefsRef.current = null
      return
    }

    let alive = true
    fetchAccountSettings(viewer)
      .then(d => {
        if (alive && !d.error && d.notifications) prefsRef.current = d.notifications
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [viewer, location.key])

  // Establish cursor + start polling. Silently skip existing history on first run.
  useEffect(() => {
    mountedRef.current = true

    if (!viewer) {
      cursorRef.current = 0
      seenRef.current = new Set()
      setToasts([])
      return () => {
        mountedRef.current = false
      }
    }

    let stopped = false
    let interval: number | null = null

    const start = async () => {
      const stored = Number(localStorage.getItem(cursorKey(viewer)) || '0')

      if (stored > 0) {
        cursorRef.current = stored
      } else {
        // First time for this user on this device: seed cursor to newest id
        // so we do NOT toast the entire backlog.
        try {
          const d = await fetchNotifications(viewer, { limit: 1 })
          const newest = d.notifications?.[0]?.id
          cursorRef.current = newest || 0
          localStorage.setItem(cursorKey(viewer), String(cursorRef.current))
        } catch {
          cursorRef.current = 0
        }
      }

      seenRef.current = new Set()

      if (stopped) return

      void tick()
      interval = window.setInterval(() => void tick(), POLL_MS)
    }

    void start()

    const onVis = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true
      mountedRef.current = false
      if (interval != null) window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVis)
    }
    // location.key in deps forces re-seed/re-eval on login/logout navigation.
  }, [viewer, location.key, tick])

  const openToast = useCallback(
    (t: Toast) => {
      dismiss(t.key)

      if (!t.n.read_at) {
        void markNotificationRead(viewer, t.n.id)
        window.dispatchEvent(
          new CustomEvent('space:notification-read', { detail: t.n.id }),
        )
      }

      const route = routeFor(t.n)
      if (route.state) navigate(route.to, { state: route.state })
      else navigate(route.to)
    },
    [dismiss, navigate, viewer],
  )

  if (!viewer || toasts.length === 0) return null

  return (
    <div className={styles.host} aria-live="polite" aria-label="Notifications">
      {toasts.map(t => {
        const Icon = categoryIcon(t.n.category)
        const unread = !t.n.read_at

        return (
          <div key={t.key} className={styles.toast}>
            <button className={styles.toastMain} onClick={() => openToast(t)}>
              <span className={`${styles.icon} ${categoryClass(t.n.category)}`}>
                <Icon size={15} />
              </span>

              <span className={styles.body}>
                <span className={styles.titleRow}>
                  <strong className={styles.title}>{t.n.title}</strong>
                  {unread && <span className={styles.unreadDot} />}
                </span>

                {t.n.body && <span className={styles.text}>{t.n.body}</span>}
              </span>
            </button>

            <button
              className={styles.close}
              onClick={() => dismiss(t.key)}
              aria-label="Dismiss notification"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// Re-export a tiny helper so other code can mark-read optimistically if needed.
export { Check as _ToastCheckIcon }