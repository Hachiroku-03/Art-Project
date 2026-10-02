import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell,
  Check,
  Gavel,
  Landmark,
  Loader2,
  LogOut,
  MessageCircle,
  ShieldCheck,
  User,
  Wallet,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { teardown } from '../lib/chat'
import styles from './SettingsPage.module.css'

const AUTH_API = 'http://localhost:8000'

type Section = 'profile' | 'notifications' | 'auctions' | 'privacy' | 'house' | 'support'
type HouseStatus = 'loading' | 'none' | 'pending' | 'approved' | 'rejected'

const SECTIONS: { key: Section; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'auctions', label: 'Auctions & Bidding', icon: Gavel },
  { key: 'privacy', label: 'Privacy & Security', icon: ShieldCheck },
  { key: 'house', label: 'Auction House', icon: Landmark },
  { key: 'support', label: 'Support & Rules', icon: Check },
]

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ar', label: 'Arabic' },
]

function getBool(key: string, fallback: boolean) {
  const v = localStorage.getItem(key)
  if (v == null) return fallback
  return v === '1' || v === 'true'
}

function setBool(key: string, value: boolean) {
  localStorage.setItem(key, value ? '1' : '0')
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description: string
}) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <p className={styles.toggleLabel}>{label}</p>
        <span className={styles.toggleDesc}>{description}</span>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.switchKnob} />
      </button>
    </div>
  )
}

