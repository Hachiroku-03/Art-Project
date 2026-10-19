import { useState } from 'react'
import {
  createSale,
  normalizeAccessMode,
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
  const [form, setForm] = useState<FormState>(() => fromSale(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

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

    if (ccy && !/^[A-Z]{3}$/.test(ccy)) {
      return 'Sale currency must be a 3-letter code (e.g. NGN).'
    }

    if (tccy && !/^[A-Z]{3}$/.test(tccy)) {
      return 'Paddle currency must be a 3-letter code (or blank to match sale).'
    }

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
    stream_url: form.stream_url,
    // preserve the existing peer id so set_stream doesn't blank it
    stream_peer_id: initial?.stream_peer_id ?? '',
  })

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
      // poster + stream are accepted in the create body (after the backend fix)
      const r = await createSale(viewer, {
        ...corePayload(),
        stream_type: form.stream_type || 'external',
        stream_url: form.stream_url,
      })

      setBusy(false)

      if (r.error) {
        setError(r.error)
        return
      }

      onSaved()
      onClose()
      return
    }

    // edit: PATCH core, then set_stream (PATCH ignores stream fields)
    if (!initial) {
      setBusy(false)
      setError('Nothing to edit.')
      return
    }

    const up = await updateSale(initial.id, viewer, corePayload())

    if (up.error) {
      setBusy(false)
      setError(up.error)
      return
    }

    const st = await setStream(initial.id, viewer, streamPayload())

    setBusy(false)
    onSaved() // core change is persisted regardless; refresh the list

    if (st.error) {
      // stream failed but core saved — keep the modal open so the house sees why
      setError(st.error)
      return
    }

    onClose()
  }

  const ended = initial?.status === 'ended'
  const readOnly = busy || ended

  return (
    <div className={styles.formOverlay} onMouseDown={onClose}>
      <div className={styles.formCard} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.formHead}>
          <div>
            <h2 className={styles.formTitle}>
              {mode === 'create' ? 'New sale' : 'Edit sale'}
            </h2>

            {initial ? (
              <div className={styles.hint}>
                Sale #{initial.id} · {initial.status}
              </div>
            ) : null}
          </div>

          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {ended ? (
          <div className={styles.error}>This sale has ended and is read-only.</div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

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
              <span className={styles.hint}>
                Blank = charge the paddle fee in the sale currency.
              </span>
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
                placeholder="https://youtu.be/…"
                disabled={readOnly}
              />
            </label>
          </div>
        </fieldset>

        <div className={styles.formActions}>
          <button
            className={`${styles.linkButton} ${styles.primaryLink}`}
            onClick={() => void submit()}
            disabled={readOnly}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create sale' : 'Save changes'}
          </button>

          <button className={styles.linkButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}