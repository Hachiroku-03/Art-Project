import { useState, useRef, type FormEvent } from 'react'
import { X, Image as ImageIcon, Gavel, Sparkles } from 'lucide-react'
import { postStory } from '../../lib/feed'
import styles from './ComposerModal.module.css'

const FEED = 'http://localhost:8001'
type Mode = 'work' | 'status'

export function ComposerModal({ mode, viewer, onClose, onDone }: { mode: Mode; viewer: string; onClose: () => void; onDone: () => void }) {
  // ---- hooks top-level ----
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('drop')
  const [price, setPrice] = useState('')
  const [statusText, setStatusText] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(file: File): Promise<string | null> {
    const form = new FormData(); form.append('file', file)
    try { const d = await fetch(`${FEED}/upload`, { method: 'POST', body: form }).then(r => r.json()); return d.url ?? null } catch { return null }
  }
  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    setBusy(true); setErr('')
    upload(f).then(u => { if (u) setImageUrl(u); else setErr('Upload failed.'); setBusy(false) })
    e.target.value = ''
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('')
    if (mode === 'work') {
      if (!title.trim()) { setErr('Give the work a title.'); return }
      setBusy(true)
      const d = await fetch(`${FEED}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, type, title: title.trim(), description: description.trim(), image_url: imageUrl, price: price.trim() }) }).then(r => r.json()).catch(() => ({}))
      setBusy(false)
      if (d.error) { setErr(d.error); return }
    } else {
      if (!imageUrl && !statusText.trim()) { setErr('Add a photo or a line of text.'); return }
      setBusy(true)
      const d = await postStory(viewer, imageUrl ? 'image' : 'text', imageUrl || statusText.trim())
      setBusy(false)
      if (d.error) { setErr(d.error); return }
    }
    onDone()
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={e => e.stopPropagation()}>
        <div className={styles.top}>
          <span className={styles.kicker}>{mode === 'work' ? <><Gavel size={13} /> Hang a work</> : <><Sparkles size={13} /> Post a status</>}</span>
          <button className={styles.close} onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <form onSubmit={submit} className={styles.form}>
          {mode === 'work' ? (
            <>
              <div className={styles.dropZone} onClick={() => fileRef.current?.click()}>
                {imageUrl ? <img src={imageUrl} alt="" className={styles.preview} />
                  : <span className={styles.dropHint}><ImageIcon size={20} /> {busy ? 'Uploading…' : 'Add an image (optional)'}</span>}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className={styles.hidden} onChange={pick} />
              <label className={styles.label}>Title</label>
              <input className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Untitled work" />
              <label className={styles.label}>Notes</label>
              <textarea className={styles.area} rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Medium, dimensions, the story behind it…" />
              <div className={styles.row}>
                <div className={styles.col}>
                  <label className={styles.label}>Kind</label>
                  <select className={styles.input} value={type} onChange={e => setType(e.target.value)}>
                    <option value="drop">Drop — open for bids</option>
                    <option value="studio">Studio — process</option>
                  </select>
                </div>
                <div className={styles.col}>
                  <label className={styles.label}>Price <span className={styles.opt}>optional</span></label>
                  <input className={styles.input} value={price} onChange={e => setPrice(e.target.value)} placeholder="0" />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={styles.dropZone} onClick={() => fileRef.current?.click()}>
                {imageUrl ? <img src={imageUrl} alt="" className={styles.preview} />
                  : <span className={styles.dropHint}><ImageIcon size={20} /> {busy ? 'Uploading…' : 'Add a photo (or type below)'}</span>}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className={styles.hidden} onChange={pick} />
              <textarea className={styles.area} rows={2} value={statusText} onChange={e => setStatusText(e.target.value)} placeholder="What's on the easel today?" />
            </>
          )}

          {err && <p className={styles.err}>{err}</p>}
          <button className={styles.submit} type="submit" disabled={busy}>{busy ? 'Sending…' : mode === 'work' ? 'Hang it' : 'Share status'}</button>
        </form>
      </div>
    </div>
  )
}