export function SettingsPage() {
  const navigate = useNavigate()

  const viewer = localStorage.getItem('space_user') || ''
  const role = localStorage.getItem('space_role') || 'artist'
  const tier = localStorage.getItem('space_tier') || 'standard'

  const [section, setSection] = useState<Section>('profile')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const [language, setLanguage] = useState(() => localStorage.getItem('space_language') || 'en')

  const [notifyMentions, setNotifyMentions] = useState(() => getBool('space_notify_mentions', true))
  const [notifyGroupInvites, setNotifyGroupInvites] = useState(() => getBool('space_notify_group_invites', true))
  const [notifyAuctionReminders, setNotifyAuctionReminders] = useState(() => getBool('space_notify_auction_reminders', true))
  const [notifySound, setNotifySound] = useState(() => getBool('space_notify_sound', false))

  const [confirmBids, setConfirmBids] = useState(() => getBool('space_confirm_bids', true))
  const [showUsernameInLedger, setShowUsernameInLedger] = useState(() => getBool('space_show_username_ledger', true))
  const [paddleNickname, setPaddleNickname] = useState(() => localStorage.getItem('space_paddle_nickname') || '')

  const [houseStatus, setHouseStatus] = useState<HouseStatus>('loading')

  const noticeTimer = useRef<number | null>(null)

  const flash = useCallback((msg: string) => {
    setNotice(msg)

    if (noticeTimer.current != null) {
      window.clearTimeout(noticeTimer.current)
    }

    noticeTimer.current = window.setTimeout(() => setNotice(''), 1800)
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimer.current != null) {
        window.clearTimeout(noticeTimer.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      navigate('/login', { replace: true })
    }
  }, [navigate])

  // Read language from existing auth settings if available.
  useEffect(() => {
    if (!viewer) return

    let alive = true

    fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        if (alive && typeof d.language === 'string') {
          setLanguage(d.language)
          localStorage.setItem('space_language', d.language)
        }
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [viewer])

  // Read auction house standing.
  useEffect(() => {
    if (!viewer) {
      setHouseStatus('none')
      return
    }

    let alive = true
    setHouseStatus('loading')

    fetch(`${AUTH_API}/house/application?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return

        const status = d.status

        if (status === 'approved' || status === 'pending' || status === 'rejected') {
          setHouseStatus(status)
        } else {
          setHouseStatus('none')
        }
      })
      .catch(() => {
        if (alive) setHouseStatus('none')
      })

    return () => {
      alive = false
    }
  }, [viewer])

  const updateBool = useCallback(
    (key: string, value: boolean, setter: (v: boolean) => void) => {
      setter(value)
      setBool(key, value)
      flash('Saved on this device.')
    },
    [flash],
  )

  const saveLanguage = (value: string) => {
    setLanguage(value)
    localStorage.setItem('space_language', value)
    flash('Language saved on this device.')
  }

  const saveAuctionPrefs = async () => {
    setSaving(true)

    localStorage.setItem('space_paddle_nickname', paddleNickname.trim())

    // Small delay so the button state feels intentional.
    await new Promise(r => window.setTimeout(r, 180))

    setSaving(false)
    flash('Auction preferences saved.')
  }

  const logout = () => {
    if (!window.confirm('Log out of THE SPACE?')) return

    setLoggingOut(true)

    try {
      teardown()
    } catch {
      // ignore
    }

    localStorage.clear()
    navigate('/login', { replace: true })
  }

  const houseLabel =
    houseStatus === 'loading'
      ? 'Checking…'
      : houseStatus === 'approved'
        ? 'Approved'
        : houseStatus === 'pending'
          ? 'Under review'
          : houseStatus === 'rejected'
            ? 'Rejected'
            : 'Not applied'

  const houseClass =
    houseStatus === 'approved'
      ? styles.badgeApproved
      : houseStatus === 'pending'
        ? styles.badgePending
        : houseStatus === 'rejected'
          ? styles.badgeRejected
          : styles.badgeNone

  return (
    <main className={styles.layout}>
      <Navbar />

      <div className={styles.shell}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.heading}>Settings</h1>
            <p className={styles.strap}>Your identity, preferences, and access controls.</p>
          </div>

          {notice && (
            <p className={styles.notice}>
              <Check size={14} /> {notice}
            </p>
          )}
        </header>

        <div className={styles.body}>
          <aside className={styles.sidebar}>
            {SECTIONS.map(s => {
              const Icon = s.icon
              const active = section === s.key

              return (
                <button
                  key={s.key}
                  className={`${styles.sectionBtn} ${active ? styles.sectionBtnOn : ''}`}
                  onClick={() => setSection(s.key)}
                >
                  <Icon size={16} />
                  <span>{s.label}</span>
                </button>
              )
            })}
          </aside>

          <section className={styles.content}>
            {section === 'profile' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Profile</p>
                <p className={styles.cardSub}>Basic identity used across feed, messenger, wallet, and auctions.</p>

                <div className={styles.infoGrid}>
                  <div className={styles.infoBox}>
                    <span className={styles.infoLabel}>Username</span>
                    <strong className={styles.infoValue}>@{viewer || '—'}</strong>
                  </div>

                  <div className={styles.infoBox}>
                    <span className={styles.infoLabel}>Role</span>
                    <strong className={styles.infoValue}>{role.toUpperCase()}</strong>
                  </div>

                  <div className={styles.infoBox}>
                    <span className={styles.infoLabel}>Membership</span>
                    <strong className={styles.infoValue}>{tier === 'vip' ? 'VIP' : 'Standard'}</strong>
                  </div>
                </div>

                <div className={styles.actionGrid}>
                  <button className={styles.actionBtn} onClick={() => navigate(`/profile/${viewer}`)}>
                    <User size={16} />
                    <span>View public profile</span>
                  </button>

                  <button className={styles.actionBtn} onClick={() => navigate('/wallet')}>
                    <Wallet size={16} />
                    <span>Open wallet</span>
                  </button>

                  <button className={styles.actionBtn} onClick={() => navigate('/notifications')}>
                    <Bell size={16} />
                    <span>Open notifications</span>
                  </button>

                  <button className={styles.actionBtn} onClick={() => navigate('/messenger')}>
                    <MessageCircle size={16} />
                    <span>Open messenger</span>
                  </button>
                </div>

                <div className={styles.languageBlock}>
                  <label className={styles.fieldLabel} htmlFor="settings-language">
                    App language
                  </label>

                  <select
                    id="settings-language"
                    className={styles.select}
                    value={language}
                    onChange={e => saveLanguage(e.target.value)}
                  >
                    {LANGUAGES.map(l => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>

                  <p className={styles.muted}>
                    Saved on this device for now. We’ll connect account-level language sync after the backend settings endpoint is confirmed.
                  </p>
                </div>
              </div>
            )}

            {section === 'notifications' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Notifications</p>
                <p className={styles.cardSub}>Control what the notification bell emphasizes.</p>

                <Toggle
                  checked={notifyMentions}
                  onChange={next => updateBool('space_notify_mentions', next, setNotifyMentions)}
                  label="Mentions"
                  description="Notify me when someone @mentions me in messenger."
                />

                <Toggle
                  checked={notifyGroupInvites}
                  onChange={next => updateBool('space_notify_group_invites', next, setNotifyGroupInvites)}
                  label="Group invites"
                  description="Notify me when I am added to a group."
                />

                <Toggle
                  checked={notifyAuctionReminders}
                  onChange={next => updateBool('space_notify_auction_reminders', next, setNotifyAuctionReminders)}
                  label="Auction reminders"
                  description="Prepare reminders for auctions I hold tickets for."
                />

                <Toggle
                  checked={notifySound}
                  onChange={next => updateBool('space_notify_sound', next, setNotifySound)}
                  label="Notification sound"
                  description="Play a subtle sound for new in-app notifications."
                />

                <p className={styles.muted}>
                  These preferences are stored locally now. Backend enforcement will be wired to the notification system next.
                </p>
              </div>
            )}

            {section === 'auctions' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Auctions & Bidding</p>
                <p className={styles.cardSub}>Preferences for paddle behavior and auction room identity.</p>

                <Toggle
                  checked={confirmBids}
                  onChange={next => updateBool('space_confirm_bids', next, setConfirmBids)}
                  label="Confirm before bidding"
                  description="Show a confirmation step before placing a bid."
                />

                <Toggle
                  checked={showUsernameInLedger}
                  onChange={next => updateBool('space_show_username_ledger', next, setShowUsernameInLedger)}
                  label="Show username in bid ledger"
                  description="If off, the room can display your paddle number or nickname instead."
                />

                <div className={styles.fieldBlock}>
                  <label className={styles.fieldLabel} htmlFor="paddle-nickname">
                    Paddle nickname
                  </label>

                  <input
                    id="paddle-nickname"
                    className={styles.textInput}
                    value={paddleNickname}
                    onChange={e => setPaddleNickname(e.target.value)}
                    placeholder="Optional display name for auction rooms"
                    maxLength={24}
                  />

                  <p className={styles.muted}>
                    This will be used later in ticketed auction rooms when identity protection is enabled.
                  </p>
                </div>

                <button className={styles.primaryBtn} onClick={() => void saveAuctionPrefs()} disabled={saving}>
                  {saving ? <Loader2 size={15} className={styles.spin} /> : <Check size={15} />}
                  Save auction preferences
                </button>
              </div>
            )}

            {section === 'privacy' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Privacy & Security</p>
                <p className={styles.cardSub}>Identity, access, and account safety.</p>

                <div className={styles.statusCard}>
                  <div>
                    <p className={styles.statusLabel}>Face verification</p>
                    <p className={styles.statusValue}>Not set up</p>
                    <p className={styles.muted}>
                      ML identity checks will protect paid auction rooms and help prevent paddle sharing.
                    </p>
                  </div>

                  <button className={styles.secondaryBtn} disabled>
                    Set up soon
                  </button>
                </div>

                <div className={styles.statusCard}>
                  <div>
                    <p className={styles.statusLabel}>Blocked users</p>
                    <p className={styles.statusValue}>Managed in Messenger</p>
                    <p className={styles.muted}>
                      Blocking currently happens per conversation from the chat info panel.
                    </p>
                  </div>

                  <button className={styles.secondaryBtn} onClick={() => navigate('/messenger')}>
                    Open messenger
                  </button>
                </div>

                <div className={styles.statusCard}>
                  <div>
                    <p className={styles.statusLabel}>Account</p>
                    <p className={styles.statusValue}>Signed in as @{viewer || '—'}</p>
                    <p className={styles.muted}>Logging out clears local session data and closes chat sockets.</p>
                  </div>

                  <button className={styles.dangerBtn} onClick={logout} disabled={loggingOut}>
                    {loggingOut ? <Loader2 size={15} className={styles.spin} /> : <LogOut size={15} />}
                    Log out
                  </button>
                </div>
              </div>
            )}

            {section === 'house' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Auction House</p>
                <p className={styles.cardSub}>Your rostrum standing and access to the studio.</p>

                <div className={styles.houseRow}>
                  <span className={styles.houseLabel}>Status</span>
                  <span className={`${styles.badge} ${houseClass}`}>{houseLabel}</span>
                </div>

                <div className={styles.actionGrid}>
                  {houseStatus === 'approved' ? (
                    <button className={styles.actionBtn} onClick={() => navigate('/sales/control')}>
                      <Landmark size={16} />
                      <span>Enter Auction House Studio</span>
                    </button>
                  ) : (
                    <button className={styles.actionBtn} onClick={() => navigate('/house/apply')}>
                      <Landmark size={16} />
                      <span>{houseStatus === 'rejected' ? 'Reapply for the rostrum' : 'Apply for the rostrum'}</span>
                    </button>
                  )}

                  <button className={styles.actionBtn} onClick={() => navigate('/auctions')}>
                    <Gavel size={16} />
                    <span>View auction floor</span>
                  </button>
                </div>

                <p className={styles.muted}>
                  Auction management stays in the Studio. Settings only links to it.
                </p>
              </div>
            )}

            {section === 'support' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Support & Rules</p>
                <p className={styles.cardSub}>Important expectations for bidding, conduct, and account security.</p>

                <ul className={styles.list}>
                  <li>
                    <strong>Auction bids are binding.</strong>
                    <span>Do not bid unless you intend to pay for winning lots.</span>
                  </li>

                  <li>
                    <strong>Paddles are personal.</strong>
                    <span>Ticket codes and future face verification exist to prevent shared bidding identities.</span>
                  </li>

                  <li>
                    <strong>No chat in auction rooms.</strong>
                    <span>The house may post one-way announcements only.</span>
                  </li>

                  <li>
                    <strong>Wallet-funded tickets.</strong>
                    <span>Ticket purchases debit your wallet and issue a paddle code.</span>
                  </li>

                  <li>
                    <strong>Privacy matters.</strong>
                    <span>Biometric verification will be optional until required by a specific high-security room.</span>
                  </li>
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}