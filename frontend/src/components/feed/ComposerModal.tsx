import { useState, useRef, type FormEvent } from 'react'
import { X, Image as ImageIcon, Sparkles, Palette } from 'lucide-react'
import { postStory } from '../../lib/feed'
import { API } from '../../lib/sales'
import styles from './ComposerModal.module.css'

type Mode = 'work' | 'status'

export function ComposerModal({
  mode,
  viewer,
  onClose,
  onDone,
}: {
  mode: Mode
  viewer: string
  onClose: () => void
  onDone: () => void
}) {
  // ---- all hooks, top level, above any return ----
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [statusText, setStatusText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(file: File): Promise<string | null> {
    const form = new FormData()
    form.append('file', file)

    try {
      const d = await fetch(`${API}/upload`, { method: 'POST', body: form }).then(r => r.json())
      return d.url ?? null
    } catch {
      return null
    }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return

    setBusy(true)
    setErr('')

    const urls: string[] = []
    for (const f of files) {
      const u = await upload(f)
      if (u) urls.push(u)
    }

    setBusy(false)
    e.target.value = ''

    if (!urls.length) {
      setErr('Upload failed.')
      return
    }

    setImages(prev => [...prev, ...urls].slice(0, 8))
  }

  function removeAt(i: number) {
    setImages(prev => prev.filter((_, k) => k !== i))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')

    if (mode === 'work') {
      if (!title.trim()) {
        setErr('Give the work a title.')
        return
      }

      setBusy(true)

      const d = await fetch(`${API}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewer,
          type: 'work', // always work now
          title: title.trim(),
          description: description.trim(),
          images,
        }),
      })
        .then(r => r.json())
        .catch(() => ({}))

      setBusy(false)

      if (d.error) {
        setErr(d.error)
        return
      }
    } else {
      if (!images.length && !statusText.trim()) {
        setErr('Add a photo or a line of text.')
        return
      }

      setBusy(true)

      const queue: { kind: 'image' | 'text'; body: string }[] = []

      if (statusText.trim()) {
        queue.push({ kind: 'text', body: statusText.trim() })
      }

      for (const img of images) {
        queue.push({ kind: 'image', body: img })
      }

      for (const item of queue) {
        const d = await postStory(viewer, item.kind, item.body)
        if (d.error) {
          setBusy(false)
          setErr(d.error)
          return
        }
      }

      setBusy(false)
    }

    onDone()
  }

  const isWork = mode === 'work'

  const addLabel = busy
    ? 'Uploading…'
    : images.length
      ? 'Add more'
      : isWork
        ? 'Add photos (up to 8)'
        : 'Add photos (optional)'

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={e => e.stopPropagation()}>
        <div className={styles.top}>
          <span className={styles.kicker}>
            {isWork ? (
              <>
                <Palette size={13} /> Hang a work
              </>
            ) : (
              <>
                <Sparkles size={13} /> Post a status
              </>
            )}
          </span>

          <button className={styles.close} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className={styles.form}>
          <div className={styles.thumbGrid}>
            {images.map((u, i) => (
              <div key={u + i} className={styles.thumb}>
                <img src={u} alt="" />
                <button
                  type="button"
                  className={styles.thumbX}
                  onClick={() => removeAt(i)}
                  aria-label="Remove image"
                >
                  <X size={12} />
                </button>
              </div>
            ))}

            {images.length < 8 && (
              <button
                type="button"
                className={styles.addTile}
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                <ImageIcon size={20} />
                <span>{addLabel}</span>
              </button>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className={styles.hidden}
            onChange={pick}
          />

          {isWork ? (
            <>
              <label className={styles.label}>Title</label>
              <input
                className={styles.input}
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Untitled work"
              />

              <label className={styles.label}>Notes</label>
              <textarea
                className={styles.area}
                rows={3}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Medium, dimensions, the story behind it…"
              />
            </>
          ) : (
            <>
              <label className={styles.label}>Caption / text story</label>
              <textarea
                className={styles.area}
                rows={3}
                value={statusText}
                onChange={e => setStatusText(e.target.value)}
                placeholder="What's on the easel today?"
              />
            </>
          )}

          {err && <p className={styles.err}>{err}</p>}

          <button className={styles.submit} type="submit" disabled={busy}>
            {busy ? 'Sending…' : isWork ? 'Hang it' : 'Share status'}
          </button>
        </form>
      </div>
    </div>
  )
}