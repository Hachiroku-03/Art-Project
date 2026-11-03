import { useCallback, useEffect, useRef, useState } from 'react'
import { addLot, getSaleView, updateLot, type Lot } from '../../lib/sales'
import { ImageUploadField } from './ImageUploadField'
import styles from './control.module.css'

type LotFormState = {
  title: string
  description: string
  image_url: string
  starting_price: string
  reserve: string
  estimate_low: string
  estimate_high: string
  currency: string
}

const BLANK: LotFormState = {
  title: '',
  description: '',
  image_url: '',
  starting_price: '0',
  reserve: '',
  estimate_low: '',
  estimate_high: '',
  currency: '',
}

function numToStr(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : ''
}

function fromLot(lot: Lot | null | undefined): LotFormState {
  if (!lot) return { ...BLANK }
  return {
    title: lot.title ?? '',
    description: lot.description ?? '',
    image_url: lot.image_url ?? '',
    starting_price: numToStr(lot.starting_price) || '0',
    reserve: numToStr(lot.reserve),
    estimate_low: numToStr(lot.estimate_low),
    estimate_high: numToStr(lot.estimate_high),
    currency: lot.currency ?? '',
  }
}

function parseOpt(key: string, raw: string): { value: number | null; error: string } {
  if (raw.trim() === '') return { value: null, error: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { value: null, error: `${key} must be a number` }
  if (n < 0) return { value: null, error: `${key} cannot be negative` }
  return { value: Math.round(n * 100) / 100, error: '' }
}

// identical local draft hook as SaleForm (inlined on purpose: no shared export)
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
          /* best effort */
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

export function LotForm({
  mode,
  saleId,
  viewer,
  initial,
  lotId,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  saleId: number | string
  viewer: string
  initial: Lot | null
  lotId?: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const [resolved, setResolved] = useState<Lot | null>(
    mode === 'edit' && initial && Number.isFinite(Number(initial.id)) ? initial : null,
  )
  const [resolving, setResolving] = useState(mode === 'edit' && !resolved)
  const [resolveError, setResolveError] = useState('')

  const [form, setForm] = useState<LotFormState>(() => fromLot(resolved))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)

  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [restoredNotice, setRestoredNotice] = useState(false)
  const [resumeChoice, setResumeChoice] = useState<null | 'resume' | 'discard'>(null)

  const draftKey =
    mode === 'create' ? 'lot:new' : `lot:${(resolved?.id ?? lotId ?? (initial as any)?.id) ?? 'unk'}`
  const draft = useLocalDraft<LotFormState>(draftKey)

  // Edit mode: self-heal by fetching the real lot if `initial` was stale/missing.
  useEffect(() => {
    if (mode !== 'edit') return
    if (resolved && Number.isFinite(Number(resolved.id))) return

    const targetId = Number(lotId ?? (initial as any)?.id)
    if (!Number.isFinite(targetId) || targetId <= 0) {
      setResolving(false)
      setResolveError('No lot id was provided to edit.')
      return
    }

    let alive = true
    setResolving(true)
    setResolveError('')

    getSaleView(saleId, viewer).then(d => {
      if (!alive) return
      if (d.error) {
        setResolveError(d.error)
        setResolving(false)
        return
      }
      const found = (d.lots || []).find(l => Number(l.id) === targetId) || null
      if (!found) {
        setResolveError('That lot no longer exists in this sale.')
        setResolving(false)
        return
      }
      setResolved(found)
      setForm(fromLot(found))
      setDirty(false)
      setResolving(false)
    })

    return () => {
      alive = false
    }
  }, [mode, saleId, viewer, lotId, resolved, (initial as any)?.id])

  // Create mode: auto-restore an abandoned lot draft.
  useEffect(() => {
    if (mode !== 'create') return
    if (!draft.hasDraft || !draft.restored) return
    setForm(draft.restored)
    setDirty(true)
    setRestoredNotice(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, draftKey])

  const set = <K extends keyof LotFormState>(key: K, value: LotFormState[K]) => {
    setForm(prev => {
      const next = { ...prev, [key]: value }
      draft.save(next)
      return next
    })
    setDirty(true)
  }

  const locked = resolved?.status === 'sold' || resolved?.status === 'passed'
  const onBlock = resolved?.status === 'on_block'

  const validate = (): string => {
    if (!form.title.trim()) return 'Title is required.'

    const start = parseOpt('Starting price', form.starting_price)
    if (start.error) return start.error
    const reserve = parseOpt('Reserve', form.reserve)
    if (reserve.error) return reserve.error
    const low = parseOpt('Estimate low', form.estimate_low)
    if (low.error) return low.error
    const high = parseOpt('Estimate high', form.estimate_high)
    if (high.error) return high.error

    if (low.value != null && high.value != null && high.value < low.value) {
      return 'Estimate high cannot be lower than estimate low.'
    }

    const ccy = form.currency.trim().toUpperCase()
    if (ccy && !/^[A-Z]{3}$/.test(ccy)) return 'Currency must be a 3-letter code (e.g. NGN).'

    return ''
  }

  const payload = (): Record<string, unknown> => {
    const start = parseOpt('Starting price', form.starting_price)
    const reserve = parseOpt('Reserve', form.reserve)
    const low = parseOpt('Estimate low', form.estimate_low)
    const high = parseOpt('Estimate high', form.estimate_high)
    const ccy = form.currency.trim().toUpperCase()

    const body: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description,
      image_url: form.image_url.trim() || null,
      starting_price: start.value ?? 0,
      reserve: reserve.value,
      estimate_low: low.value,
      estimate_high: high.value,
    }
    if (ccy) body.currency = ccy
    return body
  }

  const attemptClose = useCallback(() => {
    if (busy) return
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    draft.clear()
    onClose()
  }, [busy, dirty, draft, onClose])

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
      setError('No signed-in house detected.')
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
      const r = await addLot(saleId, viewer, payload() as any)
      setBusy(false)
      if (r.error) {
        setError(r.error)
        return
      }
      draft.clear()
      onSaved()
      onClose()
      return
    }

    const editId = Number(resolved?.id)
    if (!Number.isFinite(editId) || editId <= 0) {
      setBusy(false)
      setError(resolveError || 'Could not resolve the lot to edit. Reload the catalogue and try again.')
      return
    }

    const r = await updateLot(editId, viewer, payload() as any)
    setBusy(false)
    if (r.error) {
      setError(r.error)
      return
    }
    draft.clear()
    onSaved()
    onClose()
  }

  const readOnly = busy || locked || resolving

  const showResumeBanner =
    mode === 'edit' && draft.hasDraft && !!draft.restored && resumeChoice === null && !resolving

  return (
    <div className={styles.formOverlay} onMouseDown={attemptClose}>
      <div className={styles.formCard} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.formHead}>
          <div>
            <h2 className={styles.formTitle}>{mode === 'create' ? 'New lot' : 'Edit lot'}</h2>
            {resolved ? (
              <div className={styles.hint}>
                Lot {resolved.position} · {resolved.status}
              </div>
            ) : mode === 'edit' ? (
              <div className={styles.hint}>{resolving ? 'Loading lot…' : 'Lot unavailable'}</div>
            ) : null}
          </div>
          <button className={styles.iconBtn} onClick={attemptClose} aria-label="Close">
            ×
          </button>
        </div>

        {resolveError ? <div className={styles.error}>{resolveError}</div> : null}
        {locked ? (
          <div className={styles.error}>This lot is finalized (sold/passed) and cannot be edited.</div>
        ) : null}
        {onBlock && !locked ? (
          <div className={styles.hint}>
            On the block: title, description and image can still change, but price / reserve / currency are locked.
          </div>
        ) : null}
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
            <span>Restored your unsaved lot draft.</span>
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
            <span>You have unsaved edits for this lot from a previous session.</span>
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
              placeholder="Ochre, after rain"
              disabled={readOnly}
            />
          </label>

          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Description</span>
            <textarea
              className={styles.textarea}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Medium, dimensions, provenance…"
              disabled={readOnly}
            />
          </label>

          <div className={`${styles.field} ${styles.fieldFull}`}>
            <ImageUploadField
              label="Lot image"
              hint="Upload from your device, or paste a URL. Hidden from bidders until the lot is revealed."
              value={form.image_url}
              onChange={url => set('image_url', url)}
              disabled={readOnly}
              aspect="4 / 5"
            />
          </div>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Pricing</legend>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Starting price</span>
              <input
                className={styles.input}
                value={form.starting_price}
                onChange={e => set('starting_price', e.target.value)}
                inputMode="decimal"
                disabled={readOnly || onBlock}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Reserve (hidden)</span>
              <input
                className={styles.input}
                value={form.reserve}
                onChange={e => set('reserve', e.target.value)}
                inputMode="decimal"
                placeholder="none"
                disabled={readOnly || onBlock}
              />
              <span className={styles.hint}>Never shown to bidders. Blank = no reserve.</span>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Estimate low</span>
              <input
                className={styles.input}
                value={form.estimate_low}
                onChange={e => set('estimate_low', e.target.value)}
                inputMode="decimal"
                disabled={readOnly}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Estimate high</span>
              <input
                className={styles.input}
                value={form.estimate_high}
                onChange={e => set('estimate_high', e.target.value)}
                inputMode="decimal"
                disabled={readOnly}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Currency</span>
              <input
                className={styles.input}
                value={form.currency}
                onChange={e => set('currency', e.target.value)}
                placeholder="sale currency"
                maxLength={3}
                disabled={readOnly || onBlock}
              />
              <span className={styles.hint}>Blank = inherit the sale currency.</span>
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
            disabled={readOnly || (mode === 'edit' && !resolved)}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Add lot' : 'Save lot'}
          </button>
          <button className={styles.linkButton} onClick={attemptClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}