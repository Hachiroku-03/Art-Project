import { useState, useRef, type ChangeEvent, type FormEvent } from 'react'
import { Zap, Paintbrush, Gavel, Image as ImageIcon, X } from 'lucide-react'
import styles from './Composer.module.css'

const FEED_API = 'http://localhost:8001'

const TYPES = [
  { key: 'drop', label: 'Drop', icon: Zap },
  { key: 'studio', label: 'Studio', icon: Paintbrush },
  { key: 'hammer', label: 'Hammer', icon: Gavel },
] as const

type ComposerProps = {
  viewer: string
  onPosted: () => void
}

export function Composer({ viewer, onPosted }: ComposerProps) {
  const [expanded, setExpanded] = useState(false)
  const [type, setType] = useState<'drop' | 'studio' | 'hammer'>('drop')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`${FEED_API}/upload`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.url) setImageUrl(data.url)
      else setError(data.error || 'Upload failed.')
    } catch {
      setError('Upload failed - is the feed server running?')
    }
    setUploading(false)
    e.target.value = ''
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) { setError('Every piece needs a title.'); return }
    setPosting(true)
    setError('')
    try {
      const res = await fetch(`${FEED_API}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewer,
          type,
          title: title.trim(),
          description: description.trim(),
          image_url: imageUrl,
          price: price.trim(),
        }),
      })
      const data = await res.json()
      if (data.id) {
        // Reset form
        setTitle('')
        setDescription('')
        setPrice('')
        setImageUrl('')
        setExpanded(false)
        onPosted()
      } else {
        setError(data.error || 'Could not hang the piece.')
      }
    } catch {
      setError('Network error - could not reach the feed server.')
    }
    setPosting(false)
  }

  if (!expanded) {
    return (
      <button className={styles.trigger} onClick={() => setExpanded(true)}>
        <ImageIcon size={16} />
        <span>Hang something on the wall…</span>
      </button>
    )
  }

  return (
    <form className={styles.composer} onSubmit={submit}>
      <div className={styles.typeRow}>
        {TYPES.map(t => {
          const Icon = t.icon
          return (
            <button
              key={t.key}
              type="button"
              className={`${styles.typeBtn} ${type === t.key ? styles.typeActive : ''}`}
              onClick={() => setType(t.key)}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      {imageUrl ? (
        <div className={styles.previewWrap}>
          <img src={imageUrl} alt="preview" className={styles.preview} />
          <button
            type="button"
            className={styles.removeBtn}
            onClick={() => setImageUrl('')}
            aria-label="Remove image"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button type="button" className={styles.dropzone} onClick={() => fileRef.current?.click()}>
          <ImageIcon size={20} />
          <span>{uploading ? 'Uploading…' : 'Add artwork image'}</span>
        </button>
      )}
      <input ref={fileRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={handleFile} />

      <input
        className={styles.input}
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Title"
        maxLength={80}
      />

      <textarea
        className={styles.textarea}
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="The story / medium…"
        maxLength={500}
        rows={3}
      />

      {type !== 'studio' && (
        <input
          className={styles.input}
          value={price}
          onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={type === 'drop' ? 'Asking price (USD)' : 'Final hammer price (USD)'}
          inputMode="decimal"
        />
      )}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <button type="button" className={styles.cancelBtn} onClick={() => setExpanded(false)}>
          Cancel
        </button>
        <button className={styles.submitBtn} type="submit" disabled={posting || uploading}>
          {posting ? 'Hanging…' : 'Hang it'}
        </button>
      </div>
    </form>
  )
}