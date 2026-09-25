import { useEffect, useState, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Heart, MessageCircle, Landmark, Crown, ArrowRight, Camera, Pencil, Check, X } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { SaleCard } from '../components/auctions/SaleCard'
import { fetchProfile, type ProfilePayload, type ProfilePost } from '../lib/profile'
import { API } from '../lib/sales'
import styles from './ProfilePage.module.css'

type Tab = 'works' | 'rooms' | 'collects'

export function ProfilePage() {
  const { username } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- all hooks, top level, above any return ----
  const [data, setData] = useState<ProfilePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('works')
  const [typeFilter, setTypeFilter] = useState('all')
  const [note, setNote] = useState('')

  const [editing, setEditing] = useState(false)          // details form open?
  const [editName, setEditName] = useState('')
  const [editBio, setEditBio] = useState('')
  const [saving, setSaving] = useState(false)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!username) return
    if (!localStorage.getItem('space_token')) { navigate('/login', { replace: true }); return }
    let alive = true
    setLoading(true)
    fetchProfile(username, viewer).then(res => {
      if (!alive) return
      if ((res as { error?: string }).error) setError((res as { error: string }).error)
      else setData(res as ProfilePayload)
      setLoading(false)
    })
    return () => { alive = false }
  }, [username, viewer, navigate])

  const types = useMemo(() => (data ? Array.from(new Set(data.posts.map(p => p.type))) : []), [data])
  const visibleWorks = useMemo(() => {
    if (!data) return []
    return typeFilter === 'all' ? data.posts : data.posts.filter(p => p.type === typeFilter)
  }, [data, typeFilter])

  // ---- early returns (all hooks above) ----
  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>

  if (!data) return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.missing}>
        <p>{error || 'This member has no wall yet.'}</p>
        <button className={styles.ghostBtn} onClick={() => navigate('/feed')}>Back to the feed</button>
      </div>
    </main>
  )

  const { user, counts } = data
  const houseStatus = user.house_status || 'none'
  const isHouse = user.role === 'house' || houseStatus === 'approved'   // synced with the floor
  const isVip = user.tier === 'vip'
  const bannerSrc = user.banner_url || data.posts.find(p => p.image_url)?.image_url || null
  const initial = (user.display_name || user.username || '?')[0].toUpperCase()
  const followerWord = isHouse ? 'collectors' : 'followers'

  async function toggleFollow() {
    const res = await fetch(`${API}/follow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, target: user.username }) })
    const d = await res.json()
    setData(prev => prev ? { ...prev, user: { ...prev.user, followed_by_viewer: !!d.following }, counts: { ...prev.counts, followers: prev.counts.followers + (d.following ? 1 : -1) } } : prev)
  }

  async function putProfile(fields: Record<string, string>) {
    const res = await fetch(`${API}/profile/${encodeURIComponent(user.username)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, ...fields }),
    })
    return res.json()
  }

  async function uploadAndSet(file: File, field: 'avatarUrl' | 'bannerUrl') {
    const form = new FormData(); form.append('file', file)
    try {
      const up = await fetch(`${API}/upload`, { method: 'POST', body: form }).then(r => r.json())
      if (!up.url) { setNote('Upload failed.'); return }
      const d = await putProfile({ [field]: up.url })
      if (d.error) { setNote(d.error); return }
      setData(prev => prev ? { ...prev, user: { ...prev.user, [field === 'avatarUrl' ? 'avatar_url' : 'banner_url']: up.url } } : prev)
    } catch { setNote('Could not reach the server.') }
  }

  function pickBanner(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (f) uploadAndSet(f, 'bannerUrl'); e.target.value = ''
  }
  function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (f) uploadAndSet(f, 'avatarUrl'); e.target.value = ''
  }

  function openEdit() { setEditName(user.display_name || ''); setEditBio(user.bio || ''); setEditing(true); setNote('') }
  async function saveDetails() {
    setSaving(true); setNote('')
    const d = await putProfile({ displayName: editName.trim(), bio: editBio.trim() })
    setSaving(false)
    if (d.error) { setNote(d.error); return }
    setData(prev => prev ? { ...prev, user: { ...prev.user, display_name: editName.trim() || null, bio: editBio.trim() || null } } : prev)
    setEditing(false)
  }

  function renderWorkTile(p: ProfilePost) {
    return (
      <button key={p.id} className={styles.tile} onClick={() => navigate(`/post/${p.id}`)}>
        {p.image_url ? <img src={p.image_url} alt={p.title} /> : <div className={styles.tileBlank} />}
        <div className={styles.tileLabel}>
          <span className={styles.tileTitle}>{p.title}</span>
          <span className={styles.tileMeta}>{p.current_bid ? `$${p.current_bid}` : p.price ? `$${p.price}` : p.type}</span>
        </div>
      </button>
    )
  }

  // self rostrum button mirrors the floor's three states exactly
  const rostrumBtn = isHouse
    ? { label: 'Enter the control room', to: '/sales/control', disabled: false, icon: <Landmark size={14} /> }
    : houseStatus === 'pending'
      ? { label: 'Rostrum under review', to: '', disabled: true, icon: <Landmark size={14} /> }
      : { label: houseStatus === 'rejected' ? 'Reapply for the rostrum' : 'Request the rostrum', to: '/house/apply', disabled: false, icon: <ArrowRight size={13} /> }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.wall}>

        <div className={styles.banner}>
          {bannerSrc ? <img src={bannerSrc} alt="" className={styles.bannerImg} /> : <div className={styles.bannerBlank} />}
          <div className={styles.bannerScrim} />
          {user.is_self && (
            <button className={styles.bannerEdit} onClick={() => bannerInputRef.current?.click()} aria-label="Change banner">
              <Camera size={14} /> Banner
            </button>
          )}
          <input ref={bannerInputRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={pickBanner} />
        </div>

        {/* essay left, portrait right — only the disc straddles the banner now */}
        <div className={styles.identity}>
          <div className={styles.essay}>
            <h1 className={styles.displayName}>{user.display_name || user.username}</h1>
            <p className={styles.handle}>
              @{user.username}
              {isHouse
                ? <span className={styles.houseSeal}><Landmark size={11} /> Auction House</span>
                : <span className={styles.artistTag}>Artist</span>}
              {isVip && <span className={styles.vipTag}><Crown size={10} fill="currentColor" /> VIP</span>}
            </p>
            {isHouse && user.house_name && <p className={styles.tradingAs}>Trading as {user.house_name}</p>}
            <div className={styles.rule} />
            <p className={styles.statPlate}>
              <strong>{counts.works}</strong> works
              <span className={styles.dot}>·</span>
              <strong>{counts.followers}</strong> {followerWord}
              <span className={styles.dot}>·</span>
              following <strong>{counts.following}</strong>
            </p>
            <p className={styles.statement}>
              {user.bio?.trim()
                ? user.bio
                : isHouse
                  ? 'An accredited floor — rooms open on the calendar, lots sealed until the hammer.'
                  : 'No statement yet. The wall speaks through the work.'}
            </p>
          </div>
          <div className={styles.portrait}>
            <div className={`${styles.avatarDisc} ${isVip ? styles.vipRing : ''} ${isHouse ? styles.houseRing : ''}`}>
              {user.avatar_url ? <img src={user.avatar_url} alt="" className={styles.avatarImg} /> : initial}
            </div>
            {user.is_self && (
              <button className={styles.avatarEdit} onClick={() => avatarInputRef.current?.click()} aria-label="Change profile picture">
                <Camera size={13} />
              </button>
            )}
            <input ref={avatarInputRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={pickAvatar} />
          </div>
        </div>

        {/* actions */}
        <div className={styles.actions}>
          {user.is_self ? (
            <>
              <button
                className={`${styles.solidBtn} ${rostrumBtn.disabled ? styles.btnQuiet : ''}`}
                disabled={rostrumBtn.disabled}
                onClick={() => rostrumBtn.to && navigate(rostrumBtn.to)}
              >
                {rostrumBtn.icon} {rostrumBtn.label}
              </button>
              <button className={styles.outlineBtn} onClick={openEdit}><Pencil size={13} /> Edit wall</button>
            </>
          ) : (
            <>
              <button className={`${styles.solidBtn} ${user.followed_by_viewer ? styles.on : ''}`} onClick={toggleFollow}>
                <Heart size={14} fill={user.followed_by_viewer ? 'currentColor' : 'none'} />
                {user.followed_by_viewer ? 'Following' : 'Follow'}
              </button>
              <button className={styles.outlineBtn} onClick={() => setNote('Direct messages arrive with the messenger phase.')}>
                <MessageCircle size={14} /> Message
              </button>
            </>
          )}
        </div>

        {/* inline details editor (self only) */}
        {editing && (
          <div className={styles.editPanel}>
            <label className={styles.editLabel}>Display name</label>
            <input className={styles.editInput} value={editName} onChange={e => setEditName(e.target.value)} placeholder="Your name" />
            <label className={styles.editLabel}>Curator’s statement</label>
            <textarea className={styles.editArea} rows={3} value={editBio} onChange={e => setEditBio(e.target.value)} placeholder="Who you are, what you chase." />
            <div className={styles.editRow}>
              <button className={styles.solidBtn} onClick={saveDetails} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
              <button className={styles.outlineBtn} onClick={() => setEditing(false)}><X size={14} /> Cancel</button>
            </div>
          </div>
        )}
        {note && <p className={styles.note}>{note}</p>}

        {/* tabs */}
        <div className={styles.tabs}>
          {(['works', 'rooms', 'collects'] as Tab[]).map(t => (
            <button key={t} className={`${styles.tab} ${tab === t ? styles.tabOn : ''}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'works' && types.length > 1 && (
          <div className={styles.filters}>
            <button className={`${styles.chip} ${typeFilter === 'all' ? styles.chipOn : ''}`} onClick={() => setTypeFilter('all')}>All</button>
            {types.map(t => (
              <button key={t} className={`${styles.chip} ${typeFilter === t ? styles.chipOn : ''}`} onClick={() => setTypeFilter(t)}>{t}</button>
            ))}
          </div>
        )}

        <div className={styles.content}>
          {tab === 'works' && (visibleWorks.length === 0
            ? <p className={styles.empty}>Nothing hung here yet.</p>
            : <div className={styles.masonry}>{visibleWorks.map(renderWorkTile)}</div>)}
          {tab === 'rooms' && (data.rooms.length === 0
            ? <p className={styles.empty}>{isHouse ? 'No rooms on the calendar yet.' : 'Collectors don’t host rooms — request the rostrum to open a floor.'}</p>
            : <div className={styles.roomGrid}>{data.rooms.map(r => <SaleCard key={r.id} sale={r} onOpen={() => navigate(`/sales/${r.id}`)} />)}</div>)}
          {tab === 'collects' && (data.collects.length === 0
            ? <p className={styles.empty}>Nothing collected yet.</p>
            : <div className={styles.masonry}>{data.collects.map(renderWorkTile)}</div>)}
        </div>

      </div>
    </main>
  )
}