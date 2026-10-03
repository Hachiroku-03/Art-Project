import { useState, useRef, useEffect } from 'react'
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
} from 'lucide-react'
import { WalletPanel } from './WalletPanel'
import { NotificationBell } from './NotificationBell'
import { API } from '../lib/sales'
import { teardown } from '../lib/chat'
import styles from './Navbar.module.css'

export function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()

  const user = localStorage.getItem('space_user') || 'C'
  const role = localStorage.getItem('space_role') || 'artist'
  const tier = localStorage.getItem('space_tier') || 'standard'
  const initial = user[0].toUpperCase()
  const isVip = tier === 'vip'

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const walletRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    fetch(`${API}/me?viewer=${encodeURIComponent(user)}`)
      .then(r => r.json())
      .then(d => {
        if (d.user?.avatar_url) setAvatarUrl(d.user.avatar_url)
      })
      .catch(() => {})
  }, [user])

  function handleLogout() {
    setMobileOpen(false)
    setMenuOpen(false)
    setWalletOpen(false)
    teardown()
    localStorage.clear()
    navigate('/login')
  }

  const go = (path: string) => {
    setMobileOpen(false)
    setMenuOpen(false)
    setWalletOpen(false)
    navigate(path)
  }

  const isActive = (path: string) =>
    location.pathname === path ? styles.activeLink : ''

  const avatarContent = avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      className={styles.avatarImg}
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
          <NotificationBell />

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
            <span className={styles.vipLabel}>
              {isVip ? 'VIP' : 'Go VIP'}
            </span>
          </button>

          <div
            className={`${styles.menuWrap} ${styles.desktopOnly}`}
            ref={menuRef}
          >
            <button
              className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`}
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Account menu"
            >
              {avatarContent}
            </button>

            {menuOpen && (
              <div className={styles.menuDropdown}>
                <button
                  className={styles.menuItem}
                  onClick={() => go('/settings')}
                >
                  <Settings size={15} /> Settings
                </button>

                <button
                  className={styles.menuItem}
                  onClick={() => go(`/profile/${user}`)}
                >
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
            <WalletPanel
              viewer={user}
              onClose={() => setWalletOpen(false)}
            />
          </div>
        )}
      </nav>

      {mobileOpen && (
        <>
          <div
            className={styles.backdrop}
            onClick={() => setMobileOpen(false)}
          />

          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div
                className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`}
              >
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
                className={`${styles.drawerVip} ${
                  isVip ? styles.drawerVipOn : ''
                }`}
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

              <button
                className={isActive('/feed')}
                onClick={() => go('/feed')}
              >
                <Home size={18} />
                <span>Feed</span>
              </button>

              <button
                className={isActive('/auctions')}
                onClick={() => go('/auctions')}
              >
                <Gavel size={18} />
                <span>Auctions</span>
              </button>

              <button
                className={isActive('/community')}
                onClick={() => go('/community')}
              >
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

              <button
                className={styles.drawerDanger}
                onClick={handleLogout}
              >
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