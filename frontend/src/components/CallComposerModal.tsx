import { useEffect, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { API } from '../lib/sales'
import {
  createCommunityCall,
  updateCommunityCall,
  type CallPayload,
  type CommunityCall,
} from '../lib/community'
import styles from './CallComposerModal.module.css'

const KINDS: { value: string; label: string }[] = [
  { value: 'open_call', label: 'Open call' },
  { value: 'exhibition', label: 'Exhibition' },
  { value: 'residency', label: 'Residency' },
  { value: 'consignment', label: 'Consignment window' },
  { value: 'award', label: 'Award / prize' },
  { value: 'talk', label: 'Talk' },
  { value: 'studio_visit', label: 'Studio visit' },
  { value: 'deadline', label: 'Deadline' },
]

const STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
]

function toLocalInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function mediumToList(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean).slice(0, 8)
}

export function CallComposerModal({
  open,
  viewer,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean
  viewer: string
  initial: CommunityCall | null
  onClose: () => void
  onSaved: (call: CommunityCall) => void
}) {
  const isEdit = !!initial

  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('open_call')
  const [status, setStatus] = useState('open')
  const [description, setDescription] = useState('')
  const [scene, setScene] = useState('')
  const [location, setLocation] = useState('')
  const [online, setOnline] = useState(false)
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [deadlineAt, setDeadlineAt] = useState('')
  const [applyUrl, setApplyUrl] = useState('')
  const [region, setRegion] = useState('')
  const [medium, setMedium] = useState('')
  const [ageMax, setAgeMax] = useState('')
  const [coverUrl, setCoverUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setTitle(initial?.title || '')
    setKind(initial?.kind || 'open_call')
    setStatus(initial?.status || 'open')
    setDescription(initial?.description || '')
    setScene(initial?.scene || '')
    setLocation(initial?.location || '')
    setOnline(!!initial?.online)
    setStartsAt(toLocalInput(initial?.starts_at))
    setEndsAt(toLocalInput(initial?.ends_at))
    setDeadlineAt(toLocalInput(initial?.deadline_at))
    setApplyUrl(initial?.apply_url || '')
    setCoverUrl(initial?.cover_url || '')
    const el = (initial?.eligibility || {}) as Record<string, unknown>
    setRegion(typeof el.region === 'string' ? el.region : '')
    setMedium(
      Array.isArray(el.medium)
        ? (el.medium as unknown[]).join(', ')
        : typeof el.medium === 'string'
          ? el.medium
          : '',
    )
    setAgeMax(el.age_max != null ? String(el.age_max) : '')
  }, [open, initial])

  if (!open) return null

  const onPickCover = async (file?: File | null) => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API}/upload`, { method: 'POST', body: fd })
      const d = await res.json()
      if (d.error) setError(d.error)
      else if (d.url) setCoverUrl(d.url)
    } catch {
      setError('Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    if (!viewer) return
    const t = title.trim()
    if (!t) {
      setError('Title is required.')
      return
    }

    const eligibility: Record<string, unknown> = {}
    if (region.trim()) eligibility.region = region.trim()
    const meds = mediumToList(medium)
    if (meds.length) eligibility.medium = meds
    const am = parseInt(ageMax, 10)
    if (!isNaN(am) && am > 0) eligibility.age_max = am

    const payload: CallPayload = {
      title: t,
      kind,
      status,
      description: description.trim() || null,
      scene: scene.trim() || null,
      location: location.trim() || null,
      online,
      starts_at: startsAt || null,
      ends_at: endsAt || null,
      deadline_at: deadlineAt || null,
      apply_url: applyUrl.trim() || null,
      cover_url: coverUrl.trim() || null,
      eligibility,
    }

    setSaving(true)
    setError('')
    const d = isEdit
      ? await updateCommunityCall(viewer, initial!.id, payload)
      : await createCommunityCall(viewer, payload)
    setSaving(false)

    if (d.error) {
      setError(d.error)
      return
    }
    if (d.call) onSaved(d.call)
    else onClose()
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.panel}
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit opportunity' : 'Post an opportunity'}
      >
        <div className={styles.head}>
          <strong>{isEdit ? 'Edit opportunity' : 'Post an opportunity'}</strong>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.body}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Title *</span>
            <input
              className={styles.input}
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={180}
              placeholder="ART X Lagos — Emerging Prize"
            />
          </label>

          <div className={styles.row2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Kind</span>
              <select className={styles.input} value={kind} onChange={e => setKind(e.target.value)}>
                {KINDS.map(k => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Status</span>
              <select className={styles.input} value={status} onChange={e => setStatus(e.target.value)}>
                {STATUSES.map(s => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Description</span>
            <textarea
              className={styles.textarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={4}
              placeholder="What is it, who is it for, what should applicants send?"
            />
          </label>

          <div className={styles.row2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Scene / city</span>
              <input
                className={styles.input}
                value={scene}
                onChange={e => setScene(e.target.value)}
                maxLength={40}
                placeholder="Lagos"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Location</span>
              <input
                className={styles.input}
                value={location}
                onChange={e => setLocation(e.target.value)}
                maxLength={120}
                placeholder="Lagos, Nigeria"
              />
            </label>
          </div>

          <label className={styles.check}>
            <input type="checkbox" checked={online} onChange={e => setOnline(e.target.checked)} />
            <span>Online / hybrid opportunity</span>
          </label>

          <div className={styles.row3}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Starts</span>
              <input type="datetime-local" className={styles.input} value={startsAt} onChange={e => setStartsAt(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Ends</span>
              <input type="datetime-local" className={styles.input} value={endsAt} onChange={e => setEndsAt(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Deadline</span>
              <input type="datetime-local" className={styles.input} value={deadlineAt} onChange={e => setDeadlineAt(e.target.value)} />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Apply URL</span>
            <input
              className={styles.input}
              value={applyUrl}
              onChange={e => setApplyUrl(e.target.value)}
              maxLength={500}
              placeholder="https://… (external form)"
            />
          </label>

          <div className={styles.row3}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Region</span>
              <input className={styles.input} value={region} onChange={e => setRegion(e.target.value)} placeholder="West Africa" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Media (comma sep.)</span>
              <input className={styles.input} value={medium} onChange={e => setMedium(e.target.value)} placeholder="painting, textile" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Max age</span>
              <input type="number" min={0} className={styles.input} value={ageMax} onChange={e => setAgeMax(e.target.value)} placeholder="35" />
            </label>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Cover image (optional)</span>
            <div className={styles.coverRow}>
              {coverUrl ? (
                <span className={styles.coverThumb} style={{ backgroundImage: `url(${coverUrl})` }} />
              ) : (
                <span className={styles.coverEmpty}>No cover</span>
              )}
              <label className={styles.uploadBtn}>
                {uploading ? <Loader2 size={14} className={styles.spin} /> : <Upload size={14} />}
                <span>{coverUrl ? 'Replace' : 'Upload'}</span>
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={e => void onPickCover(e.target.files?.[0])}
                  disabled={uploading}
                />
              </label>
              {coverUrl && (
                <button className={styles.linkBtn} onClick={() => setCoverUrl('')}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={styles.foot}>
          <button className={styles.ghostBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className={styles.primaryBtn} onClick={() => void submit()} disabled={saving || uploading}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Post opportunity'}
          </button>
        </div>
      </div>
    </div>
  )
}