import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createSale,
  getSaleView,
  normalizeAccessMode,
  normalizeYouTubeEmbed,
  setStream,
  updateSale,
  type AccessMode,
  type Sale,
} from '../../lib/sales'
import { ImageUploadField } from './ImageUploadField'
import styles from './control.module.css'

type FormState = {
  title: string
  description: string
  image_url: string
  tier: AccessMode
  currency: string
  ticket_currency: string
  ticket_price: string
  ticket_capacity: string
  starts_at: string
  ends_at: string
  stream_type: string
  stream_url: string
}

const BLANK: FormState = {
  title: '',
  description: '',
  image_url: '',
  tier: 'open',
  currency: 'NGN',
  ticket_currency: '',
  ticket_price: '0',
  ticket_capacity: '',
  starts_at: '',
  ends_at: '',
  stream_type: 'external',
  stream_url: '',
}

// backend returns "2026-09-20 20:17:31.058504"; <input type=datetime-local> wants
// "2026-09-20T20:17". Trim to the minute; sending that string back is a valid
// postgres timestamp literal.
function toLocalInput(ts?: string | null): string {
  if (!ts) return ''
  return ts.replace(' ', 'T').slice(0, 16)
}

function fromSale(sale: Sale | null): FormState {
  if (!sale) return { ...BLANK }
  return {
    title: sale.title ?? '',
    description: sale.description ?? '',
    image_url: sale.image_url ?? '',
    tier: normalizeAccessMode(sale.access_mode ?? sale.tier),
    currency: sale.currency ?? 'NGN',
    ticket_currency: sale.ticket_currency ?? '',
    ticket_price: String(sale.ticket_price ?? '0'),
    ticket_capacity: sale.ticket_capacity == null ? '' : String(sale.ticket_capacity),
    starts_at: toLocalInput(sale.starts_at),
    ends_at: toLocalInput(sale.ends_at),
    stream_type: sale.stream_type ?? 'external',
    stream_url: sale.stream_url ?? '',
  }
}

// A sale coming from /my_sales or /sales is THIN: those SELECTs omit
// stream_url / image_url / description, so fromSale() would seed empty boxes
// and the YouTube/image would "vanish on edit". Detect that so we can self-heal
// by fetching the full sale (exactly the pattern LotForm already uses for lots).
function isThinSale(s: Sale | null | undefined): boolean {
  return !!s && (s.stream_url === undefined || s.image_url === undefined || s.description === undefined)
}

// Upgrade a recognizable YouTube link to a playable /embed/<id>; pass through
// any non-YouTube external URL (Twitch/Zoom/other) untouched so we never
// destroy a valid link. normalizeYouTubeEmbed returns '' for anything it can't
// map to a video id, so `|| raw` keeps those as-is (the room's render guard is
// the safety net for un-embeddable forms).
function prepareStreamUrl(raw: string): string {
  const t = (raw || '').trim()
  if (!t) return ''
  return normalizeYouTubeEmbed(t) || t
}

// ---------------------------------------------------------------------------
// Local, dependency-free draft hook. Autosaves the in-progress form to
// localStorage so an accidental X / backdrop click / tab crash can never erase
// a half-filled sale. Inlined (not a shared export) on purpose: zero
// missing-export risk, and the two forms use different state shapes anyway.
// ---------------------------------------------------------------------------
function useLocalDraft<T>(key: string) {
  const [restored, setRestored] = useState<T | null>(null)
  const [hasDraft, setHasDraft] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        setRestored(JSON.parse(raw) as T)
        setHasDraft(true)
      }
    } catch {
      /* corrupt draft -> ignore */
    }
  }, [key])

  const save = useCallback(
    (value: T) => {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        try {
          localStorage.setItem(key, JSON.stringify(value))
        } catch {
          /* quota / private mode -> best effort */
        }
      }, 350)
    },
    [key],
  )

  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
    setHasDraft(false)
    setRestored(null)
  }, [key])

  const dismiss = useCallback(() => {
    setHasDraft(false)
    setRestored(null)
  }, [])

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  return { restored, hasDraft, save, clear, dismiss }
}

