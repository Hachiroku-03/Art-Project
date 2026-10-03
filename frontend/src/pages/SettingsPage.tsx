import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
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
import { LANGUAGES } from '../lib/languages'
import {
  fetchAccountSettings,
  updateAccountLanguage,
  updateAuctionPreferences,
  updateNotificationPreferences,
  updatePrivacyPreferences,
  type AccountSettings,
  type AuctionPatch,
  type NotificationCategoryKey,
  type NotificationPatch,
  type PrivacyPatch,
} from '../lib/settings'
import styles from './SettingsPage.module.css'

const AUTH_API =
  (import.meta as any).env?.VITE_AUTH_API_URL || 'http://localhost:8000'

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

const NOTIFICATION_ROWS: {
  key: NotificationCategoryKey
  label: string
  description: string
  allowSound: boolean
}[] = [
  {
    key: 'messages',
    label: 'Direct messages',
    description: 'Notify when someone sends you a chat message.',
    allowSound: true,
  },
  {
    key: 'mentions',
    label: 'Mentions',
    description: 'Notify when someone @mentions you in chat or posts.',
    allowSound: true,
  },
  {
    key: 'groups',
    label: 'Groups',
    description: 'Join requests, approvals, removals, and group notices.',
    allowSound: false,
  },
  {
    key: 'posts',
    label: 'Posts & activity',
    description: 'Likes, comments, replies, and follows.',
    allowSound: false,
  },
  {
    key: 'auctions',
    label: 'Auctions',
    description: 'Outbid alerts, lot results, starting reminders, house notices.',
    allowSound: true,
  },
  {
    key: 'wallet',
    label: 'Wallet & tickets',
    description: 'Ticket purchases, invoices, payment status.',
    allowSound: false,
  },
  {
    key: 'security',
    label: 'Security',
    description: 'Login alerts, passkey changes, verification events.',
    allowSound: true,
  },
  {
    key: 'system',
    label: 'System',
    description: 'Product notices and maintenance messages.',
    allowSound: false,
  },
]

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  busy,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  busy?: boolean
}) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <p className={styles.toggleLabel}>
          {label}
          {busy && <Loader2 size={13} className={styles.spin} />}
        </p>
        <span className={styles.toggleDesc}>{description}</span>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled || busy}
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
  const [settings, setSettings] = useState<AccountSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [paddleNickname, setPaddleNickname] = useState('')
  const [houseStatus, setHouseStatus] = useState<HouseStatus>('loading')
  const [loggingOut, setLoggingOut] = useState(false)

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

  const loadSettings = useCallback(async () => {
    if (!viewer) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    try {
      const d = await fetchAccountSettings(viewer)

      if (d.error) {
        setError(d.error)
        setSettings(null)
      } else {
        setSettings(d)
        setPaddleNickname(d.auctions?.paddle_nickname || '')
      }
    } catch {
      setError('Could not load settings.')
    } finally {
      setLoading(false)
    }
  }, [viewer])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

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

  const patchNotifications = useCallback(
    async (patch: NotificationPatch, key: string) => {
      if (!viewer) return

      setBusyKey(key)
      setError('')

      try {
        const d = await updateNotificationPreferences(viewer, patch)

        if (d.error) {
          setError(d.error)
          return
        }

        if (d.notifications) {
          setSettings(prev =>
            prev
              ? {
                  ...prev,
                  notifications: d.notifications!,
                }
              : prev,
          )
        }

        flash('Saved.')
      } catch {
        setError('Network error.')
      } finally {
        setBusyKey(null)
      }
    },
    [flash, viewer],
  )

  const patchAuctions = useCallback(
    async (patch: AuctionPatch, key: string) => {
      if (!viewer) return

      setBusyKey(key)
      setError('')

      try {
        const d = await updateAuctionPreferences(viewer, patch)

        if (d.error) {
          setError(d.error)
          return
        }

        if (d.auctions) {
          setSettings(prev =>
            prev
              ? {
                  ...prev,
                  auctions: d.auctions!,
                }
              : prev,
          )
          setPaddleNickname(d.auctions.paddle_nickname || '')
        }

        flash('Saved.')
      } catch {
        setError('Network error.')
      } finally {
        setBusyKey(null)
      }
    },
    [flash, viewer],
  )

  const patchPrivacy = useCallback(
    async (patch: PrivacyPatch, key: string) => {
      if (!viewer) return

      setBusyKey(key)
      setError('')

      try {
        const d = await updatePrivacyPreferences(viewer, patch)

        if (d.error) {
          setError(d.error)
          return
        }

        if (d.privacy) {
          setSettings(prev =>
            prev
              ? {
                  ...prev,
                  privacy: d.privacy!,
                }
              : prev,
          )
        }

        flash('Saved.')
      } catch {
        setError('Network error.')
      } finally {
        setBusyKey(null)
      }
    },
    [flash, viewer],
  )

  const changeLanguage = useCallback(
    async (language: string) => {
      if (!viewer) return

      setBusyKey('language')
      setError('')

      try {
        const d = await updateAccountLanguage(viewer, language)

        if (d.error) {
          setError(d.error)
          return
        }

        if (d.language) {
          setSettings(prev =>
            prev
              ? {
                  ...prev,
                  language: d.language!,
                }
              : prev,
          )
        }

        flash('Language saved.')
      } catch {
        setError('Network error.')
      } finally {
        setBusyKey(null)
      }
    },
    [flash, viewer],
  )

  const logout = useCallback(() => {
    if (!window.confirm('Log out of THE SPACE?')) return

    setLoggingOut(true)

    try {
      teardown()
    } catch {
      // ignore
    }

    localStorage.clear()
    navigate('/login', { replace: true })
  }, [navigate])

  if (loading) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.shell}>
          <div className={styles.loadingCard}>
            <Loader2 size={20} className={styles.spin} />
            <p>Loading settings…</p>
          </div>
        </div>
      </main>
    )
  }

  if (!settings) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.shell}>
          <div className={styles.errorCard}>
            <AlertCircle size={18} />
            <p>{error || 'Settings are unavailable right now.'}</p>
            <button className={styles.primaryBtn} onClick={() => void loadSettings()}>
              Retry
            </button>
          </div>
        </div>
      </main>
    )
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

        {error && (
          <p className={styles.error}>
            <AlertCircle size={14} /> {error}
          </p>
        )}

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
                <p className={styles.cardSub}>
                  Basic identity used across feed, messenger, wallet, and auctions.
                </p>

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
                    <strong className={styles.infoValue}>
                      {tier === 'vip' ? 'VIP' : 'Standard'}
                    </strong>
                  </div>
                </div>

                <div className={styles.actionGrid}>
                  <button
                    className={styles.actionBtn}
                    onClick={() => navigate(`/profile/${viewer}`)}
                  >
                    <User size={16} />
                    <span>View public profile</span>
                  </button>

                  <button className={styles.actionBtn} onClick={() => navigate('/wallet')}>
                    <Wallet size={16} />
                    <span>Open wallet</span>
                  </button>

                  <button
                    className={styles.actionBtn}
                    onClick={() => navigate('/notifications')}
                  >
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
                    App / translation language
                  </label>

                  <select
                    id="settings-language"
                    className={styles.select}
                    value={settings.language}
                    onChange={e => void changeLanguage(e.target.value)}
                    disabled={busyKey === 'language'}
                  >
                    {LANGUAGES.map(l => (
                      <option key={l.code} value={l.code}>
                        {l.native} — {l.label}
                      </option>
                    ))}
                  </select>

                  <p className={styles.muted}>
                    Saved to your account. Messenger translation and future localized notices will use this value.
                  </p>
                </div>
              </div>
            )}

            {section === 'notifications' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Notifications</p>
                <p className={styles.cardSub}>
                  Control what appears in your notification center and when it makes sound.
                </p>

                <ToggleRow
                  label="Master notifications"
                  description="Turn all in-app notifications on or off."
                  checked={settings.notifications.master}
                  busy={busyKey === 'notif-master'}
                  onChange={next =>
                    void patchNotifications({ master: next }, 'notif-master')
                  }
                />

                {NOTIFICATION_ROWS.map(row => (
                  <div key={row.key} className={styles.prefGroup}>
                    <ToggleRow
                      label={row.label}
                      description={row.description}
                      checked={settings.notifications[row.key].in_app}
                      busy={busyKey === `notif-${row.key}-in_app`}
                      onChange={next =>
                        void patchNotifications(
                          { [row.key]: { in_app: next } } as NotificationPatch,
                          `notif-${row.key}-in_app`,
                        )
                      }
                    />

                    {row.allowSound && (
                      <ToggleRow
                        label={`${row.label} sound`}
                        description="Play a subtle sound for this category."
                        checked={settings.notifications[row.key].sound}
                        busy={busyKey === `notif-${row.key}-sound`}
                        onChange={next =>
                          void patchNotifications(
                            { [row.key]: { sound: next } } as NotificationPatch,
                            `notif-${row.key}-sound`,
                          )
                        }
                      />
                    )}
                  </div>
                ))}

                <p className={styles.muted}>
                  These preferences are enforced by the backend when notifications are created.
                </p>
              </div>
            )}

            {section === 'auctions' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Auctions & Bidding</p>
                <p className={styles.cardSub}>
                  Preferences for paddle behavior and auction room identity.
                </p>

                <ToggleRow
                  label="Confirm before bidding"
                  description="Show a confirmation step before placing a bid."
                  checked={settings.auctions.confirm_bids}
                  busy={busyKey === 'auction-confirm'}
                  onChange={next =>
                    void patchAuctions({ confirm_bids: next }, 'auction-confirm')
                  }
                />

                <ToggleRow
                  label="Show username in bid ledger"
                  description="If off, auction rooms can display your paddle nickname or anonymous bidder label."
                  checked={settings.auctions.show_username_in_ledger}
                  busy={busyKey === 'auction-ledger'}
                  onChange={next =>
                    void patchAuctions({ show_username_in_ledger: next }, 'auction-ledger')
                  }
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
                    Used in ticketed auction rooms when identity protection is enabled.
                  </p>

                  <button
                    className={styles.primaryBtn}
                    onClick={() =>
                      void patchAuctions(
                        { paddle_nickname: paddleNickname.trim() || null },
                        'auction-nickname',
                      )
                    }
                    disabled={busyKey === 'auction-nickname'}
                  >
                    {busyKey === 'auction-nickname' ? (
                      <Loader2 size={15} className={styles.spin} />
                    ) : (
                      <Check size={15} />
                    )}
                    Save paddle nickname
                  </button>
                </div>
              </div>
            )}

            {section === 'privacy' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Privacy & Security</p>
                <p className={styles.cardSub}>
                  Identity, access, and account safety.
                </p>

                <div className={styles.fieldBlock}>
                  <label className={styles.fieldLabel} htmlFor="allow-mentions">
                    Who can mention me
                  </label>

                  <select
                    id="allow-mentions"
                    className={styles.select}
                    value={settings.privacy.allow_mentions}
                    onChange={e =>
                      void patchPrivacy(
                        { allow_mentions: e.target.value as PrivacyPatch['allow_mentions'] },
                        'privacy-mentions',
                      )
                    }
                    disabled={busyKey === 'privacy-mentions'}
                  >
                    <option value="everyone">Everyone</option>
                    <option value="followers">People I follow</option>
                    <option value="group_members">Group members only</option>
                    <option value="nobody">Nobody</option>
                  </select>
                </div>

                <ToggleRow
                  label="Show online status"
                  description="Allow others to see when you are active in messenger."
                  checked={settings.privacy.show_online_status}
                  busy={busyKey === 'privacy-online'}
                  onChange={next =>
                    void patchPrivacy({ show_online_status: next }, 'privacy-online')
                  }
                />

                <div className={styles.statusCard}>
                  <div>
                    <p className={styles.statusLabel}>Face verification</p>
                    <p className={styles.statusValue}>
                      {settings.identity.face_verification === 'none'
                        ? 'Not set up'
                        : settings.identity.face_verification === 'enabled'
                          ? 'Enabled'
                          : settings.identity.face_verification === 'pending'
                            ? 'Pending'
                            : settings.identity.face_verification}
                    </p>
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
                    <p className={styles.statusValue}>
                      {settings.blocked_count} blocked
                    </p>
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
                    <p className={styles.muted}>
                      Logging out clears local session data and closes chat sockets.
                    </p>
                  </div>

                  <button className={styles.dangerBtn} onClick={logout} disabled={loggingOut}>
                    {loggingOut ? (
                      <Loader2 size={15} className={styles.spin} />
                    ) : (
                      <LogOut size={15} />
                    )}
                    Log out
                  </button>
                </div>
              </div>
            )}

            {section === 'house' && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Auction House</p>
                <p className={styles.cardSub}>
                  Your rostrum standing and access to the studio.
                </p>

                <div className={styles.houseRow}>
                  <span className={styles.houseLabel}>Status</span>
                  <span className={`${styles.badge} ${houseClass}`}>{houseLabel}</span>
                </div>

                <div className={styles.actionGrid}>
                  {houseStatus === 'approved' ? (
                    <button
                      className={styles.actionBtn}
                      onClick={() => navigate('/sales/control')}
                    >
                      <Landmark size={16} />
                      <span>Enter Auction House Studio</span>
                    </button>
                  ) : (
                    <button
                      className={styles.actionBtn}
                      onClick={() => navigate('/house/apply')}
                    >
                      <Landmark size={16} />
                      <span>
                        {houseStatus === 'rejected'
                          ? 'Reapply for the rostrum'
                          : 'Apply for the rostrum'}
                      </span>
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
                <p className={styles.cardSub}>
                  Important expectations for bidding, conduct, and account security.
                </p>

                <ul className={styles.list}>
                  <li>
                    <strong>Auction bids are binding.</strong>
                    <span>Do not bid unless you intend to pay for winning lots.</span>
                  </li>

                  <li>
                    <strong>Paddles are personal.</strong>
                    <span>
                      Ticket codes and future face verification exist to prevent shared bidding identities.
                    </span>
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
                    <span>
                      Biometric verification will be optional until required by a specific high-security room.
                    </span>
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