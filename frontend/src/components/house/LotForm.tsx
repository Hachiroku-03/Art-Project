import { useEffect, useState } from 'react'
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
  /** Authoritative id for edit mode. If `initial` is stale/missing, the form
   *  fetches the real lot by this id instead of dead-ending on "Nothing to edit." */
  lotId?: number | null
  onClose: () => void
  onSaved: () => void
}) {
  // Resolved lot = the source of truth for edit. Start from `initial` fast-path,
  // then self-heal by fetching if `initial` had no usable id.
  const [resolved, setResolved] = useState<Lot | null>(
    mode === 'edit' && initial && Number.isFinite(Number(initial.id)) ? initial : null,
  )
  const [resolving, setResolving] = useState(mode === 'edit' && !resolved)
  const [resolveError, setResolveError] = useState('')

  const [form, setForm] = useState<LotFormState>(() => fromLot(resolved))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Edit mode: if we don't already have a valid lot, fetch it from the sale.
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
      setResolving(false)
    })

    return () => {
      alive = false
    }
  }, [mode, saleId, viewer, lotId, resolved, (initial as any)?.id])

  const set = <K extends keyof LotFormState>(key: K, value: LotFormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

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
      onSaved()
      onClose()
      return
    }

    // EDIT: require a verified id. No more silent "Nothing to edit."
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
    onSaved()
    onClose()
  }

  const readOnly = busy || locked || resolving

  return (
    <div className={styles.formOverlay} onMouseDown={onClose}>
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
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">
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

        <div className={styles.formActions}>
          <button
            className={`${styles.linkButton} ${styles.primaryLink}`}
            onClick={() => void submit()}
            disabled={readOnly || (mode === 'edit' && !resolved)}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Add lot' : 'Save lot'}
          </button>
          <button className={styles.linkButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}