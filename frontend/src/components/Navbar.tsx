import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home,
  Gavel,
  Crown,
  Menu,
  X,
  User,
  LogOut,
  Ticket,
  MessageCircle,
  Settings,
  Users,
  Trophy,
  Bell,
} from 'lucide-react'
import { WalletPanel } from './WalletPanel'
import { NotificationBell } from './NotificationBell'
import { ErrorBoundary } from './ErrorBoundary'
import { API } from '../lib/sales'
import { teardown } from '../lib/chat'
import { clearSession, getRole, getTier, getViewer } from '../lib/session'
import styles from './Navbar.module.css'

const AUTH = 'http://localhost:8000'
const SALES = API

const ME_ORIGINS = [AUTH, SALES]

const REFRESH_EVENTS = [
  'space:user-updated',
  'space:vip-updated',
  'space:profile-updated',
  'space:session-changed',
]

function normalizeRole(value: unknown): string {
  return String(value ?? 'artist').trim().toLowerCase() || 'artist'
}

function normalizeTier(value: unknown): string {
  const t = String(value ?? '').trim().toLowerCase()
  if (t === 'vip' || t === 'vip_only' || t === 'vip-only' || t === 'premium') return 'vip'
  return 'standard'
}

function buildAvatarCandidates(raw: unknown, preferredBase?: string): string[] {
  if (raw === undefined || raw === null) return []

  const v = String(raw).trim()
  if (!v) return []

  if (/^https?:\/\//i.test(v) || v.startsWith('data:') || v.startsWith('blob:')) {
    return [v]
  }

  const suffix = v.startsWith('/') ? v : `/${v}`

  const bases = [preferredBase, ...ME_ORIGINS.filter(b => b !== preferredBase)].filter(
    (b, i, arr): b is string => !!b && arr.indexOf(b) === i,
  )

  return bases.map(base => `${base}${suffix}`)
}

function readMePayload(d: any, fallbackUsername: string) {
  const u = d?.user ?? d?.profile ?? d?.data ?? d ?? {}

  const username =
    u.username ??
    u.user_name ??
    u.userName ??
    d?.username ??
    d?.user_name ??
    fallbackUsername

  const role = u.role ?? d?.role

  let tier =
    u.tier ??
    u.membership ??
    u.subscription_tier ??
    u.access_tier ??
    d?.tier ??
    d?.membership

  if (tier === undefined) {
    const flag =
      u.is_vip === true ||
      u.vip === true ||
      (String(u.subscription_status ?? '').toLowerCase() === 'active' &&
        String(u.subscription_plan ?? u.plan ?? '').toLowerCase().includes('vip'))

    if (flag) tier = 'vip'
  }

  const avatar =
    u.avatar_url ??
    u.avatarUrl ??
    u.avatar ??
    u.image_url ??
    u.imageUrl ??
    d?.avatar_url ??
    d?.avatarUrl ??
    d?.avatar

  return { username, role, tier, avatar }
}

