import { useEffect, useState } from 'react'
import { enterSale } from '../../lib/sales'
import styles from './sales.module.css'

export function EnterRoomModal({
  open,
  saleId,
  viewer,
  initialCode = '',
  onClose,
  onEntered,
}: {
  open: boolean
  saleId: number
  viewer: string
  initialCode?: string
  onClose: () => void
  onEntered: () => void
}) {
  const [code, setCode] = useState(initialCode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setCode(initialCode)
      setError('')
    }
  }, [open, initialCode])

  if (!open) return null

  const submit = async () => {
    const trimmed = code.trim()

    if (!trimmed) {
      setError('Enter your paddle code.')
      return
    }

    setBusy(true)
    setError('')

    const d = await enterSale(saleId, viewer, trimmed)

    setBusy(false)

    if (d.error) {
      setError(d.error)
      return
    }

    if (d.ok) {
      setCode('')
      onEntered()
    }
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div className={styles.modal} onMouseDown={e => e.stopPropagation()}>
        <h3 className={styles.panelTitle}>Enter with paddle code</h3>

        <p className={styles.muted}>
          Use this only if you are on a new device. Your account paddle normally enters automatically.
        </p>

        <input
          className={styles.input}
          value={code}
          onChange={e => setCode(e.target.value)}
          placeholder="123456"
          maxLength={12}
        />

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.row}>
          <button className={styles.button} onClick={submit} disabled={busy}>
            {busy ? 'Checking…' : 'Enter room'}
          </button>

          <button
            className={`${styles.button} ${styles.secondary}`}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}