import { useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, Loader2, Trash2, Link2 } from 'lucide-react'
import { API } from '../../lib/sales'
import styles from './ImageUploadField.module.css'

export function ImageUploadField({
  label = 'Cover image',
  value,
  onChange,
  hint = 'Upload from your device, or paste an image URL.',
  disabled = false,
  aspect = '16 / 9',
}: {
  label?: string
  value: string
  onChange: (url: string) => void
  hint?: string
  disabled?: boolean
  aspect?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasImage = !!value.trim()
  const looksLikeUrl = hasImage && /^(https?:\/\/|\/)/i.test(value.trim())

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.')
      return
    }

    setBusy(true)
    setError('')

    const form = new FormData()
    form.append('file', file)

    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: form })
      const d = await res.json()

      if (d.error) {
        setError(d.error)
      } else if (d.url) {
        onChange(d.url)
      } else {
        setError('Upload returned no URL.')
      }
    } catch {
      setError('Could not reach the upload server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>

      <div className={styles.preview} style={{ aspectRatio: aspect }}>
        {looksLikeUrl ? (
          <img src={value} alt="" className={styles.previewImg} />
        ) : (
          <div className={styles.previewEmpty}>
            <ImagePlus size={22} />
            <span>No image yet</span>
          </div>
        )}

        {busy ? (
          <div className={styles.previewBusy}>
            <Loader2 size={18} className={styles.spin} />
            <span>Uploading…</span>
          </div>
        ) : null}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.uploadBtn}
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy}
        >
          {busy ? <Loader2 size={14} className={styles.spin} /> : <ImagePlus size={14} />}
          {hasImage ? 'Replace' : 'Upload from device'}
        </button>

        {hasImage ? (
          <button
            type="button"
            className={styles.removeBtn}
            onClick={() => {
              onChange('')
              setError('')
            }}
            disabled={disabled || busy}
          >
            <Trash2 size={14} />
            Remove
          </button>
        ) : null}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={pick}
          disabled={disabled || busy}
        />
      </div>

      <label className={styles.urlRow}>
        <Link2 size={13} className={styles.urlIcon} />
        <input
          className={styles.urlInput}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="https://… or /uploads/…"
          disabled={disabled || busy}
          spellCheck={false}
        />
      </label>

      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  )
}