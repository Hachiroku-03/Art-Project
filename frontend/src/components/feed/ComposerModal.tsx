import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  X,
  Image as ImageIcon,
  Sparkles,
  Palette,
  RotateCw,
  RotateCcw,
  FlipHorizontal,
  FlipVertical,
  SlidersHorizontal,
  Eraser,
  Check,
} from 'lucide-react'
import { postStory } from '../../lib/feed'
import { API } from '../../lib/sales'
import styles from './ComposerModal.module.css'

type Mode = 'work' | 'status'

type ImageEdits = {
  rotation: number
  flipH: boolean
  flipV: boolean
  brightness: number
  contrast: number
  saturation: number
}

type DraftImage = {
  id: string
  file: File
  originalUrl: string
  previewUrl: string
  editedBlob?: Blob
  edits: ImageEdits
  caption: string
}

const DEFAULT_EDITS: ImageEdits = {
  rotation: 0,
  flipH: false,
  flipV: false,
  brightness: 100,
  contrast: 100,
  saturation: 100,
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360
}

function getOrientedSize(img: HTMLImageElement, edits: ImageEdits) {
  const rot = normalizeRotation(edits.rotation)
  const swapped = rot === 90 || rot === 270

  return {
    w: swapped ? img.naturalHeight : img.naturalWidth,
    h: swapped ? img.naturalWidth : img.naturalHeight,
  }
}

function drawImageToCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  edits: ImageEdits,
  targetW: number,
  targetH: number,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const oriented = getOrientedSize(img, edits)
  const scale = Math.min(targetW / oriented.w, targetH / oriented.h)

  canvas.width = Math.max(1, Math.round(oriented.w * scale))
  canvas.height = Math.max(1, Math.round(oriented.h * scale))

  ctx.save()
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // White background for JPEG exports.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ;(ctx as any).filter = `brightness(${edits.brightness}%) contrast(${edits.contrast}%) saturate(${edits.saturation}%)`

  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((normalizeRotation(edits.rotation) * Math.PI) / 180)
  ctx.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1)

  const drawW = img.naturalWidth * scale
  const drawH = img.naturalHeight * scale

  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (blob) resolve(blob)
        else reject(new Error('Could not export image'))
      },
      type,
      quality,
    )
  })
}

