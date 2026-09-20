import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Home, Gavel, Users, Compass, Sparkles, MessageSquare, Menu, X, User, Settings, LogOut } from 'lucide-react'
import styles from './Navbar.module.css'

export function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()

  const user = localStorage.getItem('space_user') || 'C'
  const role = localStorage.getItem('space_role') || 'collector'
  const tier = localStorage.getItem('space_tier')
  const initial = user[0].toUpperCase()

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
    setMobileOpen(false)
    setMenuOpen(false)
    localStorage.clear()
    navigate('/login')
  }

  const navigateAndClose = (path: string) => {
    setMobileOpen(false)
    navigate(path)
  }

  const isActive = (path: string) => (location.pathname === path ? styles.activeLink : '')
  const isCollector = role === 'collector'

  return (
    <>
      <nav className={styles.navbar}>
        <div className={styles.brand} onClick={() => navigateAndClose('/feed')}>THE SPACE</div>

        {/* CENTER LINKS (Icons Restored) */}
        <div className={styles.navLinks}>
          <button className={`${styles.link} ${isActive('/feed')}`} onClick={() => navigate('/feed')}>
            <Home size={16} /> Feed
          </button>
          <button className={`${styles.link} ${isActive('/auctions')}`} onClick={() => navigate('/auctions')}>
            <Gavel size={16} /> Auctions
          </button>
          <button className={`${styles.link} ${isActive('/community')}`} onClick={() => navigate('/community')}>
            <Users size={16} /> Community
          </button>
          {isCollector ? (
            <button className={`${styles.link} ${isActive('/discover')}`} onClick={() => navigate('/discover')}>
              <Compass size={16} /> Discover
            </button>
          ) : (
            <button className={`${styles.link} ${isActive('/studio')}`} onClick={() => navigate('/studio')}>
              <Sparkles size={16} /> Studio
            </button>
          )}
        </div>

        {/* RIGHT */}
        <div className={styles.userCluster}>
          <button className={styles.iconBtn} onClick={() => navigate('/messages')} aria-label="Messages">
            <MessageSquare size={18} />
          </button>

          {/* Desktop Avatar Menu */}
          <div className={`${styles.menuWrap} ${styles.desktopOnly}`} ref={menuRef}>
            <button className={`${styles.avatar} ${tier === 'vip' ? styles.vipRing : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
              {initial}
            </button>
            {menuOpen && (
              <div className={styles.menuDropdown}>
                <button className={styles.menuItem} onClick={() => { setMenuOpen(false); navigate('/profile') }}>
                  <User size={15} /> Profile
                </button>
                <button className={styles.menuItem} onClick={() => { setMenuOpen(false); navigate('/settings') }}>
                  <Settings size={15} /> Settings
                </button>
                <button className={`${styles.menuItem} ${styles.menuDanger}`} onClick={handleLogout}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            )}
          </div>

          {/* Mobile Hamburger */}
          <button className={styles.hamburger} onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
        </div>
      </nav>

      {/* MOBILE DRAWER (Icons included here too) */}
      {mobileOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div className={`${styles.avatar} ${tier === 'vip' ? styles.vipRing : ''}`}>{initial}</div>
              <div className={styles.drawerUserInfo}>
                <p className={styles.drawerName}>{user}</p>
                <p className={styles.drawerRole}>{role.toUpperCase()}</p>
              </div>
              <button className={styles.drawerClose} onClick={() => setMobileOpen(false)}><X size={20} /></button>
            </div>

            <nav className={styles.drawerLinks}>
              <button className={isActive('/feed')} onClick={() => navigateAndClose('/feed')}><Home size={18} /> Feed</button>
              <button className={isActive('/auctions')} onClick={() => navigateAndClose('/auctions')}><Gavel size={18} /> Auctions</button>
              <button className={isActive('/community')} onClick={() => navigateAndClose('/community')}><Users size={18} /> Community</button>
              {isCollector ? (
                <button className={isActive('/discover')} onClick={() => navigateAndClose('/discover')}><Compass size={18} /> Discover</button>
              ) : (
                <button className={isActive('/studio')} onClick={() => navigateAndClose('/studio')}><Sparkles size={18} /> Studio</button>
              )}
              
              <div className={styles.drawerDivider} />
              
              <button onClick={() => navigateAndClose('/profile')}><User size={18} /> Profile</button>
              <button onClick={() => navigateAndClose('/settings')}><Settings size={18} /> Settings</button>
              <button className={styles.drawerDanger} onClick={handleLogout}><LogOut size={18} /> Log out</button>
            </nav>
          </aside>
        </>
      )}
    </>
  )
}