import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  Globe,
  Loader2,
  Lock,
  Search,
  Users,
  X,
} from 'lucide-react'
import {
  cancelGroupJoinRequest,
  fetchDiscoverGroups,
  joinOrRequestGroup,
  type DiscoverGroup,
} from '../../lib/chat'
import styles from './GroupDiscoveryPanel.module.css'

function firstLetter(name?: string | null) {
  return (name || '?')[0]?.toUpperCase() || '?'
}

function GroupAvatar({
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

export function GroupDiscoveryPanel({ viewer }: { viewer: string }) {
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<DiscoverGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!viewer) {
      setGroups([])
      return
    }

    setLoading(true)

    try {
      const rows = await fetchDiscoverGroups(viewer, query.trim(), 40)
      if (mounted.current) setGroups(rows)
    } catch {
      if (mounted.current) setGroups([])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [viewer, query])

  useEffect(() => {
    if (!viewer) return

    const timer = window.setTimeout(() => {
      void load()
    }, 250)

    return () => window.clearTimeout(timer)
  }, [viewer, load])

  const handleAction = useCallback(
    async (group: DiscoverGroup) => {
      if (!viewer) return

      setBusyId(group.id)
      setMessage('')

      try {
        if (group.request_status === 'pending') {
          const d = await cancelGroupJoinRequest(viewer, group.id)

          if (d.error) {
            setMessage(d.error)
            return
          }

          setGroups(prev =>
            prev.map(g =>
              g.id === group.id
                ? {
                    ...g,
                    request_status: 'none',
                  }
                : g,
            ),
          )

          setMessage(d.message || 'Request cancelled.')
          return
        }

        const d = await joinOrRequestGroup(viewer, group.id)

        if (d.error) {
          setMessage(d.error)
          return
        }

        if (d.status === 'joined') {
          setMessage('')
          navigate('/messenger', {
            state: {
              openConversationId: group.id,
            },
          })
          return
        }

        setGroups(prev =>
          prev.map(g =>
            g.id === group.id
              ? {
                  ...g,
                  request_status: 'pending',
                }
              : g,
          ),
        )

        setMessage(d.message || 'Join request sent.')
      } catch {
        setMessage('Network error.')
      } finally {
        setBusyId(null)
      }
    },
    [navigate, viewer],
  )

  if (!viewer) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>Log in to discover groups.</p>
      </div>
    )
  }

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>Discover groups</h2>
          <p className={styles.sub}>
            Find open floors and request access to approval-only communities.
          </p>
        </div>

        <div className={styles.count}>
          <Users size={14} />
          <span>{groups.length}</span>
        </div>
      </div>

      <div className={styles.searchWrap}>
        <Search size={15} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search group name or description…"
          aria-label="Search groups"
        />
        {query && (
          <button
            className={styles.clearBtn}
            onClick={() => setQuery('')}
            aria-label="Clear group search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {message && <p className={styles.message}>{message}</p>}

      <div className={styles.list}>
        {loading ? (
          <div className={styles.state}>
            <Loader2 size={18} className={styles.spin} />
            <span>Finding groups…</span>
          </div>
        ) : groups.length === 0 ? (
          <div className={styles.state}>
            <Globe size={18} />
            <span>No discoverable groups yet.</span>
          </div>
        ) : (
          groups.map(group => {
            const busy = busyId === group.id
            const pending = group.request_status === 'pending'
            const isOpen = group.join_mode === 'open'

            const actionLabel = pending
              ? 'Cancel request'
              : isOpen
                ? 'Join group'
                : 'Request to join'

            return (
              <article key={group.id} className={styles.row}>
                <GroupAvatar src={group.image_url} name={group.name} />

                <div className={styles.body}>
                  <div className={styles.top}>
                    <strong>{group.name || 'Untitled group'}</strong>

                    <span className={`${styles.mode} ${isOpen ? styles.modeOpen : styles.modeRequest}`}>
                      {isOpen ? (
                        <>
                          <Globe size={11} /> Open
                        </>
                      ) : (
                        <>
                          <Lock size={11} /> Approval
                        </>
                      )}
                    </span>
                  </div>

                  <p className={styles.desc}>
                    {group.description || 'No description.'}
                  </p>

                  <p className={styles.meta}>
                    {group.member_count} members
                    {pending ? ' · request pending' : ''}
                  </p>
                </div>

                <button
                  className={`${styles.action} ${
                    pending ? styles.actionCancel : styles.actionJoin
                  }`}
                  onClick={() => void handleAction(group)}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : pending ? (
                    <X size={14} />
                  ) : isOpen ? (
                    <Check size={14} />
                  ) : (
                    <Users size={14} />
                  )}

                  <span>{actionLabel}</span>
                </button>
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}