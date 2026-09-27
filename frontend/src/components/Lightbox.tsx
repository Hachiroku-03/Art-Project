import { useState, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import styles from './Lightbox.module.css'

// Fullscreen image viewer. Single src (profile preview) or a navigable array (room gallery).
export function Lightbox({ items, index, onClose, onIndex }: {
  items: string[]; index: number; onClose: () => void; onIndex?: (i: number) => void
}) {
  // ---- hooks top-level, no early return before them ----
  const [i, setI] = useState(index)
  const multi = items.length > 1

  useEffect(() => { setI(index) }, [index])   // sync when parent re-opens at a different spot

  function go(n: number) {
    const c = Math.max(0, Math.min(items.length - 1, n))
    setI(c); onIndex?.(c)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && multi) go(i + 1)
      else if (e.key === 'ArrowLeft' && multi) go(i - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)   // Strict-Mode safe: always removed
  }, [i, multi, onClose])   // eslint-disable-line react-hooks/exhaustive-deps (go is local)

  if (!items[i]) return null

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.frame} onClick={e => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close"><X size={22} /></button>
        <img src={items[i]} alt="" className={styles.img} />
        {multi && (
          <>
            <button className={`${styles.nav} ${styles.navL}`} onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous"><ChevronLeft size={28} /></button>
            <button className={`${styles.nav} ${styles.navR}`} onClick={() => go(i + 1)} disabled={i === items.length - 1} aria-label="Next"><ChevronRight size={28} /></button>
            <span className={styles.count}>{i + 1} / {items.length}</span>
          </>
        )}
      </div>
    </div>
  )
}