export function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()

  const [user, setUser] = useState(
    () => getViewer() || localStorage.getItem('space_user') || '',
  )
  const [role, setRole] = useState(() => getRole() || 'artist')
  const [tier, setTier] = useState(() => getTier() || 'standard')

  const [avatarCandidates, setAvatarCandidates] = useState<string[]>([])
  const [avatarIndex, setAvatarIndex] = useState(0)
  const [avatarFailed, setAvatarFailed] = useState(false)

  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const walletRef = useRef<HTMLDivElement>(null)

  const userRef = useRef(user)
  const roleRef = useRef(role)
  const tierRef = useRef(tier)
  const avatarCandidatesRef = useRef(avatarCandidates)
  const avatarIndexRef = useRef(avatarIndex)

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    roleRef.current = role
  }, [role])

  useEffect(() => {
    tierRef.current = tier
  }, [tier])

  useEffect(() => {
    avatarCandidatesRef.current = avatarCandidates
  }, [avatarCandidates])

  useEffect(() => {
    avatarIndexRef.current = avatarIndex
  }, [avatarIndex])

  const avatarUrl = avatarCandidates[avatarIndex] || null
  const initial = (user || '?')[0].toUpperCase()
  const isVip = normalizeTier(tier) === 'vip'

  const logoutLocal = useCallback(() => {
    setMobileOpen(false)
    setMenuOpen(false)
    setWalletOpen(false)

    try {
      teardown()
    } catch {
      // ignore
    }

    clearSession()

    setUser('')
    userRef.current = ''

    setRole('artist')
    roleRef.current = 'artist'

    setTier('standard')
    tierRef.current = 'standard'

    setAvatarCandidates([])
    avatarCandidatesRef.current = []

    setAvatarIndex(0)
    avatarIndexRef.current = 0

    setAvatarFailed(false)
  }, [])

  const fetchMe = useCallback(async () => {
    const current =
      userRef.current || getViewer() || localStorage.getItem('space_user') || ''

    if (!current) {
      setAvatarCandidates([])
      avatarCandidatesRef.current = []
      setAvatarIndex(0)
      avatarIndexRef.current = 0
      setAvatarFailed(false)
      return
    }

    const settled = await Promise.allSettled(
      ME_ORIGINS.map(async base => {
        const res = await fetch(`${base}/me?viewer=${encodeURIComponent(current)}`)
        if (!res.ok) return null

        const d = await res.json().catch(() => null)
        if (!d) return null

        return {
          base,
          parsed: readMePayload(d, current),
        }
      }),
    )

    const ok = settled
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter((x): x is { base: string; parsed: ReturnType<typeof readMePayload> } => !!x)

    const pick = (key: 'username' | 'role' | 'tier' | 'avatar') => {
      for (const o of ok) {
        const value = (o.parsed as any)[key]
        if (value !== undefined && value !== null && value !== '') {
          return { value, base: o.base }
        }
      }

      return { value: undefined as any, base: undefined as string | undefined }
    }

    const usernameHit = pick('username')
    const roleHit = pick('role')
    const tierHit = pick('tier')
    const avatarHit = pick('avatar')

    const nextUsername = String(usernameHit.value || current)
    const nextRole =
      roleHit.value === undefined ? roleRef.current : normalizeRole(roleHit.value)

    let nextTier =
      tierHit.value === undefined ? tierRef.current : normalizeTier(tierHit.value)

    // VIP fallback: if /me does not clearly say vip, check /vip/status.
    if (nextTier !== 'vip') {
      try {
        const vs = await fetch(
          `${AUTH}/vip/status?viewer=${encodeURIComponent(nextUsername)}`,
        )
          .then(r => r.json())
          .catch(() => null)

        if (vs) {
          const vsTier = normalizeTier(vs.tier)
          if (vsTier === 'vip' || vs.vip === true) {
            nextTier = 'vip'
          }
        }
      } catch {
        // ignore
      }
    }

    const nextCandidates =
      avatarHit.value === undefined
        ? avatarCandidatesRef.current
        : buildAvatarCandidates(avatarHit.value, avatarHit.base)

    const changedUser = nextUsername !== userRef.current
    const changedRole = nextRole !== roleRef.current
    const changedTier = nextTier !== tierRef.current
    const changedAvatar =
      JSON.stringify(nextCandidates) !== JSON.stringify(avatarCandidatesRef.current)

    if (changedUser) {
      setUser(nextUsername)
      userRef.current = nextUsername
      localStorage.setItem('space_user', nextUsername)
    }

    if (changedRole) {
      setRole(nextRole)
      roleRef.current = nextRole
      localStorage.setItem('space_role', nextRole)
    }

    if (changedTier) {
      setTier(nextTier)
      tierRef.current = nextTier
      localStorage.setItem('space_tier', nextTier)
    }

    if (changedAvatar) {
      setAvatarCandidates(nextCandidates)
      avatarCandidatesRef.current = nextCandidates
      setAvatarIndex(0)
      avatarIndexRef.current = 0
      setAvatarFailed(false)
    }

    if (changedUser || changedRole || changedTier || changedAvatar) {
      window.dispatchEvent(
        new CustomEvent('space:session-updated', {
          detail: {
            user: nextUsername,
            role: nextRole,
            tier: nextTier,
            avatarCandidates: nextCandidates,
          },
        }),
      )
    }
  }, [])

  // Fetch on mount and on route change, e.g. returning from /pricing after VIP.
  useEffect(() => {
    void fetchMe()
  }, [fetchMe, location.pathname])

  // Refetch when tab regains focus.
  useEffect(() => {
    const onFocus = () => void fetchMe()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchMe])

  // Cross-tab storage. Important: do NOT adopt another tab's account.
  // localStorage is shared per browser profile, so two accounts in one browser
  // can overwrite each other. Use two browsers/incognito for true parallel testing.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key) {
        void fetchMe()
        return
      }

      if (e.key === 'space_token') {
        if (!e.newValue) {
          logoutLocal()
          navigate('/login', { replace: true })
          return
        }

        void fetchMe()
        return
      }

      // Ignore another tab switching users. Keep this tab's identity stable.
      if (e.key === 'space_user') {
        void fetchMe()
        return
      }

      if (e.key === 'space_role' || e.key === 'space_tier') {
        void fetchMe()
        return
      }
    }

    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [fetchMe, logoutLocal, navigate])

  // Same-tab refresh events from other pages.
  useEffect(() => {
    const onRefresh = () => void fetchMe()

    REFRESH_EVENTS.forEach(name => window.addEventListener(name, onRefresh))

    return () => {
      REFRESH_EVENTS.forEach(name => window.removeEventListener(name, onRefresh))
    }
  }, [fetchMe])

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) {
        setWalletOpen(false)
      }
    }

    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  function handleLogout() {
    logoutLocal()
    navigate('/login', { replace: true })
  }

  const go = (path: string) => {
    setMobileOpen(false)
    setMenuOpen(false)
    setWalletOpen(false)
    navigate(path)
  }

  const isActive = (path: string) =>
    location.pathname === path ? styles.activeLink : ''

  const handleAvatarError = () => {
    if (avatarIndex + 1 < avatarCandidates.length) {
      const next = avatarIndex + 1
      setAvatarIndex(next)
      avatarIndexRef.current = next
      return
    }

    setAvatarFailed(true)
  }

  const avatarContent =
    avatarUrl && !avatarFailed ? (
      <img
        src={avatarUrl}
        alt=""
        className={styles.avatarImg}
        onError={handleAvatarError}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: 'inherit',
          display: 'block',
        }}
      />
    ) : (
      initial
    )

  return (
    <>
      <nav className={styles.navbar}>
        <div className={styles.brand} onClick={() => go('/feed')}>
          THE SPACE
        </div>

        {/*
          Desktop nav is intentionally shorter.
          "Won lots" lives in the account dropdown and mobile drawer.
        */}
        <div className={styles.navLinks}>
          <button
            className={`${styles.link} ${isActive('/feed')}`}
            onClick={() => go('/feed')}
          >
            <Home size={16} />
            <span>Feed</span>
          </button>

          <button
            className={`${styles.link} ${isActive('/auctions')}`}
            onClick={() => go('/auctions')}
          >
            <Gavel size={16} />
            <span>Auctions</span>
          </button>

          <button
            className={`${styles.link} ${isActive('/community')}`}
            onClick={() => go('/community')}
          >
            <Users size={16} />
            <span>Community</span>
          </button>

          <button
            className={`${styles.link} ${isActive('/messenger')}`}
            onClick={() => go('/messenger')}
          >
            <MessageCircle size={16} />
            <span>Messenger</span>
          </button>
        </div>

        <div className={styles.userCluster}>
          {/*
            Fixed bell slot + ErrorBoundary fallback.
            Even if NotificationBell crashes or returns nothing, the bell area stays visible.
          */}
          <span className={styles.bellSlot}>
            <ErrorBoundary
              fallback={
                <button
                  className={styles.iconBtn}
                  aria-label="Notifications unavailable"
                  title="Notifications unavailable"
                >
                  <Bell size={18} />
                </button>
              }
            >
              <NotificationBell viewer={user} />
            </ErrorBoundary>
          </span>

          <button
            className={`${styles.iconBtn} ${walletOpen ? styles.iconBtnOn : ''}`}
            onClick={() => setWalletOpen(o => !o)}
            aria-label="Wallet"
          >
            <Ticket size={18} />
          </button>

          <button
            className={`${styles.vipBtn} ${isVip ? styles.vipBtnOn : ''}`}
            onClick={() => go('/pricing')}
            aria-label={isVip ? 'Your VIP membership' : 'Go VIP'}
          >
            <Crown size={15} fill={isVip ? 'currentColor' : 'none'} />
            <span className={styles.vipLabel}>{isVip ? 'VIP' : 'Go VIP'}</span>
          </button>

          <div className={`${styles.menuWrap} ${styles.desktopOnly}`} ref={menuRef}>
            <button
              className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`}
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Account menu"
            >
              {avatarContent}
            </button>

            {menuOpen && (
              <div className={styles.menuDropdown}>
                <button className={styles.menuItem} onClick={() => go('/wins')}>
                  <Trophy size={15} /> Won lots
                </button>

                <button className={styles.menuItem} onClick={() => go('/settings')}>
                  <Settings size={15} /> Settings
                </button>

                <button className={styles.menuItem} onClick={() => go(`/profile/${user}`)}>
                  <User size={15} /> Profile
                </button>

                <button
                  className={`${styles.menuItem} ${styles.menuDanger}`}
                  onClick={handleLogout}
                >
                  <LogOut size={15} /> Log out
                </button>
              </div>
            )}
          </div>

          <button
            className={styles.hamburger}
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
        </div>

        {walletOpen && (
          <div className={styles.walletPop} ref={walletRef}>
            <WalletPanel viewer={user} onClose={() => setWalletOpen(false)} />
          </div>
        )}
      </nav>

      {mobileOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />

          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`}>
                {avatarContent}
              </div>

              <div className={styles.drawerUserInfo}>
                <p className={styles.drawerName}>{user}</p>
                <p className={styles.drawerRole}>
                  {role.toUpperCase()}
                  {isVip ? ' · VIP' : ''}
                </p>
              </div>

              <button
                className={styles.drawerClose}
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <nav className={styles.drawerLinks}>
              <button
                className={`${styles.drawerVip} ${isVip ? styles.drawerVipOn : ''}`}
                onClick={() => go('/pricing')}
              >
                <Crown size={18} fill={isVip ? 'currentColor' : 'none'} />
                <span>{isVip ? 'Your VIP membership' : 'Go VIP'}</span>
              </button>

              <button onClick={() => go('/wallet')}>
                <Ticket size={18} />
                <span>Wallet</span>
              </button>

              <button onClick={() => go('/messenger')}>
                <MessageCircle size={18} />
                <span>Messenger</span>
              </button>

              <div className={styles.drawerDivider} />

              <button className={isActive('/feed')} onClick={() => go('/feed')}>
                <Home size={18} />
                <span>Feed</span>
              </button>

              <button className={isActive('/auctions')} onClick={() => go('/auctions')}>
                <Gavel size={18} />
                <span>Auctions</span>
              </button>

              <button className={isActive('/wins')} onClick={() => go('/wins')}>
                <Trophy size={18} />
                <span>Won lots</span>
              </button>

              <button className={isActive('/community')} onClick={() => go('/community')}>
                <Users size={18} />
                <span>Community</span>
              </button>

              <div className={styles.drawerDivider} />

              <button onClick={() => go('/settings')}>
                <Settings size={18} />
                <span>Settings</span>
              </button>

              <button onClick={() => go(`/profile/${user}`)}>
                <User size={18} />
                <span>Profile</span>
              </button>

              <button className={styles.drawerDanger} onClick={handleLogout}>
                <LogOut size={18} />
                <span>Log out</span>
              </button>
            </nav>
          </aside>
        </>
      )}
    </>
  )
}