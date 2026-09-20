import { useState, useRef, type ChangeEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Paintbrush, Gavel, Image as ImageIcon, X, ArrowLeft } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import styles from './CreatePage.module.css'

const FEED_API = 'http://localhost:8001'

const TYPES = [
  { key: 'drop', label: 'Drop', icon: Zap, blurb: 'New work, open for bids' },
  { key: 'studio', label: 'Studio', icon: Paintbrush, blurb: 'Process & behind the scenes' },
  { key: 'hammer', label: 'Hammer', icon: Gavel, blurb: 'Sold & announcements' },
] as const

export function CreatePage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''
  const role = localStorage.getItem('space_role') || 'collector'

  const [type, setType] = useState<'drop' | 'studio' | 'hammer'>('drop')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Collectors collect — the wall belongs to artists and houses
  if (role === 'collector') {
    return (
      <main className={styles.layout}>
        <Navbar />
        <div className={styles.gateCard}>
          <p className={styles.gateText}>Collectors collect. The wall belongs to artists and houses.</p>
          <button className={styles.gateBtn} onClick={() => navigate('/feed')}>Back to the feed</button>
        </div>
      </main>
    )
  }

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
      if (data.id) navigate(`/post/${data.id}`)
      else setError(data.error || 'Could not hang the piece.')
    } catch {
      setError('Network error - could not reach the feed server.')
    }
    setPosting(false)
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.sheet}>
        <header className={styles.head}>
          <button type="button" className={styles.iconBtn} onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
          <h1 className={styles.heading}>Hang something on the wall</h1>
        </header>

        <form onSubmit={submit} className={styles.form}>
          <p className={styles.label}>What kind of piece?</p>
          <div className={styles.typeRow}>
            {TYPES.map(t => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`${styles.typeTile} ${type === t.key ? styles.typeActive : ''}`}
                  onClick={() => setType(t.key)}
                >
                  <Icon size={18} />
                  <span className={styles.typeLabel}>{t.label}</span>
                  <span className={styles.typeBlurb}>{t.blurb}</span>
                </button>
              )
            })}
          </div>

          <p className={styles.label}>The artwork</p>
          <button type="button" className={styles.dropzone} onClick={() => fileRef.current?.click()}>
            {imageUrl ? (
              <img src={imageUrl} alt="preview" className={styles.preview} />
            ) : (
              <span className={styles.dzInner}>
                <ImageIcon size={22} />
                {uploading ? 'Uploading…' : 'Tap to add a picture of the piece'}
              </span>
            )}
            {imageUrl && (
              <span
                className={styles.removeBtn}
                onClick={ev => { ev.stopPropagation(); setImageUrl('') }}
                aria-label="Remove image"
              >
                <X size={14} />
              </span>
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={handleFile} />

          <p className={styles.label}>Title</p>
          <input
            className={styles.input}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Midnight in Obsidian"
            maxLength={80}
          />

          <p className={styles.label}>The story / medium</p>
          <textarea
            className={styles.textarea}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Materials, meaning, the forty hours it took…"
            maxLength={500}
            rows={4}
          />

          {type !== 'studio' && (
            <>
              <p className={styles.label}>{type === 'drop' ? 'Asking price (USD)' : 'Final hammer price (USD)'}</p>
              <input
                className={styles.input}
                value={price}
                onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 4500"
                inputMode="decimal"
              />
            </>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <button className={styles.submitBtn} type="submit" disabled={posting || uploading}>
            {posting ? 'Hanging…' : 'Hang it on the wall'}
          </button>
        </form>
      </div>
    </main>
  )
}