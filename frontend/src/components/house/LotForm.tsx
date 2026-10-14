import { useState } from 'react'
import { addLot } from '../../lib/sales'
import styles from './control.module.css'

type LotFormState = {
  title: string
  description: string
  image_url: string
  starting_price: string
  reserve: string
  estimate_low: string
  estimate_high: string
}

const BLANK: LotFormState = {
  title: '',
  description: '',
  image_url: '',
  starting_price: '',
  reserve: '',
  estimate_low: '',
  estimate_high: '',
}

function numOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

export function LotForm({
  saleId,
  viewer,
  currency,
  disabled,
  onClose,
  onAdded,
}: {
  saleId: number
  viewer: string
  currency: string
  disabled?: boolean
  onClose: () => void
  onAdded: () => void
}) {
  const [form, setForm] = useState<LotFormState>(BLANK)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = <K extends keyof LotFormState>(key: K, value: LotFormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const validate = (): string => {
    if (!viewer) return 'No signed-in house detected.'
    if (!form.title.trim()) return 'Lot title is required.'

    const starting = Number(form.starting_price)
    if (!Number.isFinite(starting) || starting < 0) {
      return 'Starting price must be a number ≥ 0.'
    }

    const reserve = numOrNull(form.reserve)
    if (form.reserve.trim() && reserve === null) return 'Reserve must be a valid number or blank.'
    if (reserve !== null && reserve < 0) return 'Reserve cannot be negative.'

    const low = numOrNull(form.estimate_low)
    const high = numOrNull(form.estimate_high)

    if (form.estimate_low.trim() && low === null) return 'Estimate low must be a valid number or blank.'
    if (form.estimate_high.trim() && high === null) return 'Estimate high must be a valid number or blank.'
    if (low !== null && low < 0) return 'Estimate low cannot be negative.'
    if (high !== null && high < 0) return 'Estimate high cannot be negative.'
    if (low !== null && high !== null && high < low) return 'Estimate high cannot be lower than estimate low.'

    return ''
  }

  const submit = async () => {
    const v = validate()
    if (v) {
      setError(v)
      return
    }

    setBusy(true)
    setError('')

    const result = await addLot(saleId, viewer, {
      title: form.title.trim(),
      description: form.description,
      image_url: form.image_url.trim() || undefined,
      starting_price: Number(form.starting_price),
      reserve: numOrNull(form.reserve),
      estimate_low: numOrNull(form.estimate_low),
      estimate_high: numOrNull(form.estimate_high),
      currency,
    })

    setBusy(false)

    if (result.error) {
      setError(result.error)
      return
    }

    onAdded()
    onClose()
  }

  return (
    <div className={styles.formOverlay} onMouseDown={onClose}>
      <div className={styles.formCard} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.formHead}>
          <div>
            <h2 className={styles.formTitle}>Add lot</h2>
            <div className={styles.hint}>Sale #{saleId} · currency {currency}</div>
          </div>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        {disabled ? (
          <div className={styles.error}>This sale is ended and cannot receive new lots.</div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.formGrid}>
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="Untitled Study"
            />
          </label>

          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Description</span>
            <textarea
              className={styles.textarea}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Medium, size, condition, story."
            />
          </label>

          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Image URL</span>
            <input
              className={styles.input}
              value={form.image_url}
              onChange={e => set('image_url', e.target.value)}
              placeholder="https://…"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Starting price</span>
            <input
              className={styles.input}
              value={form.starting_price}
              onChange={e => set('starting_price', e.target.value)}
              inputMode="decimal"
              placeholder="1000"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Reserve</span>
            <input
              className={styles.input}
              value={form.reserve}
              onChange={e => set('reserve', e.target.value)}
              inputMode="decimal"
              placeholder="optional"
            />
            <span className={styles.hint}>Hidden from buyers. Lot passes below this.</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Estimate low</span>
            <input
              className={styles.input}
              value={form.estimate_low}
              onChange={e => set('estimate_low', e.target.value)}
              inputMode="decimal"
              placeholder="optional"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Estimate high</span>
            <input
              className={styles.input}
              value={form.estimate_high}
              onChange={e => set('estimate_high', e.target.value)}
              inputMode="decimal"
              placeholder="optional"
            />
          </label>
        </div>

        <div className={styles.formActions}>
          <button
            className={`${styles.linkButton} ${styles.primaryLink}`}
            onClick={() => void submit()}
            disabled={busy || disabled}
          >
            {busy ? 'Adding…' : 'Add sealed lot'}
          </button>

          <button className={styles.linkButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}