export function SaleForm({
  mode,
  initial,
  viewer,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  initial: Sale | null
  viewer: string
  onClose: () => void
  onSaved: () => void
}) {
  // Fast-path seed from whatever the parent handed us, then self-heal if thin.
  const [resolvedSale, setResolvedSale] = useState<Sale | null>(
    mode === 'edit' && initial && !isThinSale(initial) ? initial : null,
  )
  const [resolving, setResolving] = useState(mode === 'edit' && (!initial || isThinSale(initial)))
  const [resolveError, setResolveError] = useState('')

  const [form, setForm] = useState<FormState>(() =>
    fromSale(mode === 'edit' ? resolvedSale : null),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)

  // draft / discard / resume UI
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [restoredNotice, setRestoredNotice] = useState(false)
  const [resumeChoice, setResumeChoice] = useState<null | 'resume' | 'discard'>(null)

  const draftKey =
    mode === 'create' ? 'sale:new' : `sale:${(resolvedSale?.id ?? initial?.id) ?? 'unk'}`
  const draft = useLocalDraft<FormState>(draftKey)

  // Edit + thin/missing source -> fetch the full sale and re-seed (fixes the
  // "YouTube/image vanishes on edit" data gap without touching the backend).
  useEffect(() => {
    if (mode !== 'edit') return
    if (resolvedSale) return
    const id = Number(initial?.id)
    if (!Number.isFinite(id) || id <= 0) {
      setResolving(false)
      setResolveError('No sale id was provided to edit.')
      return
    }
    let alive = true
    setResolving(true)
    setResolveError('')
    getSaleView(id, viewer).then(d => {
      if (!alive) return
      if (d.error || !d.sale) {
        setResolveError(d.error || 'Sale unavailable.')
        setResolving(false)
        return
      }
      setResolvedSale(d.sale)
      setForm(fromSale(d.sale))
      setDirty(false) // server seed is the baseline, not a user edit
      setResolving(false)
    })
    return () => {
      alive = false
    }
  }, [mode, viewer, initial?.id, resolvedSale])

  // Create mode: auto-restore an abandoned draft so reopening "New sale" brings
  // back what was typed (the literal "start from the beginning" pain).
  useEffect(() => {
    if (mode !== 'create') return
    if (!draft.hasDraft || !draft.restored) return
    setForm(draft.restored)
    setDirty(true)
    setRestoredNotice(true)
    // run once per mount/key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, draftKey])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => {
      const next = { ...prev, [key]: value }
      draft.save(next)
      return next
    })
    setDirty(true)
  }

  const validate = (): string => {
    if (!form.title.trim()) return 'Title is required.'

    const price = Number(form.ticket_price)
    if (!Number.isFinite(price) || price < 0) return 'Paddle price must be a number ≥ 0.'

    if (form.ticket_capacity !== '') {
      const cap = Number(form.ticket_capacity)
      if (!Number.isInteger(cap) || cap <= 0) {
        return 'Capacity must be a whole number > 0 (or blank for unlimited).'
      }
    }

    const ccy = form.currency.trim().toUpperCase()
    const tccy = form.ticket_currency.trim().toUpperCase()

    if (ccy && !/^[A-Z]{3}$/.test(ccy)) return 'Sale currency must be a 3-letter code (e.g. NGN).'
    if (tccy && !/^[A-Z]{3}$/.test(tccy)) return 'Paddle currency must be a 3-letter code (or blank to match sale).'

    return ''
  }

  const corePayload = (): Record<string, unknown> => ({
    title: form.title.trim(),
    description: form.description,
    image_url: form.image_url.trim() || null,
    tier: form.tier,
    currency: form.currency.trim().toUpperCase() || undefined,
    ticket_currency: form.ticket_currency.trim().toUpperCase() || undefined,
    ticket_price: Number(form.ticket_price || 0),
    ticket_capacity: form.ticket_capacity === '' ? null : Number(form.ticket_capacity),
    starts_at: form.starts_at || null,
    ends_at: form.ends_at || null,
  })

  const streamPayload = (): Record<string, unknown> => ({
    stream_type: form.stream_type || 'external',
    stream_url: prepareStreamUrl(form.stream_url),
    // preserve the existing peer id so set_stream doesn't blank it
    stream_peer_id: (resolvedSale ?? initial)?.stream_peer_id ?? '',
  })

  // Guarded close: never discard a dirty form on a stray click/Esc/X.
  const attemptClose = useCallback(() => {
    if (busy) return
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    draft.clear()
    onClose()
  }, [busy, dirty, draft, onClose])

  // keep latest attemptClose for the once-bound Esc listener
  const closeRef = useRef(attemptClose)
  closeRef.current = attemptClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const doDiscard = () => {
    draft.clear()
    setDirty(false)
    setConfirmDiscard(false)
    onClose()
  }

  const startFresh = () => {
    draft.clear()
    setForm({ ...BLANK })
    setDirty(false)
    setRestoredNotice(false)
  }

  const submit = async () => {
    if (!viewer) {
      setError(
        'No signed-in house detected. Sign in again, or make login calls setViewer(data.username).',
      )
      return
    }

    const v = validate()
    if (v) {
      setError(v)
      return
    }

    setBusy(true)
    setError('')

    if (mode === 'create') {
      // create_sale's INSERT does NOT persist stream_*, so we send the body
      // (harmless if a future backend accepts it) AND, crucially, follow up with
      // setStream on the new id so the broadcast actually sticks. Without the
      // setStream call the YouTube link is lost on create -> the "vanishes on
      // edit" symptom's first half.
      const r = await createSale(viewer, {
        ...corePayload(),
        stream_type: form.stream_type || 'external',
        stream_url: prepareStreamUrl(form.stream_url),
      })

      if (r.error) {
        setBusy(false)
        setError(r.error)
        return
      }

      const newId = (r as any)?.sale?.id ?? (r as any)?.id
      if (newId) {
        const st = await setStream(newId, viewer, streamPayload())
        if (st.error) {
          // core saved but stream failed -> keep modal open, show why, DON'T clear draft
          setBusy(false)
          setError(`Sale created, but the broadcast link failed to save: ${st.error}`)
          return
        }
      }

      setBusy(false)
      draft.clear()
      onSaved()
      onClose()
      return
    }

    // edit: need a resolved id (self-heal above guarantees it for thin sources)
    const editId = Number((resolvedSale ?? initial)?.id)
    if (!Number.isFinite(editId) || editId <= 0) {
      setBusy(false)
      setError(resolveError || 'Could not resolve the sale to edit. Reload and try again.')
      return
    }

    const up = await updateSale(editId, viewer, corePayload())
    if (up.error) {
      setBusy(false)
      setError(up.error)
      return
    }

    const st = await setStream(editId, viewer, streamPayload())
    setBusy(false)
    onSaved() // core change persisted regardless; refresh the list

    if (st.error) {
      setError(st.error) // stream failed but core saved -> keep open so house sees why
      return
    }

    draft.clear()
    onClose()
  }

  const ended = (resolvedSale ?? initial)?.status === 'ended'
  const readOnly = busy || ended || resolving

  const showResumeBanner =
    mode === 'edit' && draft.hasDraft && !!draft.restored && resumeChoice === null && !resolving

  return (
    <div className={styles.formOverlay} onMouseDown={attemptClose}>
      <div className={styles.formCard} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.formHead}>
          <div>
            <h2 className={styles.formTitle}>{mode === 'create' ? 'New sale' : 'Edit sale'}</h2>
            {resolving ? (
              <div className={styles.hint}>Loading sale details…</div>
            ) : resolvedSale || initial ? (
              <div className={styles.hint}>
                Sale #{(resolvedSale ?? initial)!.id} · {(resolvedSale ?? initial)!.status}
              </div>
            ) : null}
          </div>
          <button className={styles.iconBtn} onClick={attemptClose} aria-label="Close">
            ×
          </button>
        </div>

        {resolveError ? <div className={styles.error}>{resolveError}</div> : null}
        {ended ? <div className={styles.error}>This sale has ended and is read-only.</div> : null}
        {error ? <div className={styles.error}>{error}</div> : null}

        {restoredNotice && mode === 'create' ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.6rem',
              flexWrap: 'wrap',
              margin: '0 0 0.75rem',
              padding: '0.55rem 0.7rem',
              borderRadius: 12,
              fontSize: '0.8rem',
              color: '#14532d',
              background: 'rgba(20, 83, 45, 0.08)',
              border: '1px solid rgba(20, 83, 45, 0.16)',
            }}
          >
            <span>Restored your unsaved draft.</span>
            <button type="button" className={styles.linkButton} onClick={startFresh} disabled={busy}>
              Start fresh
            </button>
          </div>
        ) : null}

        {showResumeBanner ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.6rem',
              flexWrap: 'wrap',
              margin: '0 0 0.75rem',
              padding: '0.55rem 0.7rem',
              borderRadius: 12,
              fontSize: '0.8rem',
              color: '#92400e',
              background: 'rgba(146, 64, 14, 0.08)',
              border: '1px solid rgba(146, 64, 14, 0.16)',
            }}
          >
            <span>You have unsaved edits for this sale from a previous session.</span>
            <span style={{ display: 'inline-flex', gap: '0.5rem' }}>
              <button
                type="button"
                className={`${styles.linkButton} ${styles.primaryLink}`}
                onClick={() => {
                  if (draft.restored) {
                    setForm(draft.restored)
                    setDirty(true)
                  }
                  setResumeChoice('resume')
                }}
                disabled={busy}
              >
                Resume
              </button>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  draft.clear()
                  setResumeChoice('discard')
                }}
                disabled={busy}
              >
                Discard
              </button>
            </span>
          </div>
        ) : null}

        <div className={styles.formGrid}>
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="Harmattan Sale — Evening Session"
              disabled={readOnly}
            />
          </label>

          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Description</span>
            <textarea
              className={styles.textarea}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="What this session is about."
              disabled={readOnly}
            />
          </label>

          <div className={`${styles.field} ${styles.fieldFull}`}>
            <ImageUploadField
              label="Poster image"
              hint="Upload from your device, or paste an image URL. Shown on the floor card and the ticket-page hero."
              value={form.image_url}
              onChange={url => set('image_url', url)}
              disabled={readOnly}
              aspect="16 / 9"
            />
          </div>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Access &amp; pricing</legend>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Access mode</span>
              <select
                className={styles.select}
                value={form.tier}
                onChange={e => set('tier', e.target.value as AccessMode)}
                disabled={readOnly}
              >
                <option value="open">Open — anyone can claim a paddle</option>
                <option value="vip">VIP — active VIP members only</option>
                <option value="invite">Invite — house-issued paddles only</option>
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Paddle price</span>
              <input
                className={styles.input}
                value={form.ticket_price}
                onChange={e => set('ticket_price', e.target.value)}
                inputMode="decimal"
                disabled={readOnly}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Sale currency</span>
              <input
                className={styles.input}
                value={form.currency}
                onChange={e => set('currency', e.target.value)}
                placeholder="NGN"
                maxLength={3}
                disabled={readOnly}
              />
              <span className={styles.hint}>ISO code. Lots are priced in this currency.</span>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Paddle currency</span>
              <input
                className={styles.input}
                value={form.ticket_currency}
                onChange={e => set('ticket_currency', e.target.value)}
                placeholder="same as sale"
                maxLength={3}
                disabled={readOnly}
              />
              <span className={styles.hint}>Blank = charge the paddle fee in the sale currency.</span>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Capacity</span>
              <input
                className={styles.input}
                value={form.ticket_capacity}
                onChange={e => set('ticket_capacity', e.target.value)}
                inputMode="numeric"
                placeholder="unlimited"
                disabled={readOnly}
              />
              <span className={styles.hint}>Max paddles. Blank = unlimited.</span>
            </label>
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Schedule</legend>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Starts at</span>
              <input
                className={styles.input}
                type="datetime-local"
                value={form.starts_at}
                onChange={e => set('starts_at', e.target.value)}
                disabled={readOnly}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Ends at</span>
              <input
                className={styles.input}
                type="datetime-local"
                value={form.ends_at}
                onChange={e => set('ends_at', e.target.value)}
                disabled={readOnly}
              />
              <span className={styles.hint}>Drives the live “ends in…” countdown.</span>
            </label>
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Broadcast</legend>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Stream type</span>
              <select
                className={styles.select}
                value={form.stream_type}
                onChange={e => set('stream_type', e.target.value)}
                disabled={readOnly}
              >
                <option value="external">External (YouTube / Twitch / Zoom)</option>
              </select>
              <span className={styles.hint}>In-app video is deferred; external embed only.</span>
            </label>

            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.label}>Stream URL</span>
              <input
                className={styles.input}
                value={form.stream_url}
                onChange={e => set('stream_url', e.target.value)}
                placeholder="https://youtu.be/… or https://www.youtube.com/watch?v=…"
                disabled={readOnly}
              />
              <span className={styles.hint}>
                YouTube links are auto-converted to a playable embed on save. Twitch/Zoom links are kept as-is.
              </span>
            </label>
          </div>
        </fieldset>

        {confirmDiscard ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.6rem',
              flexWrap: 'wrap',
              margin: '0.75rem 0 0',
              padding: '0.6rem 0.75rem',
              borderRadius: 12,
              fontSize: '0.82rem',
              color: '#8b1f2f',
              background: 'rgba(139, 31, 47, 0.07)',
              border: '1px solid rgba(139, 31, 47, 0.18)',
            }}
          >
            <span>Discard your unsaved changes?</span>
            <span style={{ display: 'inline-flex', gap: '0.5rem' }}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setConfirmDiscard(false)}
                disabled={busy}
              >
                Keep editing
              </button>
              <button
                type="button"
                className={`${styles.linkButton} ${styles.primaryLink}`}
                onClick={doDiscard}
                disabled={busy}
              >
                Discard
              </button>
            </span>
          </div>
        ) : null}

        <div className={styles.formActions}>
          <button
            className={`${styles.linkButton} ${styles.primaryLink}`}
            onClick={() => void submit()}
            disabled={readOnly || (mode === 'edit' && !resolvedSale)}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create sale' : 'Save changes'}
          </button>
          <button className={styles.linkButton} onClick={attemptClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}