import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, ExternalLink, ImagePlus, Link2, Loader2, Trash2 } from 'lucide-react'
import { API } from '../../lib/sales'
import styles from './ImageUploadField.module.css'

// ---------------------------------------------------------------------------
// Self-contained URL normalizer. Deliberately NOT imported from sales.ts so a
// missing export can never break this field again. Repairs the common paste
// damage (wrapping quotes/angle brackets, stray newlines/tabs, literal spaces,
// a missing scheme, protocol-relative links) WITHOUT fighting the user mid-type
// (we only mutate whitespace/scheme, never re-encode an already-valid URL).
// ---------------------------------------------------------------------------
function normalizeImageUrl(raw: unknown): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''

  // strip wrapping quotes / angle brackets people accidentally paste
  s = s.replace(/^["'<]+/, '').replace(/["'>]+$/, '').trim()
  if (!s) return ''

  // kill paste line-wraps and tabs; percent-encode any remaining literal spaces
  s = s.replace(/[\r\n\t]+/g, '').replace(/ /g, '%20')

  // protocol-relative -> https
  if (/^\/\//.test(s)) return 'https:' + s

  // already has a scheme (http/https/data/blob) -> leave alone
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s

  // root-relative path from our own uploader (/uploads/...) -> leave alone
  if (s.startsWith('/')) return s

  // bare host (no scheme) -> assume https
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return 'https://' + s

  // garbage -> return trimmed so the load-test can report it
  return s
}

type LoadState = 'idle' | 'ok' | 'error'

export function ImageUploadField({
  label = 'Cover image',
  value,
  onChange,
  hint = 'Upload from your device, or paste a DIRECT image URL (not a webpage).',
  disabled = false,
  aspect = '16 / 9',
  uploadEndpoint,
}: {
  label?: string
  value: string
  onChange: (url: string) => void
  hint?: string
  disabled?: boolean
  aspect?: string
  // optional override; defaults to the auction backend's /upload
  uploadEndpoint?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Local draft so typing isn't mangled by normalization; re-syncs from the
  // `value` prop whenever the parent loads/prefills a lot or sale (this is what
  // stops the "URL vanishes on re-edit" from this side).
  const [draft, setDraft] = useState(value ?? '')
  const [focused, setFocused] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('idle')

  useEffect(() => {
    // external change (upload result, edit prefill, parent reset) -> adopt it
    setDraft(value ?? '')
  }, [value])

  const normalized = useMemo(() => normalizeImageUrl(draft), [draft])

  // reset the load probe whenever the resolved src changes
  useEffect(() => {
    setLoadState('idle')
  }, [normalized])

  const hasImage = !!normalized
  const isRelative = normalized.startsWith('/')
  const isHttp = /^http:\/\//i.test(normalized)
  const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
  const mixedContent = hasImage && !isRelative && isHttp && pageIsHttps

  const commit = () => {
    const next = normalizeImageUrl(draft)
    setDraft(next)
    onChange(next)
    setError('')
  }

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
      const res = await fetch(uploadEndpoint ?? `${API}/upload`, { method: 'POST', body: form })
      const d = await res.json()

      if (d.error) {
        setError(d.error)
      } else if (d.url) {
        const clean = normalizeImageUrl(d.url)
        setDraft(clean)
        onChange(clean)
      } else {
        setError('Upload returned no URL.')
      }
    } catch {
      setError('Could not reach the upload server.')
    } finally {
      setBusy(false)
    }
  }

  function onUrlKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>

      <div className={styles.preview} style={{ aspectRatio: aspect, position: 'relative' }}>
        {hasImage ? (
          <img
            key={normalized}            // force a fresh load-probe when src changes
            src={normalized}
            alt=""
            className={styles.previewImg}
            onLoad={() => setLoadState('ok')}
            onError={() => setLoadState('error')}
          />
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

        {/* Load-test failure overlay — suppressed while typing so an incomplete
            URL mid-entry doesn't scream. Appears after blur/Enter. */}
        {!busy && !focused && hasImage && loadState === 'error' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '0.75rem',
              textAlign: 'center',
              background: 'rgba(20, 18, 15, 0.78)',
              color: '#f6f4ef',
              borderRadius: 12,
              fontSize: '0.78rem',
              lineHeight: 1.35,
            }}
          >
            <AlertTriangle size={18} />
            <span>
              This URL didn’t load as an image. It’s probably a <strong>webpage</strong>, not a
              direct image link.
            </span>
            <a
              href={normalized}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: '#ffd27a',
                textDecoration: 'underline',
                fontSize: '0.76rem',
              }}
            >
              <ExternalLink size={12} />
              Open in a new tab to check
            </a>
            <span style={{ opacity: 0.7, fontSize: '0.72rem' }}>
              Right‑click the real picture → “Copy image address”. Must end in
              .jpg/.png/.webp or come from a CDN that allows embedding.
            </span>
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
              setDraft('')
              onChange('')
              setError('')
              setLoadState('idle')
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
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commit()
          }}
          onKeyDown={onUrlKeyDown}
          placeholder="https://… direct image, or /uploads/…"
          disabled={disabled || busy}
          spellCheck={false}
          inputMode="url"
          autoComplete="off"
        />
      </label>

      {/* live status line under the input */}
      {hasImage && !focused ? (
        <p
          style={{
            margin: '0.35rem 0 0',
            fontSize: '0.74rem',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color:
              loadState === 'ok'
                ? '#14532d'
                : loadState === 'error'
                  ? '#8b1f2f'
                  : 'var(--ink-soft, #666)',
          }}
        >
          {loadState === 'ok' ? '✓ image loads' : null}
          {loadState === 'error' ? '✗ could not load as image' : null}
          {loadState === 'idle' ? 'checking…' : null}
        </p>
      ) : null}

      {mixedContent && loadState !== 'ok' ? (
        <p
          style={{
            margin: '0.35rem 0 0',
            fontSize: '0.74rem',
            color: '#92400e',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <AlertTriangle size={12} />
          This is an <code>http://</code> image on an <code>https://</code> page — the browser will
          block it on deploy. Use an <code>https://</code> URL or upload the file.
        </p>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  )
}

export default ImageUploadField