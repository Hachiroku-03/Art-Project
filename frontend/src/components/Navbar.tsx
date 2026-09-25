import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Home, Gavel, Crown, Menu, X, User, LogOut } from 'lucide-react'
import styles from './Navbar.module.css'

export function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()

  const user = localStorage.getItem('space_user') || 'C'
  const role = localStorage.getItem('space_role') || 'artist'   // collector is retired
  const tier = localStorage.getItem('space_tier') || 'standard'
  const initial = user[0].toUpperCase()
  const isVip = tier === 'vip'

  // ---- hooks stay top-level, identical order to before ----
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  function handleLogout() {
    setMobileOpen(false); setMenuOpen(false)
    localStorage.clear()
    navigate('/login')
  }

  const go = (path: string) => { setMobileOpen(false); setMenuOpen(false); navigate(path) }
  const isActive = (path: string) => (location.pathname === path ? styles.activeLink : '')

  return (
    <>
      <nav className={styles.navbar}>
        <div className={styles.brand} onClick={() => go('/feed')}>THE SPACE</div>

        {/* CENTER — only routes that actually exist. Community / Studio slots return with their pages. */}
        <div className={styles.navLinks}>
          <button className={`${styles.link} ${isActive('/feed')}`} onClick={() => go('/feed')}>
            <Home size={16} /> Feed
          </button>
          <button className={`${styles.link} ${isActive('/auctions')}`} onClick={() => go('/auctions')}>
            <Gavel size={16} /> Auctions
          </button>
        </div>

        {/* RIGHT */}
        <div className={styles.userCluster}>
          {/* THE SUBSCRIBE / VIP PILL */}
          <button
            className={`${styles.vipBtn} ${isVip ? styles.vipBtnOn : ''}`}
            onClick={() => go('/pricing')}
            aria-label={isVip ? 'Your VIP membership' : 'Go VIP'}
          >
            <Crown size={15} fill={isVip ? 'currentColor' : 'none'} />
            <span className={styles.vipLabel}>{isVip ? 'VIP' : 'Go VIP'}</span>
          </button>

          {/* Desktop avatar menu */}
          <div className={`${styles.menuWrap} ${styles.desktopOnly}`} ref={menuRef}>
            <button className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
              {initial}
            </button>
            {menuOpen && (
              <div className={styles.menuDropdown}>
                <button className={styles.menuItem} onClick={() => go(`/profile/${user}`)}>
                  <User size={15} /> Profile
                </button>
                <button className={`${styles.menuItem} ${styles.menuDanger}`} onClick={handleLogout}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            )}
          </div>

          {/* Mobile hamburger */}
          <button className={styles.hamburger} onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
        </div>
      </nav>

      {/* MOBILE DRAWER */}
      {mobileOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div className={`${styles.avatar} ${isVip ? styles.vipRing : ''}`}>{initial}</div>
              <div className={styles.drawerUserInfo}>
                <p className={styles.drawerName}>{user}</p>
                <p className={styles.drawerRole}>{role.toUpperCase()}{isVip ? ' · VIP' : ''}</p>
              </div>
              <button className={styles.drawerClose} onClick={() => setMobileOpen(false)}><X size={20} /></button>
            </div>

            <nav className={styles.drawerLinks}>
              {/* VIP row, prominent, top of drawer */}
              <button className={`${styles.drawerVip} ${isVip ? styles.drawerVipOn : ''}`} onClick={() => go('/pricing')}>
                <Crown size={18} fill={isVip ? 'currentColor' : 'none'} />
                {isVip ? 'Your VIP membership' : 'Go VIP'}
              </button>

              <div className={styles.drawerDivider} />

              <button className={isActive('/feed')} onClick={() => go('/feed')}><Home size={18} /> Feed</button>
              <button className={isActive('/auctions')} onClick={() => go('/auctions')}><Gavel size={18} /> Auctions</button>

              <div className={styles.drawerDivider} />

              <button onClick={() => go(`/profile/${user}`)}><User size={18} /> Profile</button>
              <button className={styles.drawerDanger} onClick={handleLogout}><LogOut size={18} /> Log out</button>
            </nav>
          </aside>
        </>
      )}
    </>
  )
}