function ImageEditorModal({
  file,
  originalUrl,
  initialEdits,
  onCancel,
  onApply,
}: {
  file: File
  originalUrl: string
  initialEdits: ImageEdits
  onCancel: () => void
  onApply: (blob: Blob, edits: ImageEdits) => void
}) {
  const [edits, setEdits] = useState<ImageEdits>(initialEdits)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const img = new Image()

    img.onload = () => {
      imgRef.current = img
      setReady(true)
    }

    img.onerror = () => {
      setErr('Could not load image for editing.')
    }

    img.src = originalUrl

    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [originalUrl])

  useEffect(() => {
    if (!ready) return

    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas) return

    const oriented = getOrientedSize(img, edits)
    const maxPreview = 900
    const targetW = Math.min(oriented.w, maxPreview)
    const targetH = Math.min(oriented.h, maxPreview)

    drawImageToCanvas(canvas, img, edits, targetW, targetH)
  }, [ready, edits])

  function update<K extends keyof ImageEdits>(key: K, value: ImageEdits[K]) {
    setEdits(prev => ({ ...prev, [key]: value }))
  }

  function rotate(dir: 1 | -1) {
    setEdits(prev => ({
      ...prev,
      rotation: normalizeRotation(prev.rotation + dir * 90),
    }))
  }

  async function apply() {
    const img = imgRef.current
    if (!img) {
      setErr('Image is not ready yet.')
      return
    }

    setBusy(true)
    setErr('')

    try {
      const oriented = getOrientedSize(img, edits)
      const offscreen = document.createElement('canvas')

      drawImageToCanvas(offscreen, img, edits, oriented.w, oriented.h)

      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const blob = await canvasToBlob(offscreen, type, 0.92)

      onApply(blob, edits)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not apply edits.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={styles.editorOverlay}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className={styles.editorSheet}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.editorHead}>
          <span className={styles.editorTitle}>
            <SlidersHorizontal size={15} />
            Edit image
          </span>

          <button className={styles.close} onClick={onCancel} aria-label="Close editor">
            <X size={18} />
          </button>
        </div>

        {err ? <p className={styles.err}>{err}</p> : null}

        <div className={styles.canvasWrap}>
          {!ready ? <p className={styles.muted}>Loading image…</p> : null}
          <canvas ref={canvasRef} className={styles.editorCanvas} />
        </div>

        <div className={styles.editorControls}>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.toolBtn} onClick={() => rotate(-1)}>
              <RotateCcw size={16} />
              Left
            </button>

            <button type="button" className={styles.toolBtn} onClick={() => rotate(1)}>
              <RotateCw size={16} />
              Right
            </button>

            <button
              type="button"
              className={`${styles.toolBtn} ${edits.flipH ? styles.toolBtnOn : ''}`}
              onClick={() => update('flipH', !edits.flipH)}
            >
              <FlipHorizontal size={16} />
              Flip H
            </button>

            <button
              type="button"
              className={`${styles.toolBtn} ${edits.flipV ? styles.toolBtnOn : ''}`}
              onClick={() => update('flipV', !edits.flipV)}
            >
              <FlipVertical size={16} />
              Flip V
            </button>
          </div>

          <label className={styles.sliderLabel}>
            Brightness {edits.brightness}%
            <input
              className={styles.slider}
              type="range"
              min={50}
              max={150}
              value={edits.brightness}
              onChange={e => update('brightness', Number(e.target.value))}
            />
          </label>

          <label className={styles.sliderLabel}>
            Contrast {edits.contrast}%
            <input
              className={styles.slider}
              type="range"
              min={50}
              max={150}
              value={edits.contrast}
              onChange={e => update('contrast', Number(e.target.value))}
            />
          </label>

          <label className={styles.sliderLabel}>
            Saturation {edits.saturation}%
            <input
              className={styles.slider}
              type="range"
              min={0}
              max={200}
              value={edits.saturation}
              onChange={e => update('saturation', Number(e.target.value))}
            />
          </label>

          <button
            type="button"
            className={styles.secondaryToolBtn}
            onClick={() => setEdits(DEFAULT_EDITS)}
          >
            <Eraser size={15} />
            Reset edits
          </button>
        </div>

        <div className={styles.editorActions}>
          <button type="button" className={styles.submit} onClick={() => void apply()} disabled={busy || !ready}>
            {busy ? 'Applying…' : (<><Check size={15} /> Apply edits</>)}
          </button>

          <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function ComposerModal({
  mode,
  viewer,
  hasExistingStory = false,
  onClose,
  onDone,
}: {
  mode: Mode
  viewer: string
  hasExistingStory?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [statusText, setStatusText] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)
  const imagesRef = useRef<DraftImage[]>([])

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) {
        URL.revokeObjectURL(img.originalUrl)
        if (img.previewUrl !== img.originalUrl) {
          URL.revokeObjectURL(img.previewUrl)
        }
      }
    }
  }, [])

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

    setErr('')

    const drafts: DraftImage[] = files.map(file => {
      const url = URL.createObjectURL(file)

      return {
        id: newId(),
        file,
        originalUrl: url,
        previewUrl: url,
        edits: DEFAULT_EDITS,
        caption: '',
      }
    })

    setImages(prev => [...prev, ...drafts].slice(0, 8))
    e.target.value = ''
  }

  function removeAt(i: number) {
    setImages(prev => {
      const target = prev[i]

      if (target) {
        URL.revokeObjectURL(target.originalUrl)
        if (target.previewUrl !== target.originalUrl) {
          URL.revokeObjectURL(target.previewUrl)
        }
      }

      return prev.filter((_, k) => k !== i)
    })
  }

  function setCaption(i: number, value: string) {
    setImages(prev => prev.map((img, k) => (k === i ? { ...img, caption: value } : img)))
  }

  function applyEdit(index: number, blob: Blob, edits: ImageEdits) {
    setImages(prev =>
      prev.map((img, i) => {
        if (i !== index) return img

        if (img.previewUrl !== img.originalUrl) {
          URL.revokeObjectURL(img.previewUrl)
        }

        return {
          ...img,
          editedBlob: blob,
          previewUrl: URL.createObjectURL(blob),
          edits,
        }
      }),
    )

    setEditingIndex(null)
  }

  function resetEdit(index: number) {
    setImages(prev =>
      prev.map((img, i) => {
        if (i !== index) return img

        if (img.previewUrl !== img.originalUrl) {
          URL.revokeObjectURL(img.previewUrl)
        }

        return {
          ...img,
          editedBlob: undefined,
          previewUrl: img.originalUrl,
          edits: DEFAULT_EDITS,
        }
      }),
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')

    if (!viewer) {
      setErr('No signed-in user detected. Log out and log back in.')
      return
    }

    if (mode === 'work') {
      if (!title.trim()) {
        setErr('Give the work a title.')
        return
      }

      setBusy(true)

      try {
        const uploadedUrls: string[] = []

        for (const img of images) {
          const fileToUpload = img.editedBlob
            ? new File([img.editedBlob], `edited-${img.id}.jpg`, {
                type: img.editedBlob.type || 'image/jpeg',
              })
            : img.file

          const url = await upload(fileToUpload)
          if (!url) {
            setErr('Image upload failed.')
            setBusy(false)
            return
          }

          uploadedUrls.push(url)
        }

        const d = await fetch(`${API}/posts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            viewer,
            type: 'work',
            title: title.trim(),
            description: description.trim(),
            images: uploadedUrls,
          }),
        })
          .then(r => r.json())
          .catch(() => ({}))

        if (d.error) {
          setErr(d.error)
          setBusy(false)
          return
        }
      } catch {
        setErr('Could not post work.')
        setBusy(false)
        return
      }

      setBusy(false)
      onDone()
      return
    }

    const hasImages = images.length > 0

    if (!hasImages && !statusText.trim()) {
      setErr('Add a photo or a line of text.')
      return
    }

    setBusy(true)

    try {
      const sharedCaption = statusText.trim()

      if (hasImages) {
        for (const img of images) {
          const fileToUpload = img.editedBlob
            ? new File([img.editedBlob], `story-${img.id}.jpg`, {
                type: img.editedBlob.type || 'image/jpeg',
              })
            : img.file

          const url = await upload(fileToUpload)

          if (!url) {
            setErr('Image upload failed.')
            setBusy(false)
            return
          }

          const caption = img.caption.trim() || sharedCaption
          const body = caption ? JSON.stringify({ url, caption }) : url

          const d = await postStory(viewer, 'image', body)

          if (d.error) {
            setErr(d.error)
            setBusy(false)
            return
          }
        }
      } else {
        const d = await postStory(viewer, 'text', statusText.trim())

        if (d.error) {
          setErr(d.error)
          setBusy(false)
          return
        }
      }
    } catch {
      setErr('Could not post story.')
      setBusy(false)
      return
    }

    setBusy(false)
    onDone()
  }

  const isWork = mode === 'work'
  const hasImages = images.length > 0

  const addLabel = busy
    ? 'Working…'
    : hasImages
      ? 'Add more'
      : isWork
        ? 'Add photos (up to 8)'
        : 'Add photos'

  return (
    <div
      className={styles.overlay}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.sheet} onClick={e => e.stopPropagation()}>
        <div className={styles.top}>
          <span className={styles.kicker}>
            {isWork ? (
              <>
                <Palette size={13} /> Hang a work
              </>
            ) : (
              <>
                <Sparkles size={13} /> {hasExistingStory ? 'Add to story' : 'Post a status'}
              </>
            )}
          </span>

          <button className={styles.close} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className={styles.form}>
          {!isWork && hasExistingStory ? (
            <p className={styles.hint}>
              This will be added to your active story. Existing story items stay where they are.
            </p>
          ) : null}

          <div className={styles.thumbGrid}>
            {images.map((img, i) => (
              <div key={img.id} className={styles.thumb}>
                <img src={img.previewUrl} alt="" />

                <button
                  type="button"
                  className={styles.thumbEdit}
                  onClick={() => setEditingIndex(i)}
                  aria-label="Edit image"
                >
                  <SlidersHorizontal size={12} />
                  Edit
                </button>

                <button
                  type="button"
                  className={styles.thumbX}
                  onClick={() => removeAt(i)}
                  aria-label="Remove image"
                >
                  <X size={12} />
                </button>

                {img.editedBlob ? <span className={styles.editedBadge}>Edited</span> : null}
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
              {hasImages ? (
                <>
                  <div className={styles.captionList}>
                    {images.map((img, i) => (
                      <label key={img.id} className={styles.captionItem}>
                        <span className={styles.label}>Caption for photo {i + 1}</span>
                        <input
                          className={styles.captionInput}
                          value={img.caption}
                          onChange={e => setCaption(i, e.target.value)}
                          placeholder="Optional caption for this story item"
                          maxLength={240}
                        />
                      </label>
                    ))}
                  </div>

                  <label className={styles.label}>Shared caption (optional)</label>
                  <textarea
                    className={styles.area}
                    rows={2}
                    value={statusText}
                    onChange={e => setStatusText(e.target.value)}
                    placeholder="Applies to photos without their own caption…"
                  />
                </>
              ) : (
                <>
                  <label className={styles.label}>Text story</label>
                  <textarea
                    className={styles.area}
                    rows={3}
                    value={statusText}
                    onChange={e => setStatusText(e.target.value)}
                    placeholder="What's on the easel today?"
                  />
                </>
              )}
            </>
          )}

          {err && <p className={styles.err}>{err}</p>}

          <button className={styles.submit} type="submit" disabled={busy}>
            {busy
              ? 'Sending…'
              : isWork
                ? 'Hang it'
                : hasExistingStory
                  ? 'Add to story'
                  : 'Share status'}
          </button>
        </form>
      </div>

      {editingIndex !== null && images[editingIndex] ? (
        <ImageEditorModal
          file={images[editingIndex].file}
          originalUrl={images[editingIndex].originalUrl}
          initialEdits={images[editingIndex].edits}
          onCancel={() => setEditingIndex(null)}
          onApply={(blob, edits) => applyEdit(editingIndex, blob, edits)}
        />
      ) : null}
    </div>
  )
}