import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarClock, ExternalLink, Loader2, MapPin, Pencil, Users } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { CallComposerModal } from '../components/CallComposerModal'
import {
  fetchCommunityCall,
  fetchCommunityCalls,
  toggleCommunityCallInterest,
  type CommunityCall,
} from '../lib/community'
import styles from './CallDetailPage.module.css'

function fmtDate(raw?: string | null) {
  if (!raw) return ''
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
}

function fmtDateTime(raw?: string | null) {
  if (!raw) return ''
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const KIND_LABEL: Record<string, string> = {
  exhibition: 'Exhibition',
  residency: 'Residency',
  consignment: 'Consignment window',
  open_call: 'Open call',
  award: 'Award / prize',
  talk: 'Talk',
  studio_visit: 'Studio visit',
  deadline: 'Deadline',
}

function kindLabel(k?: string | null) {
  return (k && KIND_LABEL[k]) || 'Opportunity'
}

export function CallDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const viewer = localStorage.getItem('space_user') || ''
  const callId = Number(id)

  const [call, setCall] = useState<CommunityCall | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [more, setMore] = useState<CommunityCall[]>([])
  const [busySave, setBusySave] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)

  const load = useCallback(async () => {
    if (!callId || isNaN(callId)) {
      setError('Invalid opportunity.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const c = await fetchCommunityCall(viewer, callId).catch(() => null)
    if (!c) {
      setCall(null)
      setError('This opportunity could not be found.')
      setLoading(false)
      return
    }
    setCall(c)
    setLoading(false)
    if (c.scene) {
      const rows = await fetchCommunityCalls(viewer, { scene: c.scene, status: 'open', limit: 4 }).catch(() => [])
      setMore(rows.filter(r => r.id !== c.id).slice(0, 3))
    } else {
      setMore([])
    }
  }, [callId, viewer])

  useEffect(() => {
    void load()
  }, [load])

  const onSave = useCallback(async () => {
    if (!viewer || !call) return
    const next = !call.interested_by_viewer
    setBusySave(true)
    setCall({ ...call, interested_by_viewer: next, interest_count: Math.max(0, call.interest_count + (next ? 1 : -1)) })
    const d = await toggleCommunityCallInterest(viewer, call.id)
    setBusySave(false)
    if (d.error) {
      setCall({ ...call, interested_by_viewer: !next, interest_count: Math.max(0, call.interest_count + (next ? -1 : 1)) })
    } else if (typeof d.count === 'number') {
      setCall(prev => (prev ? { ...prev, interest_count: d.count! } : prev))
    }
  }, [call, viewer])

  if (loading) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.center}>
          <Loader2 size={20} className={styles.spin} />
        </div>
      </main>
    )
  }

  if (!call) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.shell}>
          <button className={styles.backBtn} onClick={() => navigate('/community')}>
            <ArrowLeft size={15} /> Back to community
          </button>
          <div className={styles.notFound}>
            <p>{error || 'Opportunity not found.'}</p>
          </div>
        </div>
      </main>
    )
  }

  const closed = call.status !== 'open'
  const elig = (call.eligibility || {}) as Record<string, unknown>
  const eligRows: { label: string; value: string }[] = []
  if (typeof elig.region === 'string' && elig.region) eligRows.push({ label: 'Region', value: elig.region })
  if (Array.isArray(elig.medium)) eligRows.push({ label: 'Media', value: (elig.medium as unknown[]).join(', ') })
  else if (typeof elig.medium === 'string' && elig.medium) eligRows.push({ label: 'Media', value: elig.medium })
  if (elig.age_max != null) eligRows.push({ label: 'Max age', value: String(elig.age_max) })
  if (elig.age_min != null) eligRows.push({ label: 'Min age', value: String(elig.age_min) })

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.shell}>
        <button className={styles.backBtn} onClick={() => navigate('/community')}>
          <ArrowLeft size={15} /> Back to community
        </button>

        {call.cover_url && <div className={styles.cover} style={{ backgroundImage: `url(${call.cover_url})` }} />}

        <div className={styles.headRow}>
          <span className={styles.kind}>{kindLabel(call.kind)}</span>
          {call.scene && <span className={styles.sceneTag}>{call.scene}</span>}
          {closed && <span className={styles.statusTag}>{call.status === 'cancelled' ? 'Cancelled' : 'Closed'}</span>}
        </div>

        <h1 className={styles.title}>{call.title}</h1>

        <div className={styles.hostRow}>
          <span
            className={styles.hostAvatar}
            style={call.host_avatar ? { backgroundImage: `url(${call.host_avatar})` } : undefined}
          >
            {!call.host_avatar && (call.host_display || call.host_user_name || '?')[0]?.toUpperCase()}
          </span>
          <button className={styles.hostMid} onClick={() => navigate(`/profile/${call.host_user_name}`)}>
            <strong>{call.host_display || call.host_user_name}</strong>
            <span>Host</span>
          </button>
          {call.can_edit && (
            <button className={styles.editBtn} onClick={() => setComposerOpen(true)}>
              <Pencil size={14} /> Edit
            </button>
          )}
        </div>

        <div className={styles.metaGrid}>
          {call.deadline_at && (
            <div className={styles.metaItem}>
              <CalendarClock size={15} />
              <div>
                <span className={styles.metaLabel}>Deadline</span>
                <strong>{fmtDateTime(call.deadline_at)}</strong>
              </div>
            </div>
          )}
          {call.starts_at && (
            <div className={styles.metaItem}>
              <CalendarClock size={15} />
              <div>
                <span className={styles.metaLabel}>Starts</span>
                <strong>{fmtDate(call.starts_at)}</strong>
              </div>
            </div>
          )}
          {call.ends_at && (
            <div className={styles.metaItem}>
              <CalendarClock size={15} />
              <div>
                <span className={styles.metaLabel}>Ends</span>
                <strong>{fmtDate(call.ends_at)}</strong>
              </div>
            </div>
          )}
          <div className={styles.metaItem}>
            <MapPin size={15} />
            <div>
              <span className={styles.metaLabel}>Where</span>
              <strong>{call.online ? 'Online / hybrid' : call.location || '—'}</strong>
            </div>
          </div>
          <div className={styles.metaItem}>
            <Users size={15} />
            <div>
              <span className={styles.metaLabel}>Interested</span>
              <strong>{call.interest_count}</strong>
            </div>
          </div>
        </div>

        {call.description && <p className={styles.desc}>{call.description}</p>}

        {eligRows.length > 0 && (
          <div className={styles.eligBox}>
            <span className={styles.eligTitle}>Eligibility</span>
            <dl className={styles.eligList}>
              {eligRows.map(r => (
                <div key={r.label} className={styles.eligRow}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className={styles.actions}>
          <button
            className={`${styles.saveBtn} ${call.interested_by_viewer ? styles.saveBtnOn : ''}`}
            onClick={() => void onSave()}
            disabled={busySave}
          >
            {call.interested_by_viewer ? 'Saved' : 'Save opportunity'}
          </button>
          {!closed && call.apply_url && (
            <a className={styles.applyBtn} href={call.apply_url} target="_blank" rel="noopener noreferrer">
              Apply <ExternalLink size={14} />
            </a>
          )}
          {!closed && !call.apply_url && <span className={styles.noApply}>Applications handled offline</span>}
        </div>

        {more.length > 0 && (
          <div className={styles.moreBlock}>
            <span className={styles.moreTitle}>More in {call.scene}</span>
            <div className={styles.moreList}>
              {more.map(m => (
                <button key={m.id} className={styles.moreCard} onClick={() => navigate(`/calls/${m.id}`)}>
                  <span className={styles.moreKind}>{kindLabel(m.kind)}</span>
                  <strong>{m.title}</strong>
                  {m.deadline_at && <span className={styles.moreDate}>{fmtDate(m.deadline_at)}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <CallComposerModal
        open={composerOpen}
        viewer={viewer}
        initial={call}
        onClose={() => setComposerOpen(false)}
        onSaved={updated => {
          setCall(updated)
          setComposerOpen(false)
        }}
      />
    </main>
  )
}